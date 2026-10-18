import type { z } from 'zod';
import { documentSchema } from '../domain/model';
import type { AnnotationDocument } from '../domain/model';
import type { DatasetSchema } from '../domain/dataset-schema';
import type { StorageClient } from '../workers/client';
import { createIdentity, deriveSession, isSignalFrame, openSignal, sealSignal, signalKey } from './crypto';
import { fromBase64Url, toBase64Url } from './encoding';
import type { Invite } from './invite';
import { iceServers, SecureLink } from './link';
import { diffDocuments } from './merge';
import { hostHelloSchema, hostMessageSchema } from './protocol';
import type { GuestRequest, Participant } from './protocol';
import { SignalingClient } from './signaling';

const REQUEST_TIMEOUT_MS = 45_000;
const HANDSHAKE_TIMEOUT_MS = 20_000;

export interface GuestEvents {
  onCode: (code: string) => void;
  onDocument: (document: AnnotationDocument) => void;
  onSchema: (schema: DatasetSchema) => void;
  onIndex: () => void;
  onPresence: (participants: Participant[]) => void;
  onEnded: (reason: string) => void;
}

interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

export class LiveGuest {
  you = '';
  workspaceName = '';
  schema: DatasetSchema | null = null;
  participants: Participant[] = [];
  readonly storage: StorageClient;
  private events: GuestEvents;
  private link: SecureLink | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly documents = new Map<string, AnnotationDocument>();
  private nextId = 0;
  private ended = false;
  private ready: (() => void) | null = null;
  private failJoin: ((error: Error) => void) | null = null;

  private constructor(private readonly signaling: SignalingClient, events: GuestEvents) {
    this.events = events;
    this.storage = new RemoteStorage(this);
    signaling.onClosed = reason => this.finish(reason);
  }

  // Resolves once the host approves this participant.
  static async join(invite: Invite, name: string, events: GuestEvents): Promise<LiveGuest> {
    const [identity, key] = await Promise.all([createIdentity(), signalKey(invite)]);
    const signaling = await SignalingClient.connect(invite.roomId, 'guest');
    const guest = new LiveGuest(signaling, events);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The host did not answer. Check that the invite link is current.')), HANDSHAKE_TIMEOUT_MS);
        let answered = false;
        guest.ready = () => { clearTimeout(timer); resolve(); };
        guest.failJoin = error => { clearTimeout(timer); reject(error); };
        signaling.onFrame = (from, frame) => {
          if (from !== signaling.hostId) return;
          if (!isSignalFrame(frame)) { guest.link?.receive(frame); return; }
          if (answered) return;
          answered = true;
          void (async () => {
            const hello = hostHelloSchema.parse(await openSignal(key, frame));
            const session = await deriveSession(identity, fromBase64Url(hello.key), invite, 'guest');
            clearTimeout(timer);
            const link = new SecureLink(signaling, signaling.hostId, session.cipher);
            link.onMessage = message => guest.receive(message);
            link.onFailure = reason => guest.finish(`The live-session connection failed: ${reason}`);
            guest.link = link;
            events.onCode(session.code);
          })().catch(() => { clearTimeout(timer); reject(new Error('The host reply could not be verified. The invite may be wrong.')); });
        };
        void sealSignal(key, { t: 'hello', name, key: toBase64Url(identity.publicKey) })
          .then(frame => signaling.send(signaling.hostId, frame)).catch(reject);
      });
    } catch (failure) {
      guest.failJoin = null;
      guest.finish(failure instanceof Error ? failure.message : 'Unable to join the live session.');
      throw failure;
    }
    guest.ready = null; guest.failJoin = null;
    return guest;
  }

  setEvents(events: GuestEvents): void { this.events = events; }
  get isEnded(): boolean { return this.ended; }

  setViewing(imageId: string | null): void {
    void this.link?.send({ t: 'viewing', imageId }).catch(() => {});
  }

  leave(): void {
    this.finish('You left the live session.');
  }

  cached(id: string): AnnotationDocument | undefined { return this.documents.get(id); }

  async call(payload: GuestRequest): Promise<unknown> {
    if (this.ended || !this.link) throw new Error('The live session has ended.');
    const id = ++this.nextId;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The host did not respond in time.'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.link.send({ t: 'request', id, payload }).catch(failure => {
      const entry = this.pending.get(id);
      if (!entry) return;
      clearTimeout(entry.timer); this.pending.delete(id);
      entry.reject(failure instanceof Error ? failure : new Error('Unable to reach the host.'));
    });
    return result;
  }

  remember(document: AnnotationDocument): void {
    const known = this.documents.get(document.image.id);
    if (!known || document.revision >= known.revision) this.documents.set(document.image.id, document);
  }

  private receive(raw: unknown): void {
    const parsed = hostMessageSchema.safeParse(raw);
    if (!parsed.success) { this.finish('The host sent an invalid live-session message.'); return; }
    const message = parsed.data;
    switch (message.t) {
      case 'ready':
        this.you = message.you; this.workspaceName = message.workspaceName; this.schema = message.schema;
        this.ready?.();
        break;
      case 'reply': {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        clearTimeout(entry.timer); this.pending.delete(message.id);
        if (message.ok) entry.resolve(message.value);
        else entry.reject(new Error(message.error ?? 'The host rejected the request.'));
        break;
      }
      case 'document': {
        const known = this.documents.get(message.document.image.id);
        if (known && message.document.revision < known.revision) return;
        this.documents.set(message.document.image.id, message.document);
        this.events.onDocument(message.document);
        break;
      }
      case 'schema': this.schema = message.schema; this.documents.clear(); this.events.onSchema(message.schema); break;
      case 'index': this.documents.clear(); this.events.onIndex(); break;
      case 'presence': this.participants = message.participants; this.events.onPresence(message.participants); break;
      case 'end': this.finish(message.reason || 'The host ended the live session.'); break;
      case 'rtc': void this.link?.handleRtc(message, iceServers()).catch(() => {}); break;
    }
  }

  private finish(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.failJoin?.(new Error(reason)); this.failJoin = null;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(reason)); }
    this.pending.clear();
    this.documents.clear();
    this.link?.close();
    this.signaling.close();
    this.events.onEnded(reason);
  }
}

