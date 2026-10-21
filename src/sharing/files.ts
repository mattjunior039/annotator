import { z } from 'zod';
import { invitationSchema, SHARE_BYTES } from './model';
import type { ShareInvitation } from './model';

const headerSchema = z.strictObject({ version: z.literal(1), id: z.uuid() });
const magic = new TextEncoder().encode('EAF1');
export const SHARE_FILE_BYTES = SHARE_BYTES + 1024;
export const PROPOSAL_FILE_BYTES = 8 * 1024 * 1024 + 16_384;

export function fileInvitation(id: string, key: string): ShareInvitation {
  return invitationSchema.parse({
    version: 1, id, key, transport: 'file', expires: null,
    download: `urn:annotator:file:${id}`, upload: `urn:annotator:file:${id}`,
  });
}

export function packShareFile(id: string, media: ArrayBuffer): ArrayBuffer {
  const header = new TextEncoder().encode(JSON.stringify(headerSchema.parse({ version: 1, id })));
  if (media.byteLength < 8 || media.byteLength > SHARE_BYTES) throw new Error('Encrypted snapshot exceeds its file size limit.');
  const bytes = new Uint8Array(8 + header.length + media.byteLength);
  bytes.set(magic);
  new DataView(bytes.buffer).setUint32(4, header.length);
  bytes.set(header, 8);
  bytes.set(new Uint8Array(media), 8 + header.length);
  return bytes.buffer;
}

export function unpackShareFile(bytes: ArrayBuffer, key: string): { invitation: ShareInvitation; media: ArrayBuffer } {
  if (bytes.byteLength < 16 || bytes.byteLength > SHARE_FILE_BYTES ||
      !magic.every((byte, index) => new Uint8Array(bytes)[index] === byte)) {
    throw new Error('Choose a supported encrypted .annotator-share file (maximum 64 MiB plus header).');
  }
  const length = new DataView(bytes).getUint32(4);
  if (length < 1 || length > 1016 || 8 + length + 8 > bytes.byteLength) throw new Error('Encrypted share file header is invalid.');
  const header = headerSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
    new Uint8Array(bytes, 8, length),
  )));
  return { invitation: fileInvitation(header.id, key.trim()), media: bytes.slice(8 + length) };
}

export async function readSharedFile(file: File, limit: number): Promise<ArrayBuffer> {
  if (!file.size || file.size > limit) throw new Error('The selected encrypted file is empty or exceeds its supported size.');
  return file.arrayBuffer();
}
