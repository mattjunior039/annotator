import { z } from 'zod';

export const KDF_ITERATIONS = 600_000;
export const CHUNK_BYTES = 64 * 1024;
export const MAX_OBJECT_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const hexSchema = (bytes: number) => z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`));
export const wrappedKeySchema = z.strictObject({
  version: z.literal(1), workspaceId: z.uuid(), algorithm: z.literal('PBKDF2-SHA256'),
  iterations: z.number().int().min(KDF_ITERATIONS).max(2_000_000),
  salt: hexSchema(16), nonce: hexSchema(12), wrapped: hexSchema(48),
});
export type WrappedKey = z.infer<typeof wrappedKeySchema>;
export const deviceKeySchema = z.strictObject({
  version: z.literal(1), mode: z.literal('device'), workspaceId: z.uuid(), key: hexSchema(32),
});
export async function createDeviceKey(workspaceId: string) {
  const raw = random(32);
  try {
    const header = deviceKeySchema.parse({ version: 1, mode: 'device', workspaceId, key: hex(raw) });
    const root = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
    return { root, header };
  } finally { raw.fill(0); }
}
export async function openDeviceKey(input: unknown) {
  const header = deviceKeySchema.parse(input), raw = unhex(header.key);
  try { return await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']); }
  finally { raw.fill(0); }
}
export type ObjectPurpose = 'record' | 'media' | 'schema' | 'backup-record' | 'backup-media' | 'backup-manifest';
const headerSchema = z.strictObject({
  version: z.literal(1), workspaceId: z.uuid(), objectId: z.uuid(),
  generation: z.uuid(), salt: hexSchema(16), chunkBytes: z.literal(CHUNK_BYTES),
  length: z.number().int().min(0).max(MAX_OBJECT_BYTES),
  chunks: z.number().int().min(0).max(MAX_OBJECT_BYTES / CHUNK_BYTES),
  contentType: z.literal('application/octet-stream'),
  purpose: z.enum(['record', 'media', 'schema', 'backup-record', 'backup-media', 'backup-manifest']),
});

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
function unhex(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value.match(/../g) ?? [], h => Number.parseInt(h, 16));
}
function random(bytes: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(bytes));
}
function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const p of parts) { result.set(p, offset); offset += p.byteLength; }
  return result;
}
function u32(value: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}
function wrappingAAD(meta: Omit<WrappedKey, 'wrapped'>): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify(meta));
}
async function passphraseKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  if (passphrase.length < 12 || passphrase.length > 1024) throw new Error('Use a passphrase of 12 to 1024 characters.');
  const bytes = encoder.encode(passphrase);
  try {
    const key = await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveKey']);
    return await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
  } finally { bytes.fill(0); }
}
async function wrapRoot(passphrase: string, workspaceId: string, raw: Uint8Array<ArrayBuffer>): Promise<WrappedKey> {
  z.uuid().parse(workspaceId);
  const salt = random(16), nonce = random(12);
  const meta: Omit<WrappedKey, 'wrapped'> = {
    version: 1, workspaceId, algorithm: 'PBKDF2-SHA256', iterations: KDF_ITERATIONS,
    salt: hex(salt), nonce: hex(nonce),
  };
  const kek = await passphraseKey(passphrase, salt, KDF_ITERATIONS);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: wrappingAAD(meta), tagLength: 128 }, kek, raw,
  );
  return { ...meta, wrapped: hex(new Uint8Array(encrypted)) };
}
export async function createVaultKey(passphrase: string, workspaceId: string): Promise<{ root: CryptoKey; wrapped: WrappedKey }> {
  const raw = random(32);
  try {
    const wrapped = await wrapRoot(passphrase, workspaceId, raw);
    const root = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
    return { root, wrapped };
  } finally { raw.fill(0); }
}
async function unwrapRoot(passphrase: string, input: unknown): Promise<Uint8Array<ArrayBuffer>> {
  const { wrapped, ...meta } = wrappedKeySchema.parse(input);
  const kek = await passphraseKey(passphrase, unhex(meta.salt), meta.iterations);
  try {
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unhex(meta.nonce), additionalData: wrappingAAD(meta), tagLength: 128 },
      kek, unhex(wrapped),
    ));
  } catch { throw new Error('Unable to unlock: wrong passphrase or damaged vault header.'); }
}
export async function unlockVaultKey(passphrase: string, input: unknown): Promise<CryptoKey> {
  const raw = await unwrapRoot(passphrase, input);
  try { return await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']); }
  finally { raw.fill(0); }
}
export async function changeVaultPassphrase(current: string, next: string, input: unknown): Promise<WrappedKey> {
  const previous = wrappedKeySchema.parse(input);
  const raw = await unwrapRoot(current, previous);
  try { return await wrapRoot(next, previous.workspaceId, raw); }
  finally { raw.fill(0); }
}
async function objectKey(root: CryptoKey, header: z.infer<typeof headerSchema>): Promise<CryptoKey> {
  return crypto.subtle.deriveKey({
    name: 'HKDF', hash: 'SHA-256', salt: unhex(header.salt),
    info: encoder.encode(`annotator/v1/${header.purpose}/${header.workspaceId}/${header.objectId}/${header.generation}`),
  }, root, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
function aad(header: Uint8Array, index: number, final: boolean): Uint8Array<ArrayBuffer> {
  return concat([header, encoder.encode(`|${index}|${final ? 'final' : 'chunk'}`)]);
}

export async function sealObject(
  root: CryptoKey, workspaceId: string, objectId: string, plaintext: Uint8Array<ArrayBuffer>,
  purpose: ObjectPurpose,
): Promise<Uint8Array<ArrayBuffer>> {
  const header = headerSchema.parse({
    version: 1, workspaceId, objectId, generation: crypto.randomUUID(), salt: hex(random(16)),
    chunkBytes: CHUNK_BYTES, length: plaintext.byteLength,
    chunks: Math.ceil(plaintext.byteLength / CHUNK_BYTES), contentType: 'application/octet-stream', purpose,
  });
  const encoded = encoder.encode(JSON.stringify(header)), key = await objectKey(root, header);
  const parts: Uint8Array[] = [u32(encoded.byteLength), encoded], nonces = new Set<string>();
  for (let i = 0; i <= header.chunks; i++) {
    let nonce = random(12);
    while (nonces.has(hex(nonce))) nonce = random(12);
    nonces.add(hex(nonce));
    const final = i === header.chunks;
    const chunk = final ? encoder.encode('complete') : plaintext.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
      name: 'AES-GCM', iv: nonce, additionalData: aad(encoded, i, final), tagLength: 128,
    }, key, chunk));
    parts.push(nonce, u32(ciphertext.byteLength), ciphertext);
  }
  return concat(parts);
}

export async function openObject(
  root: CryptoKey, workspaceId: string, objectId: string, envelope: Uint8Array<ArrayBuffer>,
  purpose: ObjectPurpose,
): Promise<Uint8Array<ArrayBuffer>> {
  if (envelope.byteLength > MAX_OBJECT_BYTES + 16_384) throw new Error('Encrypted object exceeds spike limits.');
  let offset = 0;
  const take = (length: number): Uint8Array<ArrayBuffer> => {
    if (length < 0 || offset + length > envelope.byteLength) throw new Error('Truncated encrypted object.');
    const result = envelope.slice(offset, offset + length); offset += length; return result;
  };
  const length = new DataView(take(4).buffer).getUint32(0);
  if (length > 2048) throw new Error('Invalid encrypted header length.');
  const encoded = take(length), header = headerSchema.parse(JSON.parse(decoder.decode(encoded)));
  if (header.workspaceId !== workspaceId || header.objectId !== objectId || header.purpose !== purpose ||
      header.chunks !== Math.ceil(header.length / CHUNK_BYTES)) throw new Error('Encrypted object binding mismatch.');
  const key = await objectKey(root, header), chunks: Uint8Array[] = [], nonces = new Set<string>();
  for (let i = 0; i <= header.chunks; i++) {
    const final = i === header.chunks, nonce = take(12);
    if (nonces.has(hex(nonce))) throw new Error('Repeated nonce in encrypted object.');
    nonces.add(hex(nonce));
    const ciphertextLength = new DataView(take(4).buffer).getUint32(0);
    const expectedLength = final ? 8 : Math.min(CHUNK_BYTES, header.length - i * CHUNK_BYTES);
    if (ciphertextLength !== expectedLength + 16) throw new Error('Invalid encrypted chunk length.');
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = new Uint8Array(await crypto.subtle.decrypt({
        name: 'AES-GCM', iv: nonce, additionalData: aad(encoded, i, final), tagLength: 128,
      }, key, take(ciphertextLength)));
    } catch { throw new Error('Encrypted object authentication failed.'); }
    if (final) {
      if (decoder.decode(bytes) !== 'complete') throw new Error('Invalid final authentication marker.');
    } else chunks.push(bytes);
  }
  if (offset !== envelope.byteLength) throw new Error('Trailing data in encrypted object.');
  return concat(chunks);
}
