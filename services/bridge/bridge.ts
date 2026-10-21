import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  browserMessage, DATA_TTL, PAIR_TTL, pairingSchema, pairMessage,
  proposalSchema, SESSION_TTL, snapshotSchema,
} from './protocol.ts';
import type { Scope, Snapshot } from './protocol.ts';

export class BridgeError extends Error {
  readonly code: 'denied' | 'invalid' | 'stale' | 'limited';
  constructor(code: BridgeError['code']) { super(code); this.code = code; }
}
const secret = () => randomBytes(32).toString('base64url');
const equal = (left: string, right: string) => {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
type Proposal = z.infer<typeof proposalSchema> & { id: string };
type Session = {
  bearer: string; origin: string; workspaceId: string; scopes: Scope[]; expiresAt: number;
  snapshot?: Snapshot; dataUntil: number; proposals: Proposal[];
};

/** Single editor process, one explicitly approved workspace, memory only. */
export class Bridge {
  private readonly origins: readonly string[];
  private readonly now: () => number;
  private pending: (z.infer<typeof pairingSchema> & { token: string; expiresAt: number }) | undefined;
  private session: Session | undefined;
  private limits = new Map<string, { until: number; count: number }>();
  private audit: { event: 'paired' | 'cleared' | 'proposal' | 'review'; at: number }[] = [];

  constructor(origins: readonly string[], now = Date.now) { this.origins = origins; this.now = now; }

  limit(bucket: 'http' | 'pair' | 'tool', max: number) {
    const previous = this.limits.get(bucket);
    const window = previous && previous.until > this.now() ? previous : { until: this.now() + 60_000, count: 0 };
    this.limits.set(bucket, window);
    if (++window.count > max) throw new BridgeError('limited');
  }

  private record(event: 'paired' | 'cleared' | 'proposal' | 'review') {
    this.audit.push({ event, at: this.now() });
    if (this.audit.length > 100) this.audit.shift();
  }

  sweep() {
    if (this.pending && this.pending.expiresAt <= this.now()) this.pending = undefined;
    if (this.session && this.session.expiresAt <= this.now()) this.clear();
    if (this.session?.snapshot && this.session.dataUntil <= this.now()) {
      delete this.session.snapshot;
      this.session.proposals = [];
    }
  }

  clear() {
    this.session = undefined;
    this.pending = undefined;
    this.record('cleared');
  }

  beginPair(input: unknown) {
    this.limit('pair', 5);
    this.sweep();
    const value = pairingSchema.safeParse(input);
    if (!value.success) throw new BridgeError('invalid');
    if (!this.origins.includes(value.data.origin) || this.session) throw new BridgeError('denied');
    this.pending = { ...value.data, token: secret(), expiresAt: this.now() + PAIR_TTL };
    return { token: this.pending.token, expiresAt: this.pending.expiresAt,
      workspaceId: value.data.workspaceId, scopes: value.data.scopes };
  }

  pair(origin: string, input: unknown) {
    this.sweep();
    const value = pairMessage.safeParse(input), pending = this.pending;
    if (!value.success || !pending || !equal(value.data.token, pending.token) ||
        pending.origin !== origin || pending.workspaceId !== value.data.workspaceId) throw new BridgeError('denied');
    // A valid token is consumed even when approval requests an invalid scope.
    this.pending = undefined;
    if (value.data.scopes.some(item => !pending.scopes.includes(item))) throw new BridgeError('denied');
    this.session = { bearer: secret(), origin, workspaceId: pending.workspaceId, scopes: value.data.scopes,
      expiresAt: this.now() + SESSION_TTL, dataUntil: 0, proposals: [] };
    this.record('paired');
    return { bearer: this.session.bearer, expiresAt: this.session.expiresAt };
  }

  authenticate(origin: string, bearer: string) {
    this.sweep();
    if (!this.session || this.session.origin !== origin || !equal(bearer, this.session.bearer)) {
      throw new BridgeError('denied');
    }
  }

  private active(scope?: Scope) {
    this.sweep();
    if (!this.session || (scope && !this.session.scopes.includes(scope))) throw new BridgeError('denied');
    return this.session;
  }

  private data(scope: Scope) {
    const session = this.active(scope);
    if (!session.snapshot) throw new BridgeError('stale');
    return { session, snapshot: session.snapshot };
  }

  status() {
    this.sweep();
    return { authorized: !!this.session, approvedDataAvailable: !!this.session?.snapshot,
      fileVisibility: 'not-observed' as const, expiresAt: this.session?.expiresAt ?? null };
  }

  browser(origin: string, bearer: string, input: unknown) {
    this.authenticate(origin, bearer);
    const value = browserMessage.safeParse(input);
    if (!value.success) throw new BridgeError('invalid');
    const message = value.data, session = this.active();
    if (message.type === 'revoke' || message.type === 'lock') { this.clear(); return { cleared: true }; }
    if (message.type === 'snapshot') {
      if (session.snapshot && message.snapshot.revision < session.snapshot.revision) throw new BridgeError('stale');
      // Identical revision refreshes may extend the lease but cannot change its data.
      if (session.snapshot && message.snapshot.revision === session.snapshot.revision &&
          JSON.stringify(message.snapshot) !== JSON.stringify(session.snapshot)) throw new BridgeError('stale');
      session.snapshot = message.snapshot;
      session.dataUntil = this.now() + DATA_TTL;
      session.proposals = session.proposals.filter(item => item.baseRevision === message.snapshot.revision);
      return { received: true };
    }
    if (message.type === 'review') {
      const proposal = session.proposals.find(item => item.id === message.proposalId);
      if (!proposal || !session.snapshot || proposal.baseRevision !== message.baseRevision ||
          session.snapshot.revision !== message.baseRevision) throw new BridgeError('stale');
      if (message.outcome === 'applied') {
        if (message.snapshot.revision <= message.baseRevision) throw new BridgeError('stale');
        session.snapshot = message.snapshot;
        session.dataUntil = this.now() + DATA_TTL;
        session.proposals = [];
      } else session.proposals = session.proposals.filter(item => item.id !== proposal.id);
      this.record('review');
      return { received: true };
    }
    return { ...this.status(), proposals: session.proposals, audit: [...this.audit] };
  }

  metadata() {
    return this.data('metadata').snapshot;
  }

  counts() {
    const { snapshot } = this.data('counts');
    return { revision: snapshot.revision, images: snapshot.images.length, annotations: snapshot.annotations.length,
      classes: snapshot.classes.map(classId => ({
        classId, count: snapshot.annotations.filter(item => item.classId === classId).length,
      })) };
  }

  propose(input: unknown) {
    const { session, snapshot } = this.data('propose');
    const value = proposalSchema.safeParse(input);
    if (!value.success) throw new BridgeError('invalid');
    if (value.data.baseRevision !== snapshot.revision) throw new BridgeError('stale');
    if (session.proposals.length >= 20) throw new BridgeError('limited');
    const ids = value.data.operations.map(item => item.annotation.id);
    if (new Set(ids).size !== ids.length) throw new BridgeError('invalid');
    const annotations = snapshot.annotations.map(item =>
      value.data.operations.find(operation => operation.annotation.id === item.id)?.annotation ?? item);
    if (value.data.operations.some(operation => !snapshot.annotations.some(item =>
      item.id === operation.annotation.id && item.imageId === operation.annotation.imageId)) ||
        !snapshotSchema.safeParse({ ...snapshot, annotations }).success) throw new BridgeError('invalid');
    const proposal = { ...value.data, id: randomUUID() };
    session.proposals.push(proposal);
    this.record('proposal');
    return { proposalId: proposal.id, baseRevision: proposal.baseRevision, state: 'awaiting-browser-review' };
  }
}
