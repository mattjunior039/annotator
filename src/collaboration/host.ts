import type { AnnotationDocument } from '../domain/model';
import type { Command } from '../domain/history';
import type { MaskTile } from '../domain/masks';
import type { DatasetSchema } from '../domain/dataset-schema';
import type { StorageClient } from '../workers/client';
import { maskReadSchema, thumbnailSchema, workspaceListSchema, workspaceReadSchema, workspaceWriteSchema } from '../workers/protocol';
import { createIdentity, deriveSession, isSignalFrame, openSignal, sealSignal, signalKey } from './crypto';
import type { Identity } from './crypto';
import { fromBase64Url, toBase64Url } from './encoding';
import { createInvite, inviteUrl } from './invite';
import type { Invite } from './invite';
import { iceServers, SecureLink } from './link';
import type { ConnectionMode } from './link';
import { applyGuestCommands, diffDocuments } from './merge';
import { guestHelloSchema, guestMessageSchema } from './protocol';
import type { GuestRequest, Participant } from './protocol';
import { SignalingClient } from './signaling';

export const participantColors = ['#b84d3b', '#416f9f', '#a56c19', '#8056a1', '#278c8a', '#9a3f74', '#5d7a1f'];
const HOST_COLOR = '#39764d';
const MAX_REQUESTS_PER_GUEST = 4;

export interface PendingGuest { id: string; name: string; code: string }
interface Guest extends PendingGuest {
  status: 'pending' | 'connected';
  link: SecureLink;
  imageId: string | null;
  color: string;
  direct: boolean;
  inflight: number;
}
export interface HostOptions {
  workspaceName: string;
  storage: StorageClient;
  schema: () => DatasetSchema | null;
  mode: ConnectionMode;
  onChange: () => void;
  onDocument: (document: AnnotationDocument) => void;
  onEnded: (reason: string) => void;
}

export class LiveHost {
  private readonly guests = new Map<string, Guest>();
  private readonly refused = new Set<string>();
  private readonly documents = new Map<string, AnnotationDocument>();
  private hostImage: string | null = null;
  private commitTail: Promise<unknown> = Promise.resolve();
  private ended = false;

  private constructor(
    private readonly options: HostOptions,
    readonly invite: Invite,
    private readonly signaling: SignalingClient,
    private readonly identity: Identity,
    private readonly handshakeKey: CryptoKey,
  ) {
    signaling.onFrame = (from, frame) => { void this.receive(from, frame); };
    signaling.onPeer = (id, event) => { if (event === 'leave') this.drop(id); };
    signaling.onClosed = reason => this.finish(reason);
  }

  static async start(options: HostOptions): Promise<LiveHost> {
    const invite = createInvite();
    const [identity, key] = await Promise.all([createIdentity(), signalKey(invite)]);
    const signaling = await SignalingClient.connect(invite.roomId, 'host');
    return new LiveHost(options, invite, signaling, identity, key);
  }

  get url(): string { return inviteUrl(this.invite, window.location); }
  get mode(): ConnectionMode { return this.options.mode; }
  get pending(): PendingGuest[] {
    return [...this.guests.values()].filter(guest => guest.status === 'pending').map(({ id, name, code }) => ({ id, name, code }));
  }
  get participants(): (Participant & { direct: boolean })[] {
    return [
      { id: this.signaling.id, name: 'Host', host: true, imageId: this.hostImage, color: HOST_COLOR, direct: false },
      ...[...this.guests.values()].filter(guest => guest.status === 'connected').map(guest => ({
        id: guest.id, name: guest.name, host: false, imageId: guest.imageId, color: guest.color, direct: guest.direct,
      })),
    ];
  }

  approve(id: string): void {
    const guest = this.guests.get(id), schema = this.options.schema();
    if (!guest || guest.status !== 'pending' || !schema) return;
    guest.status = 'connected';
    void guest.link.send({ t: 'ready', you: guest.id, workspaceName: this.options.workspaceName, schema }).catch(() => this.drop(id));
    if (this.options.mode === 'direct') void guest.link.startDirect(iceServers()).catch(() => {});
    this.broadcastPresence();
  }

  decline(id: string, reason = 'The host declined your request to join.'): void {
    const guest = this.guests.get(id);
    if (!guest) return;
    this.refused.add(id);
    void guest.link.send({ t: 'end', reason }).catch(() => {}).finally(() => guest.link.close());
    this.guests.delete(id);
    this.broadcastPresence();
  }

  publishDocument(document: AnnotationDocument): void {
    this.documents.set(document.image.id, document);
    this.broadcast({ t: 'document', document });
  }
  publishSchema(schema: DatasetSchema): void { this.documents.clear(); this.broadcast({ t: 'schema', schema }); }
  publishIndex(): void { this.documents.clear(); this.broadcast({ t: 'index' }); }
  setViewing(imageId: string | null): void {
    if (this.hostImage === imageId) return;
    this.hostImage = imageId;
    this.broadcastPresence();
  }

  stop(reason = 'The host ended the live session.'): void {
    if (this.ended) return;
    const links = [...this.guests.values()].map(guest => guest.link);
    Promise.allSettled(links.map(link => link.send({ t: 'end', reason }))).finally(() => {
      for (const link of links) link.close();
      this.signaling.close();
    });
    this.finish(reason);
  }

  private finish(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    for (const guest of this.guests.values()) guest.link.close();
    this.guests.clear();
    this.documents.clear();
    this.options.onEnded(reason);
  }

