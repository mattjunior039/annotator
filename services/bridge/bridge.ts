import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  browserMessage, JOB_TTL, jobKinds, OFFLINE_AFTER, PAIR_TTL, pairCheck, pairCode, pairRequest, SESSION_TTL,
} from './protocol.ts';
import type { JobKind, Scope } from './protocol.ts';

export type BridgeCode = 'denied' | 'invalid' | 'stale' | 'limited' | 'offline' | 'timeout' | 'declined' | 'failed';
export class BridgeError extends Error {
  readonly code: BridgeCode;
  readonly detail: string | undefined;
  constructor(code: BridgeCode, detail?: string) { super(code); this.code = code; this.detail = detail; }
}
const secret = () => randomBytes(32).toString('base64url');
const equal = (left: string, right: string) => {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
type Pending = {
  origin: string; workspaceId: string; scopes: Scope[]; code: string; ticket: string;
  expiresAt: number; confirmed: boolean; attempts: number;
};
type Job = {
  id: string; kind: JobKind; args: unknown; delivered: boolean;
  resolve: (value: unknown) => void; reject: (error: BridgeError) => void; timer: ReturnType<typeof setTimeout>;
};
type Session = {
  bearer: string; origin: string; workspaceId: string; scopes: Scope[];
  expiresAt: number; lastPoll: number; jobs: Job[];
};
type AuditEvent = 'paired' | 'cleared' | 'request' | 'result';

/** One editor process, one browser-approved workspace. All state is memory-only. */
export class Bridge {
  private readonly origins: readonly string[];
  private readonly now: () => number;
  private readonly jobTimeout: number;
  private pending: Pending | undefined;
  private session: Session | undefined;
  private limits = new Map<string, { until: number; count: number }>();
  private audit: { event: AuditEvent; at: number }[] = [];

  constructor(origins: readonly string[], now = Date.now, jobTimeout = JOB_TTL) {
    this.origins = origins; this.now = now; this.jobTimeout = jobTimeout;
  }

  limit(bucket: 'http' | 'pair' | 'code' | 'tool', max: number) {
    const previous = this.limits.get(bucket);
    const window = previous && previous.until > this.now() ? previous : { until: this.now() + 60_000, count: 0 };
    this.limits.set(bucket, window);
    if (++window.count > max) throw new BridgeError('limited');
  }

  private record(event: AuditEvent) {
    this.audit.push({ event, at: this.now() });
    if (this.audit.length > 100) this.audit.shift();
  }

  sweep() {
    if (this.pending && this.pending.expiresAt <= this.now()) this.pending = undefined;
    if (this.session && this.session.expiresAt <= this.now()) this.endSession();
  }

  private endSession() {
    const session = this.session;
    this.session = undefined;
    for (const job of session?.jobs ?? []) { clearTimeout(job.timer); job.reject(new BridgeError('denied')); }
    if (session) this.record('cleared');
  }

  clear() {
    this.pending = undefined;
    this.endSession();
  }

  /** Browser asks to connect; the user then tells the editor the displayed code. */
  requestPair(origin: string, input: unknown) {
    this.limit('pair', 10);
    this.sweep();
    const value = pairRequest.safeParse(input);
    if (!value.success) throw new BridgeError('invalid');
    if (!this.origins.includes(origin)) throw new BridgeError('denied');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.pending = { origin, workspaceId: value.data.workspaceId, scopes: value.data.scopes, code,
      ticket: secret(), expiresAt: this.now() + PAIR_TTL, confirmed: false, attempts: 0 };
    return { code, ticket: this.pending.ticket, expiresAt: this.pending.expiresAt };
  }

  /** Editor (MCP tool) confirms the code shown in the browser. */
  confirmPair(input: unknown) {
    this.limit('code', 10);
    this.sweep();
    const value = pairCode.safeParse(input);
    const pending = this.pending;
    if (!value.success || !pending || pending.confirmed) throw new BridgeError('denied', 'No connection request is waiting. Click Connect in the website first.');
    const code = value.data.code.replace(/[\s-]/g, '');
    if (!/^\d{6}$/.test(code) || !equal(code, pending.code)) {
      if (++pending.attempts >= 5) this.pending = undefined;
      throw new BridgeError('denied', 'That code does not match the one shown in the website.');
    }
    pending.confirmed = true;
    return { connected: true, scopes: pending.scopes };
  }

  checkPair(origin: string, input: unknown) {
    this.sweep();
    const value = pairCheck.safeParse(input), pending = this.pending;
    if (!value.success || !pending || pending.origin !== origin || !equal(value.data.ticket, pending.ticket)) {
      throw new BridgeError('denied');
    }
    if (!pending.confirmed) return { state: 'pending' as const, expiresAt: pending.expiresAt };
    this.pending = undefined;
    // A confirmed reconnect replaces an earlier browser session, for example after a page reload.
    this.endSession();
    this.session = { bearer: secret(), origin, workspaceId: pending.workspaceId, scopes: pending.scopes,
      expiresAt: this.now() + SESSION_TTL, lastPoll: this.now(), jobs: [] };
    this.record('paired');
    return { state: 'paired' as const, bearer: this.session.bearer, expiresAt: this.session.expiresAt, scopes: this.session.scopes };
  }

  authenticate(origin: string, bearer: string) {
    this.sweep();
    if (!this.session || this.session.origin !== origin || !equal(bearer, this.session.bearer)) {
      throw new BridgeError('denied');
    }
  }

  status() {
    this.sweep();
    const session = this.session;
    return {
      connected: !!session,
      browserOnline: !!session && this.now() - session.lastPoll < OFFLINE_AFTER,
      scopes: session?.scopes ?? [],
      expiresAt: session?.expiresAt ?? null,
      waitingForCode: !!this.pending && !this.pending.confirmed,
      pendingRequests: session?.jobs.length ?? 0,
      recent: this.audit.slice(-10),
    };
  }

  browser(origin: string, bearer: string, input: unknown) {
    this.authenticate(origin, bearer);
    const value = browserMessage.safeParse(input);
    if (!value.success) throw new BridgeError('invalid');
    const message = value.data, session = this.session!;
    if (message.type === 'revoke' || message.type === 'lock') { this.clear(); return { cleared: true }; }
    if (message.type === 'poll') {
      session.lastPoll = this.now();
      const jobs = session.jobs.filter(job => !job.delivered).slice(0, 16);
      for (const job of jobs) job.delivered = true;
      return { authorized: true, expiresAt: session.expiresAt,
        jobs: jobs.map(job => ({ id: job.id, kind: job.kind, args: job.args })) };
    }
    const job = session.jobs.find(item => item.id === message.jobId && item.delivered);
    if (!job) throw new BridgeError('stale');
    session.jobs = session.jobs.filter(item => item !== job);
    clearTimeout(job.timer);
    this.record('result');
    if (!message.ok) { job.reject(new BridgeError(message.error, message.message)); return { received: true }; }
    const parsed = jobKinds[job.kind].result.safeParse(message.value);
    if (!parsed.success) { job.reject(new BridgeError('failed', 'The website returned an invalid result.')); return { received: true }; }
    job.resolve(parsed.data);
    return { received: true };
  }

  /** Forward a validated editor request to the paired browser and wait for its answer. */
  call(kind: JobKind, args: unknown): Promise<unknown> {
    this.sweep();
    const session = this.session, spec = jobKinds[kind];
    if (!session) return Promise.reject(new BridgeError('denied', 'Not connected. Open the website, click Connect, then call bridge_pair with the code shown.'));
    if (!session.scopes.includes(spec.scope)) return Promise.reject(new BridgeError('denied', `The website did not grant the "${spec.scope}" permission.`));
    const parsed = spec.input.safeParse(args ?? {});
    if (!parsed.success) return Promise.reject(new BridgeError('invalid', parsed.error.issues.map(issue =>
      `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ').slice(0, 500)));
    if (this.now() - session.lastPoll >= OFFLINE_AFTER) {
      return Promise.reject(new BridgeError('offline', 'The website is not responding. Keep the workspace tab open and connected.'));
    }
    if (session.jobs.length >= 16) return Promise.reject(new BridgeError('limited'));
    this.record('request');
    return new Promise((resolve, reject) => {
      const job: Job = { id: randomUUID(), kind, args: parsed.data, delivered: false, resolve, reject,
        timer: setTimeout(() => {
          if (this.session) this.session.jobs = this.session.jobs.filter(item => item !== job);
          reject(new BridgeError('timeout', 'The website did not answer in time (it may still be waiting for your approval).'));
        }, this.jobTimeout) };
      job.timer.unref?.();
      session.jobs.push(job);
    });
  }
}
