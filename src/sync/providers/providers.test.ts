import { describe, expect, it, vi } from 'vitest';
import { ciphertext, DRIVE_FILE_SCOPE, GoogleDriveProvider, HuggingFaceProvider, ProviderError } from './index';
import type { Credentials, EncryptedObjectProvider } from './index';

const KEY = 'a'.repeat(64);
const REVISION = 'b'.repeat(40);
const PAYLOAD = ciphertext(new Uint8Array([0, 255, 128, 13, 10, 1, 0, 201]));
const credentials = (): Credentials => ({ token: { accessToken: 'opaque-access-token', expiresAt: Date.now() + 60_000 } });
const json = (data: unknown, headers?: HeadersInit) => new Response(JSON.stringify(data), headers ? { headers } : {});
const unconditional = { kind: 'unconditional' } as const;

function setup(kind: 'hf' | 'drive', handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
  auth: Credentials = credentials(), timeoutMs = 30_000) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(new URL(String(input)), init!));
  const refresh = auth.refresh ?? vi.fn(async () => credentials().token);
  const provider: EncryptedObjectProvider = kind === 'hf'
    ? new HuggingFaceProvider({ repository: 'owner/encrypted', credentials: auth, fetch: fetcher, timeoutMs })
    : new GoogleDriveProvider({ folderId: 'folder_123', scopes: [DRIVE_FILE_SCOPE],
      credentials: { ...auth, refresh }, fetch: fetcher, timeoutMs });
  return { provider, fetcher, refresh };
}