  private async receive(from: string, frame: Uint8Array<ArrayBuffer>): Promise<void> {
    if (this.ended || this.refused.has(from)) return;
    const guest = this.guests.get(from);
    if (!isSignalFrame(frame)) { guest?.link.receive(frame); return; }
    if (guest) return;
    try {
      const hello = guestHelloSchema.parse(await openSignal(this.handshakeKey, frame));
      const session = await deriveSession(this.identity, fromBase64Url(hello.key), this.invite, 'host');
      if (this.ended || this.guests.has(from)) return;
      const link = new SecureLink(this.signaling, from, session.cipher);
      const used = new Set([...this.guests.values()].map(item => item.color));
      const entry: Guest = {
        id: from, name: hello.name, code: session.code, status: 'pending', link, imageId: null,
        color: participantColors.find(color => !used.has(color)) ?? participantColors[0]!, direct: false, inflight: 0,
      };
      link.onMessage = message => this.onGuestMessage(entry, message);
      link.onFailure = () => this.decline(from, 'The live-session connection failed verification.');
      link.onDirect = open => { entry.direct = open; this.options.onChange(); };
      this.guests.set(from, entry);
      await this.signaling.send(from, await sealSignal(this.handshakeKey, { t: 'hello', key: toBase64Url(this.identity.publicKey) }));
      this.options.onChange();
    } catch {
      this.refused.add(from);
    }
  }

  private onGuestMessage(guest: Guest, raw: unknown): void {
    if (guest.status !== 'connected' || !this.guests.has(guest.id)) return;
    const parsed = guestMessageSchema.safeParse(raw);
    if (!parsed.success) { this.decline(guest.id, 'Your app sent an invalid live-session message.'); return; }
    const message = parsed.data;
    if (message.t === 'viewing') {
      guest.imageId = message.imageId;
      this.broadcastPresence();
    } else if (message.t === 'rtc') {
      void guest.link.handleRtc(message, iceServers()).catch(() => {});
    } else {
      if (guest.inflight >= MAX_REQUESTS_PER_GUEST) {
        void guest.link.send({ t: 'reply', id: message.id, ok: false, error: 'Too many requests in flight.' }).catch(() => {});
        return;
      }
      guest.inflight++;
      this.handle(message.payload)
        .then(value => guest.link.send({ t: 'reply', id: message.id, ok: true, value }))
        .catch(failure => guest.link.send({
          t: 'reply', id: message.id, ok: false,
          error: (failure instanceof Error ? failure.message : 'The host could not complete the request.').slice(0, 1024),
        }))
        .catch(() => {})
        .finally(() => { guest.inflight--; });
    }
  }

  // The host's own edit, merged with any concurrent guest edits. Returns the saved document.
  commitLocal(before: AnnotationDocument, next: AnnotationDocument, tiles: MaskTile[]): Promise<AnnotationDocument> {
    const commands = diffDocuments(before, next);
    if (commands.length === 0) return Promise.resolve(before);
    return this.commit(next.image.id, commands, tiles, true).then(result => result.document);
  }

  private async handle(request: GuestRequest): Promise<unknown> {
    const storage = this.options.storage;
    switch (request.type) {
      case 'workspace-list': return storage.request(request, workspaceListSchema);
      case 'workspace-thumbnail': return storage.request(request, thumbnailSchema);
      case 'workspace-mask-read': return storage.request(request, maskReadSchema);
      case 'workspace-read': {
        const result = await storage.request(request, workspaceReadSchema);
        this.documents.set(result.document.image.id, result.document);
        return result;
      }
      case 'live-edit': {
        const result = await this.commit(request.id, request.commands, [], false);
        if (result.changed) this.options.onDocument(result.document);
        return { id: request.id, revision: result.document.revision };
      }
    }
  }

  // Replays commands onto the newest saved document. Commits are serialized; a
  // write that still loses a race (e.g. a schema migration) is retried on a fresh read.
  private commit(id: string, commands: Command[], tiles: MaskTile[], host: boolean) {
    const run = this.commitTail.then(async () => {
      const storage = this.options.storage;
      for (let attempt = 0; ; attempt++) {
        const latest = this.documents.get(id) ?? (await storage.request({ type: 'workspace-read', id }, workspaceReadSchema)).document;
        const next = applyGuestCommands(latest, commands, host);
        if (next === latest) return { document: latest, changed: false };
        try {
          await storage.request({ type: 'workspace-update', id, expectedRevision: latest.revision, document: next, tiles }, workspaceWriteSchema);
          this.documents.set(id, next);
          this.broadcast({ t: 'document', document: next });
          return { document: next, changed: true };
        } catch (failure) {
          this.documents.delete(id);
          if (attempt >= 1) throw failure;
        }
      }
    });
    this.commitTail = run.catch(() => {});
    return run;
  }

  private broadcast(message: unknown): void {
    for (const guest of this.guests.values()) {
      if (guest.status === 'connected') void guest.link.send(message).catch(() => this.drop(guest.id));
    }
  }

  private broadcastPresence(): void {
    const participants = this.participants.map(({ direct: _direct, ...participant }) => participant);
    this.broadcast({ t: 'presence', participants });
    this.options.onChange();
  }

  private drop(id: string): void {
    const guest = this.guests.get(id);
    if (!guest) return;
    guest.link.close();
    this.guests.delete(id);
    this.broadcastPresence();
  }
}
