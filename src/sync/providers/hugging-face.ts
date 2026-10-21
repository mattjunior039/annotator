import { ciphertext, ProviderError } from './types';
import type { Ciphertext, EncryptedObjectProvider, ObjectPage, ProviderOptions, PutOptions } from './types';
import { cursorValue, objectSize, opaqueKey, PAGE_SIZE, record, Transport, uploadBytes } from './transport';

export interface HuggingFaceOptions extends ProviderOptions {
  /** Existing private dataset repository, exactly namespace/repository. No repo provisioning. */
  repository: string;
  branch?: string;
}
const MAX_BYTES = 1024 * 1024;
const SHA = /^[a-f0-9]{40}$/;
const PATH = /^objects\/([a-f0-9]{64})\.enc$/;

export class HuggingFaceProvider implements EncryptedObjectProvider {
  readonly capabilities = Object.freeze({
    conditionalWrites: 'repository-parent-commit', createOnly: false, atomicPublication: false,
    maxObjectBytes: MAX_BYTES, uploadStreaming: false, downloadStreaming: 'bounded-buffer', automaticRetries: false,
  } as const);
  private readonly transport: Transport;
  private readonly repository: string;
  private readonly branch: string;
  constructor(options: HuggingFaceOptions) {
    if (!/^[A-Za-z0-9_-]{1,96}\/[A-Za-z0-9_-]{1,96}$/.test(options.repository) ||
        !/^[A-Za-z0-9_-]{1,96}$/.test(options.branch ?? 'main')) throw new ProviderError('invalid-input');
    this.repository = options.repository;
    this.branch = options.branch ?? 'main';
    this.transport = new Transport(options);
  }
  async put(key: string, bytes: Ciphertext, options: PutOptions): Promise<{ id: string; revision: string }> {
    opaqueKey(key);
    if (options.objectId !== undefined && options.objectId !== key) throw new ProviderError('invalid-input');
    if (options.condition.kind !== 'unconditional' && options.condition.kind !== 'revision') {
      throw new ProviderError('unsupported-condition');
    }
    if (options.condition.kind === 'revision' && !SHA.test(options.condition.revision)) throw new ProviderError('invalid-input');
    const snapshot = uploadBytes(bytes, MAX_BYTES);
    return this.transport.run(options.signal, async signal => {
      let binary = '';
      for (const byte of snapshot) binary += String.fromCharCode(byte);
      const header = { summary: 'Store encrypted object',
        ...(options.condition.kind === 'revision' ? { parentCommit: options.condition.revision } : {}) };
      const body = `${JSON.stringify({ key: 'header', value: header })}\n${JSON.stringify({
        key: 'file', value: { path: `objects/${key}.enc`, encoding: 'base64', content: btoa(binary) },
      })}\n`;
      const response = await this.transport.request(new URL(
        `https://huggingface.co/api/datasets/${this.repository}/commit/${this.branch}`),
      { method: 'POST', headers: { 'Content-Type': 'application/x-ndjson' }, body }, signal);
      const result = record(await this.transport.json(response, signal));
      if (typeof result.commitOid !== 'string' || !SHA.test(result.commitOid)) throw new ProviderError('invalid-response');
      return { id: key, revision: result.commitOid };
    });
  }
  async get(id: string, signal?: AbortSignal): Promise<Ciphertext | null> {
    opaqueKey(id);
    return this.transport.run(signal, async bounded => {
      // raw serves Git blobs; LFS/Xet and redirecting download flows are deliberately out of scope.
      const response = await this.transport.request(new URL(
        `https://huggingface.co/datasets/${this.repository}/raw/${this.branch}/objects/${id}.enc`), {}, bounded);
      if (response.status === 404) { await response.body?.cancel(); return null; }
      return ciphertext(await this.transport.bytes(response, MAX_BYTES, bounded));
    });
  }
  async list(options: { cursor?: string; signal?: AbortSignal } = {}): Promise<ObjectPage> {
    const url = new URL(`https://huggingface.co/api/datasets/${this.repository}/tree/${this.branch}/objects`);
    url.searchParams.set('limit', String(PAGE_SIZE));
    if (options.cursor !== undefined) url.searchParams.set('cursor', cursorValue(options.cursor));
    return this.transport.run(options.signal, async signal => {
      const response = await this.transport.request(url, {}, signal);
      const data = await this.transport.json(response, signal);
      if (!Array.isArray(data) || data.length > PAGE_SIZE) throw new ProviderError('invalid-response');
      const objects = data.map(value => {
        const item = record(value);
        const match = typeof item.path === 'string' ? PATH.exec(item.path) : null;
        if (item.type !== 'file' || !match || item.lfs || item.xetHash) throw new ProviderError('invalid-response');
        return { id: match[1]!, key: match[1]!, size: objectSize(item.size, MAX_BYTES) };
      });
      const link = response.headers.get('Link');
      if (!link) return { objects };
      const next = link.split(',').find(part => /;\s*rel="next"\s*$/.test(part));
      if (!next) return { objects };
      const match = /^\s*<([^>]+)>;\s*rel="next"\s*$/.exec(next);
      if (!match) throw new ProviderError('invalid-response');
      const target = new URL(match[1]!, url);
      if (target.origin !== url.origin || target.pathname !== url.pathname || target.username ||
          target.password || target.hash || [...target.searchParams.keys()].some(key => !['cursor', 'limit'].includes(key))) {
        throw new ProviderError('invalid-response');
      }
      const cursor = target.searchParams.get('cursor');
      if (!cursor || cursor === options.cursor) throw new ProviderError('invalid-response');
      return { objects, cursor: cursorValue(cursor) };
    });
  }
}
