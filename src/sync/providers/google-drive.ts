import { ciphertext, ProviderError } from './types';
import type { Ciphertext, Credentials, EncryptedObjectProvider, ObjectPage, ProviderOptions, PutOptions } from './types';
import { cursorValue, identifier, objectSize, opaqueKey, PAGE_SIZE, record, Transport, uploadBytes } from './transport';

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export interface GoogleDriveOptions extends ProviderOptions {
  credentials: Credentials & { refresh: NonNullable<Credentials['refresh']> };
  /** Caller attests that this is the actual grant, including after refresh. */
  scopes: readonly string[];
  /** Existing app-accessible folder; this adapter neither opens consent nor provisions folders. */
  folderId: string;
}
const MAX_BYTES = 5 * 1024 * 1024;

export class GoogleDriveProvider implements EncryptedObjectProvider {
  readonly capabilities = Object.freeze({
    conditionalWrites: 'none', createOnly: false, atomicPublication: false, maxObjectBytes: MAX_BYTES,
    uploadStreaming: false, downloadStreaming: 'bounded-buffer', automaticRetries: false,
  } as const);
  private readonly transport: Transport;
  private readonly folderId: string;
  constructor(options: GoogleDriveOptions) {
    if (options.scopes.length !== 1 || options.scopes[0] !== DRIVE_FILE_SCOPE ||
        typeof options.credentials.refresh !== 'function') throw new ProviderError('invalid-input');
    this.folderId = identifier(options.folderId);
    this.transport = new Transport(options);
  }
  async put(key: string, bytes: Ciphertext, options: PutOptions): Promise<{ id: string }> {
    opaqueKey(key);
    if (options.condition.kind !== 'unconditional') throw new ProviderError('unsupported-condition');
    const id = options.objectId === undefined ? undefined : identifier(options.objectId);
    const snapshot = uploadBytes(bytes, MAX_BYTES);
    return this.transport.run(options.signal, async signal => {
      const url = new URL(`https://www.googleapis.com/upload/drive/v3/files${id ? `/${id}` : ''}`);
      url.searchParams.set('uploadType', 'multipart');
      url.searchParams.set('fields', 'id');
      const boundary = `encrypted_${crypto.randomUUID()}`;
      const metadata = { name: `${key}.enc`, mimeType: 'application/octet-stream', ...(!id ? { parents: [this.folderId] } : {}) };
      const body = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
          `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
        snapshot, `\r\n--${boundary}--\r\n`,
      ]);
      const response = await this.transport.request(url, { method: id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body }, signal);
      const data = record(await this.transport.json(response, signal));
      if (typeof data.id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(data.id)) throw new ProviderError('invalid-response');
      if (id && id !== data.id) throw new ProviderError('invalid-response');
      return { id: data.id };
    });
  }
  async get(id: string, signal?: AbortSignal): Promise<Ciphertext | null> {
    identifier(id);
    return this.transport.run(signal, async bounded => {
      const url = new URL(`https://www.googleapis.com/drive/v3/files/${id}`);
      url.searchParams.set('alt', 'media');
      const response = await this.transport.request(url, {}, bounded);
      if (response.status === 404) { await response.body?.cancel(); return null; }
      return ciphertext(await this.transport.bytes(response, MAX_BYTES, bounded));
    });
  }
  async list(options: { cursor?: string; signal?: AbortSignal } = {}): Promise<ObjectPage> {
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('q', `'${this.folderId}' in parents and trashed = false`);
    url.searchParams.set('pageSize', String(PAGE_SIZE));
    url.searchParams.set('fields', 'nextPageToken,incompleteSearch,files(id,name,size,mimeType)');
    if (options.cursor !== undefined) url.searchParams.set('pageToken', cursorValue(options.cursor));
    return this.transport.run(options.signal, async signal => {
      const response = await this.transport.request(url, {}, signal);
      const data = record(await this.transport.json(response, signal));
      if (data.incompleteSearch === true || !Array.isArray(data.files) || data.files.length > PAGE_SIZE) {
        throw new ProviderError('invalid-response');
      }
      const objects = data.files.map(value => {
        const file = record(value);
        if (typeof file.id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(file.id) ||
            typeof file.name !== 'string' || !/^[a-f0-9]{64}\.enc$/.test(file.name) ||
            file.mimeType !== 'application/octet-stream') throw new ProviderError('invalid-response');
        return { id: file.id, key: file.name.slice(0, -4), size: objectSize(file.size, MAX_BYTES) };
      });
      if (data.nextPageToken === undefined) return { objects };
      if (typeof data.nextPageToken !== 'string' || data.nextPageToken === options.cursor) throw new ProviderError('invalid-response');
      return { objects, cursor: cursorValue(data.nextPageToken) };
    });
  }
}
