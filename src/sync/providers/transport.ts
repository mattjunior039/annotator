import { ProviderError } from './types';
import type { AccessToken, ProviderOptions } from './types';

export const JSON_LIMIT = 512 * 1024;
export const PAGE_SIZE = 100;
export function opaqueKey(key: string): void {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new ProviderError('invalid-input');
}
export function identifier(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(id)) throw new ProviderError('invalid-input');
  return id;
}
export function cursorValue(cursor: string): string {
  if (!cursor || cursor.length > 4096 || /[\x00-\x1f\x7f]/.test(cursor)) throw new ProviderError('invalid-input');
  return cursor;
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderError('invalid-response');
  return value as Record<string, unknown>;
}
export function objectSize(value: unknown, max: number): number {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n > max) throw new ProviderError('invalid-response');
  return n;
}
export function uploadBytes(bytes: Uint8Array<ArrayBuffer>, max: number): Uint8Array<ArrayBuffer> {
  if (!(bytes instanceof Uint8Array)) throw new ProviderError('invalid-input');
  if (bytes.byteLength > max) throw new ProviderError('too-large');
  // Snapshot the caller's buffer before the first await.
  return new Uint8Array(bytes);
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export class Transport {
  private token: AccessToken;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  constructor(private readonly options: ProviderOptions) {
    this.token = this.checkToken(options.credentials.token);
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) {
      throw new ProviderError('invalid-input');
    }
  }
  private checkToken(token: AccessToken): AccessToken {
    if (!token || typeof token.accessToken !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(token.accessToken) ||
        !Number.isFinite(token.expiresAt)) throw new ProviderError('invalid-input');
    return { accessToken: token.accessToken, expiresAt: token.expiresAt };
  }
  async run<T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const bounded = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, bounded]) : bounded;
    combined.throwIfAborted();
    try { return await abortable(operation(combined), combined); }
    catch (error) {
      combined.throwIfAborted();
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('network');
    }
  }
  async request(url: URL, init: RequestInit, signal: AbortSignal): Promise<Response> {
    signal.throwIfAborted();
    if (this.token.expiresAt <= Date.now()) {
      if (!this.options.credentials.refresh) throw new ProviderError('credential-expired');
      try {
        const next = await abortable(this.options.credentials.refresh(signal), signal);
        signal.throwIfAborted();
        this.token = this.checkToken(next);
      } catch {
        signal.throwIfAborted();
        throw new ProviderError('credential-expired');
      }
      if (this.token.expiresAt <= Date.now()) throw new ProviderError('credential-expired');
    }
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.token.accessToken}`);
    const response = await this.fetcher(url, { ...init, headers, signal, credentials: 'omit',
      redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' });
    signal.throwIfAborted();
    if (!response.ok && response.status !== 404) {
      await response.body?.cancel();
      const code = response.status === 401 ? 'credential-expired' : response.status === 403 ? 'permission-denied' :
        response.status === 409 || response.status === 412 ? 'conflict' : 'http';
      throw new ProviderError(code, response.status);
    }
    return response;
  }
  async bytes(response: Response, max: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    const length = response.headers.get('Content-Length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > max)) {
      await response.body?.cancel();
      throw new ProviderError('too-large');
    }
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await abortable(reader.read(), signal);
        if (done) break;
        size += value.byteLength;
        if (size > max) throw new ProviderError('too-large');
        chunks.push(value);
      }
    } finally {
      // Cancellation is best effort; it must not mask the original error/abort.
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  }
  async json(response: Response, signal: AbortSignal): Promise<unknown> {
    if (response.status === 404) {
      await response.body?.cancel();
      throw new ProviderError('not-found', 404);
    }
    const bytes = await this.bytes(response, JSON_LIMIT, signal);
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
    catch { throw new ProviderError('invalid-response'); }
  }
}