// Presents the host's workspace through the same request interface as the local
// storage worker, limited to reading and annotation edits.
class RemoteStorage implements StorageClient {
  constructor(private readonly guest: LiveGuest) {}
  get isClosed(): boolean { return this.guest.isEnded; }
  close(): void { this.guest.leave(); }

  async request<T>(payload: unknown, schema: z.ZodType<T>): Promise<T> {
    const request = payload as { type?: string; id?: string; document?: unknown; tiles?: unknown[] };
    switch (request.type) {
      case 'workspace-open':
        return schema.parse({ exists: true, unlocked: true, ids: [], recovered: 0, sqlite: 'remote', vfs: 'opfs-sahpool' });
      case 'schema-open':
        if (!this.guest.schema) throw new Error('The host has not shared the dataset schema yet.');
        return schema.parse({ ready: true, completed: 0, total: 0, schema: this.guest.schema });
      case 'workspace-list': case 'workspace-thumbnail': case 'workspace-mask-read':
        return schema.parse(await this.guest.call(payload as GuestRequest));
      case 'workspace-read': {
        const result = schema.parse(await this.guest.call(payload as GuestRequest));
        this.guest.remember((result as { document: AnnotationDocument }).document);
        return result;
      }
      case 'workspace-update': {
        if (request.tiles?.length) throw new Error('Mask painting is host-only during live sessions.');
        const next = documentSchema.parse(request.document);
        const base = this.guest.cached(next.image.id);
        if (!base) throw new Error('Reopen this image to continue editing.');
        const commands = diffDocuments(base, next);
        if (commands.length === 0) return schema.parse({ id: next.image.id, revision: base.revision });
        return schema.parse(await this.guest.call({ type: 'live-edit', id: next.image.id, commands }));
      }
      default:
        throw new Error('This action is not available to live-session guests.');
    }
  }
}
