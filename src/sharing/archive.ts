import type { ArchiveDirectory } from '../storage/backup';
import { SHARE_BYTES } from './model';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const allowedName = /^(?:backup\.json|manifest\.enc|[0-9a-f-]{36}\.(?:record|media|mask)\.enc)$/;

// This bounded binary container carries only the existing encrypted backup format.
export class ShareArchive implements ArchiveDirectory {
  readonly files = new Map<string, Uint8Array<ArrayBuffer>>();
  private bytes = 0;

  async getFileHandle(name: string, options?: { create: boolean }) {
    if (!allowedName.test(name)) throw new Error('Workspace share contains an invalid object name.');
    if (!options?.create && !this.files.has(name)) throw new DOMException('Missing encrypted share object.', 'NotFoundError');
    return {
      getFile: async () => new Blob([this.files.get(name)!]),
      createWritable: async () => ({
        write: async (data: Uint8Array<ArrayBuffer>) => {
          const size = this.bytes - (this.files.get(name)?.length ?? 0) + data.length;
          if (size > SHARE_BYTES - 1024 * 1024) throw new Error('Workspace share exceeds the 64 MiB encrypted snapshot limit.');
          this.files.set(name, data.slice());
          this.bytes = size;
        },
        close: async () => {}, abort: async () => {},
      }),
    };
  }

  pack(): ArrayBuffer {
    const size = 8 + [...this.files].reduce((sum, [name, bytes]) => sum + 8 + encoder.encode(name).length + bytes.length, 0);
    if (size > SHARE_BYTES) throw new Error('Workspace share exceeds 64 MiB.');
    const result = new Uint8Array(size), view = new DataView(result.buffer);
    result.set(encoder.encode('EAS1'));
    view.setUint32(4, this.files.size);
    let offset = 8;
    for (const [name, bytes] of this.files) {
      const label = encoder.encode(name);
      view.setUint32(offset, label.length); view.setUint32(offset + 4, bytes.length); offset += 8;
      result.set(label, offset); offset += label.length;
      result.set(bytes, offset); offset += bytes.length;
    }
    return result.buffer;
  }

  static unpack(buffer: ArrayBuffer): ShareArchive {
    if (buffer.byteLength < 8 || buffer.byteLength > SHARE_BYTES) throw new Error('Workspace share has an invalid size.');
    const bytes = new Uint8Array(buffer), view = new DataView(buffer);
    if (decoder.decode(bytes.subarray(0, 4)) !== 'EAS1') throw new Error('Workspace share format is unsupported.');
    const count = view.getUint32(4);
    if (count < 2 || count > 40_002) throw new Error('Workspace share object count is invalid.');
    const archive = new ShareArchive();
    let offset = 8;
    for (let i = 0; i < count; i++) {
      if (offset + 8 > bytes.length) throw new Error('Workspace share is truncated.');
      const nameLength = view.getUint32(offset), length = view.getUint32(offset + 4); offset += 8;
      if (nameLength > 100 || length > 8 * 1024 * 1024 + 16_384 || offset + nameLength + length > bytes.length) {
        throw new Error('Workspace share object exceeds its bounds.');
      }
      const name = decoder.decode(bytes.subarray(offset, offset + nameLength)); offset += nameLength;
      if (!allowedName.test(name) || archive.files.has(name)) throw new Error('Workspace share has invalid or duplicate objects.');
      archive.files.set(name, bytes.slice(offset, offset + length)); offset += length;
    }
    if (offset !== bytes.length || !archive.files.has('backup.json') || !archive.files.has('manifest.enc')) {
      throw new Error('Workspace share is incomplete or has trailing data.');
    }
    return archive;
  }
}
