import { concatBytes } from './encoding';

const encoder = new TextEncoder(), decoder = new TextDecoder();
export const CHUNK_BYTES = 16 * 1024 - 64;
export const MAX_MESSAGE_BYTES = 24 * 1024 * 1024;
const MAX_PARTIAL_MESSAGES = 4;
const MAX_ATTACHMENTS = 1024;

// JSON body with ArrayBuffers lifted into length-prefixed binary attachments.
export function encodeMessage(value: unknown): Uint8Array<ArrayBuffer> {
  const attachments: Uint8Array[] = [];
  const json = JSON.stringify(value, (_key, item: unknown) => {
    if (item instanceof ArrayBuffer) {
      attachments.push(new Uint8Array(item));
      return { $bin: attachments.length - 1 };
    }
    return item;
  });
  const body = encoder.encode(json);
  const parts: Uint8Array[] = [];
  const head = new Uint8Array(8);
  new DataView(head.buffer).setUint32(0, body.length);
  new DataView(head.buffer).setUint32(4, attachments.length);
  parts.push(head, body);
  for (const attachment of attachments) {
    const size = new Uint8Array(4);
    new DataView(size.buffer).setUint32(0, attachment.length);
    parts.push(size, attachment);
  }
  const output = concatBytes(...parts);
  if (output.length > MAX_MESSAGE_BYTES) throw new Error('Live-session message is too large.');
  return output;
}

export function decodeMessage(bytes: Uint8Array): unknown {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8) throw new Error('Truncated live-session message.');
  const bodyLength = view.getUint32(0), count = view.getUint32(4);
  if (count > MAX_ATTACHMENTS || 8 + bodyLength > bytes.length) throw new Error('Malformed live-session message.');
  const attachments: ArrayBuffer[] = [];
  let offset = 8 + bodyLength;
  for (let index = 0; index < count; index++) {
    if (offset + 4 > bytes.length) throw new Error('Malformed live-session attachment.');
    const length = view.getUint32(offset);
    offset += 4;
    if (offset + length > bytes.length) throw new Error('Malformed live-session attachment.');
    attachments.push(bytes.slice(offset, offset + length).buffer);
    offset += length;
  }
  if (offset !== bytes.length) throw new Error('Trailing bytes in live-session message.');
  const used = new Set<number>();
  return JSON.parse(decoder.decode(bytes.subarray(8, 8 + bodyLength)), (_key, item: unknown) => {
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      const keys = Object.keys(item);
      const index = (item as { $bin?: unknown }).$bin;
      if (keys.length === 1 && keys[0] === '$bin') {
        if (typeof index !== 'number' || !Number.isInteger(index) || !attachments[index] || used.has(index)) {
          throw new Error('Invalid live-session attachment reference.');
        }
        used.add(index);
        return attachments[index];
      }
    }
    return item;
  });
}

// Chunk: [32-bit message id][32-bit index][32-bit count][data].
export function chunkMessage(messageId: number, bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>[] {
  const count = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (let index = 0; index < count; index++) {
    const header = new Uint8Array(12), view = new DataView(header.buffer);
    view.setUint32(0, messageId); view.setUint32(4, index); view.setUint32(8, count);
    chunks.push(concatBytes(header, bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES)));
  }
  return chunks;
}

interface Partial { parts: Uint8Array[]; received: number; count: number; bytes: number }

export class Reassembler {
  private readonly partial = new Map<number, Partial>();

  // Returns a complete message, or null while more chunks are pending.
  accept(chunk: Uint8Array): Uint8Array<ArrayBuffer> | null {
    if (chunk.length < 12 || chunk.length > CHUNK_BYTES + 12) throw new Error('Invalid live-session chunk.');
    const view = new DataView(chunk.buffer, chunk.byteOffset, 12);
    const id = view.getUint32(0), index = view.getUint32(4), count = view.getUint32(8);
    if (count < 1 || count > Math.ceil(MAX_MESSAGE_BYTES / CHUNK_BYTES) || index >= count) throw new Error('Invalid live-session chunk.');
    let message = this.partial.get(id);
    if (!message) {
      if (this.partial.size >= MAX_PARTIAL_MESSAGES) throw new Error('Too many incomplete live-session messages.');
      message = { parts: new Array<Uint8Array>(count), received: 0, count, bytes: 0 };
      this.partial.set(id, message);
    }
    if (message.count !== count || message.parts[index]) throw new Error('Inconsistent live-session chunk.');
    const data = chunk.slice(12);
    message.parts[index] = data;
    message.received++;
    message.bytes += data.length;
    if (message.bytes > MAX_MESSAGE_BYTES) throw new Error('Live-session message is too large.');
    if (message.received < count) return null;
    this.partial.delete(id);
    return concatBytes(...message.parts);
  }
}