describe.each(['hf', 'drive'] as const)('%s encrypted object contract', kind => {
  const objectId = kind === 'hf' ? KEY : 'file_123';
  const uploadResponse = () => json(kind === 'hf' ? { commitOid: REVISION } : { id: objectId });
  const pageEntry = () => kind === 'hf'
    ? { path: `objects/${KEY}.enc`, type: 'file', size: PAYLOAD.length }
    : { id: objectId, name: `${KEY}.enc`, size: String(PAYLOAD.length), mimeType: 'application/octet-stream' };

  it('uploads the exact ciphertext bytes and downloads without interpreting encryption', async () => {
    const { provider, fetcher } = setup(kind, async (url, init) => {
      expect(init.credentials).toBe('omit');
      expect(init.redirect).toBe('error');
      expect(init.cache).toBe('no-store');
      expect(init.referrerPolicy).toBe('no-referrer');
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer opaque-access-token');
      if (init.method) {
        if (kind === 'hf') {
          expect(url.pathname).toBe('/api/datasets/owner/encrypted/commit/main');
          const [header, file] = String(init.body).trim().split('\n').map(line => JSON.parse(line));
          expect(header).toEqual({ key: 'header', value: { summary: 'Store encrypted object' } });
          expect(file.value.path).toBe(`objects/${KEY}.enc`);
          expect(file.value.encoding).toBe('base64');
          expect(new Uint8Array(Buffer.from(file.value.content, 'base64'))).toEqual(PAYLOAD);
        } else {
          expect(url.pathname).toBe('/upload/drive/v3/files');
          expect(url.searchParams.get('uploadType')).toBe('multipart');
          const bytes = new Uint8Array(await (init.body as Blob).arrayBuffer());
          const text = new TextDecoder().decode(bytes);
          expect(text).toContain(`"name":"${KEY}.enc"`);
          expect(text).toContain('"parents":["folder_123"]');
          const marker = new TextEncoder().encode('Content-Type: application/octet-stream\r\n\r\n');
          const offset = Buffer.from(bytes).indexOf(marker) + marker.length;
          expect(bytes.slice(offset, offset + PAYLOAD.length)).toEqual(PAYLOAD);
          expect(new Headers(init.headers).get('Content-Type')).toMatch(/^multipart\/related; boundary=encrypted_/);
        }
        return uploadResponse();
      }
      if (kind === 'hf') expect(url.pathname).toBe(`/datasets/owner/encrypted/raw/main/objects/${KEY}.enc`);
      else expect(url.searchParams.get('alt')).toBe('media');
      return new Response(PAYLOAD);
    });
    expect((await provider.put(KEY, PAYLOAD, { condition: unconditional })).id).toBe(objectId);
    expect(await provider.get(objectId)).toEqual(PAYLOAD);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('snapshots mutable ciphertext before asynchronous credential refresh', async () => {
    let finish!: (token: Credentials['token']) => void;
    const auth = credentials();
    auth.token.expiresAt = 0;
    auth.refresh = () => new Promise(resolve => { finish = resolve; });
    const { provider } = setup(kind, async (_url, init) => {
      if (kind === 'hf') {
        const file = JSON.parse(String(init.body).trim().split('\n')[1]!);
        expect(Buffer.from(file.value.content, 'base64')[0]).toBe(0);
      } else {
        const body = new Uint8Array(await (init.body as Blob).arrayBuffer());
        expect(Buffer.from(body).includes(Buffer.from(PAYLOAD))).toBe(true);
      }
      return uploadResponse();
    }, auth);
    const bytes = ciphertext(PAYLOAD.slice());
    const result = provider.put(KEY, bytes, { condition: unconditional });
    bytes.fill(42);
    finish(credentials().token);
    await result;
  });

  it('returns a single bounded page and forwards opaque pagination tokens', async () => {
    let calls = 0;
    const { provider, fetcher } = setup(kind, url => {
      calls++;
      const cursorName = kind === 'hf' ? 'cursor' : 'pageToken';
      expect(url.searchParams.get(cursorName)).toBe(calls === 1 ? null : 'next+/=');
      if (kind === 'drive') {
        expect(url.searchParams.get('q')).toBe("'folder_123' in parents and trashed = false");
        expect(url.searchParams.get('pageSize')).toBe('100');
      }
      return kind === 'hf'
        ? json([pageEntry()], calls === 1 ? { Link: `<${url.origin}${url.pathname}?cursor=next%2B%2F%3D&limit=100>; rel="next"` } : {})
        : json({ files: [pageEntry()], ...(calls === 1 ? { nextPageToken: 'next+/=' } : {}) });
    });
    const first = await provider.list();
    expect(first).toEqual({ objects: [{ id: objectId, key: KEY, size: PAYLOAD.length }], cursor: 'next+/=' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await provider.list({ cursor: first.cursor! })).toEqual({ objects: first.objects });
  });

  it('rejects create-only conditions before sending any network request', async () => {
    const { provider, fetcher } = setup(kind, uploadResponse);
    expect(provider.capabilities.createOnly).toBe(false);
    await expect(provider.put(KEY, PAYLOAD, { condition: { kind: 'create-only' } })).rejects.toMatchObject({ code: 'unsupported-condition' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not silently weaken an unknown runtime condition', async () => {
    const { provider, fetcher } = setup(kind, uploadResponse);
    await expect(provider.put(KEY, PAYLOAD, { condition: { kind: 'if-match' } as unknown as typeof unconditional }))
      .rejects.toMatchObject({ code: 'unsupported-condition' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns null for missing objects', async () => {
    const { provider } = setup(kind, () => new Response(null, { status: 404 }));
    expect(await provider.get(objectId)).toBeNull();
    await expect(provider.list()).rejects.toMatchObject({ code: 'not-found' });
  });

  it.each([401, 403, 409, 412, 429, 503])('surfaces HTTP %i without retries or disclosing the error body', async status => {
    const refresh = vi.fn(async () => credentials().token);
    const { provider, fetcher } = setup(kind, () => new Response('secret plaintext token key', { status }),
      { ...credentials(), refresh });
    const error = await provider.put(KEY, PAYLOAD, { condition: unconditional }).catch(error => error);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.status).toBe(status);
    expect(error.message).not.toMatch(/secret|plaintext|token|key/);
    expect(error.code).toBe(status === 401 ? 'credential-expired' : status === 403 ? 'permission-denied' :
      status === 409 || status === 412 ? 'conflict' : 'http');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes an expired credential only through the explicit caller callback', async () => {
    const auth = credentials();
    auth.token.expiresAt = 0;
    auth.refresh = vi.fn(async signal => {
      expect(signal).toBeInstanceOf(AbortSignal);
      return { accessToken: 'fresh-token', expiresAt: Date.now() + 60_000 };
    });
    const { provider } = setup(kind, (_url, init) => {
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer fresh-token');
      return new Response(PAYLOAD);
    }, auth);
    await provider.get(objectId);
    expect(auth.refresh).toHaveBeenCalledTimes(1);
  });

  it.each(['reject', 'expired', 'invalid'] as const)('fails closed when refresh is %s', async failure => {
    const auth = credentials();
    auth.token.expiresAt = 0;
    auth.refresh = vi.fn(async () => {
      if (failure === 'reject') throw new Error('sensitive refresh failure');
      return { accessToken: failure === 'invalid' ? 'bad\ntoken' : 'old-token', expiresAt: failure === 'expired' ? 0 : Date.now() + 60_000 };
    });
    const { provider, fetcher } = setup(kind, uploadResponse, auth);
    await expect(provider.get(objectId)).rejects.toMatchObject({ code: 'credential-expired' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not send a request after a pre-abort', async () => {
    const { provider, fetcher } = setup(kind, uploadResponse);
    const abort = new AbortController();
    abort.abort();
    await expect(provider.get(objectId, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(provider.put(KEY, PAYLOAD, { condition: unconditional, signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(provider.list({ signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('aborts a stalled refresh without sending ciphertext', async () => {
    const auth = credentials();
    auth.token.expiresAt = 0;
    let refreshSignal: AbortSignal | undefined;
    auth.refresh = signal => { refreshSignal = signal; return new Promise(() => {}); };
    const { provider, fetcher } = setup(kind, uploadResponse, auth);
    const abort = new AbortController();
    const pending = provider.put(KEY, PAYLOAD, { condition: unconditional, signal: abort.signal });
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(refreshSignal?.aborted).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('aborts an in-flight upload without retrying its uncertain outcome', async () => {
    let sentSignal: AbortSignal | undefined;
    const { provider, fetcher } = setup(kind, (_url, init) => {
      sentSignal = init.signal!;
      return new Promise(() => {});
    });
    const abort = new AbortController();
    const pending = provider.put(KEY, PAYLOAD, { condition: unconditional, signal: abort.signal });
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(sentSignal?.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('cancels a stalled download reader on abort', async () => {
    const cancel = vi.fn();
    const { provider } = setup(kind, () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([0, 255])); }, cancel,
    })));
    const abort = new AbortController();
    const pending = provider.get(objectId, abort.signal);
    await vi.waitFor(() => expect(pending).toBeInstanceOf(Promise));
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it('bounds stalled network operations by timeout', async () => {
    const { provider } = setup(kind, () => new Promise(() => {}), credentials(), 10);
    await expect(provider.get(objectId)).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('bounds uploads before network I/O', async () => {
    const { provider, fetcher } = setup(kind, uploadResponse);
    await expect(provider.put(KEY, ciphertext(new Uint8Array(provider.capabilities.maxObjectBytes + 1)),
      { condition: unconditional })).rejects.toMatchObject({ code: 'too-large' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([true, false])('bounds downloads, including a dishonest/missing content length (%s)', async useHeader => {
    const { provider } = setup(kind, () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(provider.capabilities.maxObjectBytes + 1));
        controller.close();
      },
    }), useHeader ? { headers: { 'Content-Length': String(provider.capabilities.maxObjectBytes + 1) } } : {}));
    await expect(provider.get(objectId)).rejects.toMatchObject({ code: 'too-large' });
  });

  it('bounds JSON metadata even when the server ignores page size', async () => {
    const { provider } = setup(kind, () => new Response(' '.repeat(512 * 1024 + 1)));
    await expect(provider.list()).rejects.toMatchObject({ code: 'too-large' });
    const oversizedPage = setup(kind, () => json(kind === 'hf' ? Array(101).fill(pageEntry()) : { files: Array(101).fill(pageEntry()) }));
    await expect(oversizedPage.provider.list()).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('rejects malformed provider metadata and repeated pagination cursors', async () => {
    const malformed = setup(kind, () => json(kind === 'hf' ? [{ path: '../../plaintext' }] : { files: [{ name: 'plaintext' }] }));
    await expect(malformed.provider.list()).rejects.toMatchObject({ code: 'invalid-response' });
    const repeated = setup(kind, url => kind === 'hf'
      ? json([], { Link: `<${url.href}>; rel="next"` })
      : json({ files: [], nextPageToken: 'same' }));
    await expect(repeated.provider.list({ cursor: 'same' })).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('does not expose network error details or automatically retry CORS/network failures', async () => {
    const { provider, fetcher } = setup(kind, () => { throw new TypeError('CORS https://secret/token'); });
    await expect(provider.get(objectId)).rejects.toMatchObject({ code: 'network', message: 'Encrypted object provider: network' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects plaintext-style names, strings, traversal and oversized cursors', async () => {
    const { provider, fetcher } = setup(kind, uploadResponse);
    await expect(provider.put('patient-name.txt', PAYLOAD, { condition: unconditional })).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(provider.put(KEY, 'plaintext' as unknown as typeof PAYLOAD, { condition: unconditional })).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(provider.get('../secret')).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(provider.list({ cursor: 'x'.repeat(4097) })).rejects.toMatchObject({ code: 'invalid-input' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('provider-specific semantics', () => {
  it('HF sends an atomic repository parentCommit, not a simulated per-object If-Match', async () => {
    const { provider } = setup('hf', (_url, init) => {
      const header = JSON.parse(String(init.body).split('\n')[0]!);
      expect(header.value.parentCommit).toBe(REVISION);
      expect(new Headers(init.headers).has('If-Match')).toBe(false);
      return json({ commitOid: 'c'.repeat(40) });
    });
    expect(provider.capabilities.conditionalWrites).toBe('repository-parent-commit');
    expect(await provider.put(KEY, PAYLOAD, { condition: { kind: 'revision', revision: REVISION } }))
      .toEqual({ id: KEY, revision: 'c'.repeat(40) });
  });

  it('HF rejects expired credentials without an explicit refresh function', async () => {
    const auth = credentials(); auth.token.expiresAt = 0;
    const { provider, fetcher } = setup('hf', () => new Response(), auth);
    await expect(provider.get(KEY)).rejects.toMatchObject({ code: 'credential-expired' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('HF refuses next-page URLs that could leak credentials', async () => {
    const { provider, fetcher } = setup('hf', () => json([], {
      Link: '<https://attacker.invalid/collect?cursor=next>; rel="next"',
    }));
    await expect(provider.list()).rejects.toMatchObject({ code: 'invalid-response' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('HF rejects LFS listings rather than silently downloading a pointer as an object', async () => {
    const { provider } = setup('hf', () => json([{ path: `objects/${KEY}.enc`, type: 'file', size: 1, lfs: { oid: KEY } }]));
    await expect(provider.list()).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('Drive requires an explicit refresh callback and exactly the minimal supported scope', () => {
    const base = { folderId: 'folder', credentials: credentials() as never };
    expect(() => new GoogleDriveProvider({ ...base, scopes: [DRIVE_FILE_SCOPE] })).toThrow(ProviderError);
    expect(() => new GoogleDriveProvider({ ...base, scopes: ['https://www.googleapis.com/auth/drive'] })).toThrow(ProviderError);
    expect(() => new GoogleDriveProvider({ ...base, scopes: [] })).toThrow(ProviderError);
  });

  it('Drive refuses revision conditions without a racy read-then-write emulation', async () => {
    const { provider, fetcher } = setup('drive', () => json({ id: 'file' }));
    expect(provider.capabilities.conditionalWrites).toBe('none');
    expect(provider.capabilities.atomicPublication).toBe(false);
    await expect(provider.put(KEY, PAYLOAD, { condition: { kind: 'revision', revision: REVISION } }))
      .rejects.toMatchObject({ code: 'unsupported-condition' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('Drive replaces only an explicitly selected file ID', async () => {
    const { provider } = setup('drive', async (url, init) => {
      expect(init.method).toBe('PATCH');
      expect(url.pathname).toBe('/upload/drive/v3/files/existing_id');
      expect(await (init.body as Blob).text()).not.toContain('"parents"');
      return json({ id: 'existing_id' });
    });
    expect(await provider.put(KEY, PAYLOAD, { condition: unconditional, objectId: 'existing_id' })).toEqual({ id: 'existing_id' });
  });

  it('Drive preserves duplicate names as separate IDs and refuses incomplete searches', async () => {
    const file = { name: `${KEY}.enc`, size: '0', mimeType: 'application/octet-stream' };
    const { provider } = setup('drive', () => json({ files: [{ ...file, id: 'one' }, { ...file, id: 'two' }] }));
    expect((await provider.list()).objects.map(object => object.id)).toEqual(['one', 'two']);
    const incomplete = setup('drive', () => json({ files: [], incompleteSearch: true }));
    await expect(incomplete.provider.list()).rejects.toMatchObject({ code: 'invalid-response' });
  });
});
