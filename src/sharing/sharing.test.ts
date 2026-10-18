import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { documentSchema } from '../domain/model';
import { BackupReader, BackupWriter } from '../storage/backup';
import { toBase64Url } from '../collaboration/encoding';
import { ShareArchive } from './archive';
import { decryptProposal, encryptProposal, maskDigest, mergeProposal } from './proposal';
import { createS3Capabilities, downloadEncrypted, parseShareLink, shareLink, uploadEncrypted } from './s3';
import type { ShareInvitation, ShareProposal } from './model';
import { MAX_OBJECT_BYTES } from '../crypto/vault';

function fixture() {
  const classId = crypto.randomUUID();
  const base = documentSchema.parse({
    version: 1, revision: 0, review: 'unannotated',
    image: { version: 1, id: crypto.randomUUID(), datasetId: crypto.randomUUID(), mediaId: crypto.randomUUID(),
      name: 'private-canary.png', source: { width: 30, height: 20 }, canonical: { width: 30, height: 20 }, orientation: 1 },
    classes: [{ id: classId, name: 'private class', color: '#39764d', exclusiveGroup: null }],
    skeletons: [], annotations: [],
  });
  const box = { id: crypto.randomUUID(), classId, kind: 'box' as const, x: 1, y: 2, width: 4, height: 5, attributes: {} };
  const invitation: ShareInvitation = {
    version: 1, id: crypto.randomUUID(), key: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
    download: 'https://app.example/bucket/snapshot.enc?signature=download',
    upload: 'https://app.example/bucket/proposal.enc?signature=upload', expires: new Date(Date.now() + 86_400_000).toISOString(),
  };
  return { base, box, invitation };
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('encrypted snapshot and proposal contracts', () => {
  it('packs an existing encrypted backup without plaintext and verifies its media, schema and exact annotations', async () => {
    const { base, box } = fixture();
    base.annotations.push(box);
    const png = await sharp({ create: { width: 30, height: 20, channels: 4, background: '#123456' } }).png().toBuffer();
    const chunks = [png.subarray(0, 8)];
    for (let offset = 8; offset < png.length;) {
      const end = offset + 12 + png.readUInt32BE(offset);
      if (['IHDR', 'IDAT', 'IEND'].includes(png.toString('ascii', offset + 4, offset + 8))) chunks.push(png.subarray(offset, end));
      offset = end;
    }
    const media = new Uint8Array(Buffer.concat(chunks)), archive = new ShareArchive();
    const schema = { version: 1 as const, revision: 0, classes: base.classes, skeletons: [] };
    const writer = await BackupWriter.create(archive, 'random independent snapshot secret', schema);
    await writer.append({ document: base, sourcePath: 'private/path.png', split: 'train' }, media);
    await writer.finish();
    const packed = archive.pack(), text = new TextDecoder().decode(packed);
    for (const secret of ['private-canary', 'private class', 'private/path', '"annotations"']) expect(text).not.toContain(secret);
    const reader = await BackupReader.open(ShareArchive.unpack(packed), 'random independent snapshot secret');
    expect(reader.id).toBe(writer.id);
    expect(reader.schema).toEqual(schema);
    expect((await reader.read(0)).record.document).toEqual(base);
    expect((await reader.read(0)).media).toEqual(media);
    await expect(BackupReader.open(ShareArchive.unpack(packed), 'incorrect snapshot secret')).rejects.toThrow('unlock');
    const damaged = ShareArchive.unpack(packed);
    const manifest = damaged.files.get('manifest.enc')!;
    manifest[manifest.length - 1] = manifest[manifest.length - 1]! ^ 1;
    await expect(BackupReader.open(damaged, 'random independent snapshot secret')).rejects.toThrow();
  });
  it('rejects truncated containers, trailing data, duplicate objects and oversized encrypted objects', async () => {
    const archive = new ShareArchive();
    archive.files.set('backup.json', new Uint8Array([1]));
    archive.files.set('manifest.enc', new Uint8Array([2]));
    const packed = archive.pack();
    expect(() => ShareArchive.unpack(packed.slice(0, -1))).toThrow('bounds');
    const trailing = new Uint8Array(packed.byteLength + 1); trailing.set(new Uint8Array(packed));
    expect(() => ShareArchive.unpack(trailing.buffer)).toThrow('trailing');
    const duplicate = new ShareArchive();
    duplicate.files.set('backup.json', new Uint8Array([1]));
    duplicate.files.set('manifest.enc', new Uint8Array([2]));
    const bytes = new Uint8Array(duplicate.pack());
    const name = new TextEncoder().encode('backup.json');
    const second = 8 + 8 + name.length + 1 + 8;
    bytes.set(name, second);
    expect(() => ShareArchive.unpack(bytes.buffer)).toThrow();
    expect(() => ShareArchive.unpack(new ArrayBuffer(64 * 1024 * 1024 + 1))).toThrow('size');
  });
  it('authenticates proposals and binds them to an invitation', async () => {
    const { base, box, invitation } = fixture(), next = structuredClone(base);
    next.annotations.push(box);
    const proposal: ShareProposal = { version: 1, shareId: invitation.id, author: 'Riley', message: 'Add a box', changes: [{ base, next }] };
    const bytes = await encryptProposal(invitation, proposal);
    expect(new TextDecoder().decode(bytes)).not.toContain('private-canary');
    expect(await decryptProposal(invitation, bytes)).toEqual(proposal);
    const damaged = bytes.slice(0), tampered = new Uint8Array(damaged);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    await expect(decryptProposal(invitation, damaged)).rejects.toThrow();
    await expect(decryptProposal({ ...invitation, id: crypto.randomUUID() }, bytes)).rejects.toThrow();
    await expect(decryptProposal({ ...invitation, key: fixture().invitation.key }, bytes)).rejects.toThrow();
  });
  it('merges disjoint annotations and preserves the owner revision and edits', () => {
    const { base, box } = fixture(), next = structuredClone(base), latest = structuredClone(base);
    next.annotations.push(box);
    const ownerBox = { ...box, id: crypto.randomUUID(), x: 10 };
    latest.annotations.push(ownerBox); latest.revision = 7;
    const merged = mergeProposal(base, next, latest);
    expect(merged.annotations).toEqual([ownerBox, box]);
    expect(merged.revision).toBe(8);
    expect(latest.annotations).toEqual([ownerBox]);
    expect(mergeProposal(base, next, merged)).toEqual(merged);
  });
  it('rejects same-annotation edit/delete conflicts, schema changes and mask proposals', () => {
    const { base, box } = fixture(); base.annotations.push(box);
    const next = structuredClone(base), latest = structuredClone(base);
    next.annotations[0] = { ...box, x: 3 };
    latest.annotations[0] = { ...box, x: 9 };
    expect(() => mergeProposal(base, next, latest)).toThrow('also edited');
    latest.annotations = [];
    expect(() => mergeProposal(base, next, latest)).toThrow('also edited');
    const schemaChange = structuredClone(base); schemaChange.classes[0]!.name = 'different';
    expect(() => mergeProposal(base, schemaChange, base)).toThrow('schema');
    const mask = { id: crypto.randomUUID(), classId: box.classId, kind: 'mask' as const,
      width: 30, height: 20, tileSize: 256 as const, tiles: [], attributes: {} };
    const masked = structuredClone(base); masked.annotations.push(mask);
    expect(() => mergeProposal(base, masked, base)).toThrow('Mask');
  });
  it('recognizes unchanged mask pixels after import or key rotation rebinds tile IDs', async () => {
    const first = crypto.randomUUID(), second = crypto.randomUUID();
    const mask = { id: crypto.randomUUID(), classId: crypto.randomUUID(), kind: 'mask' as const,
      width: 30, height: 20, tileSize: 256 as const, tiles: [{ x: 0, y: 0, blobId: first }], attributes: {} };
    const pixels = new Uint8Array(256 * 256); pixels[0] = 1;
    const original = await maskDigest(mask, [{ id: first, pixels: pixels.buffer }]);
    const rebound = { ...mask, tiles: [{ x: 0, y: 0, blobId: second }] };
    expect(await maskDigest(rebound, [{ id: second, pixels: pixels.buffer }])).toBe(original);
    pixels[1] = 1;
    expect(await maskDigest(rebound, [{ id: second, pixels: pixels.buffer }])).not.toBe(original);
  });
});

describe('S3 capabilities and disclosure boundaries', () => {
  function location() { vi.stubGlobal('window', { location: { origin: 'https://app.example', pathname: '/annotator/' } }); }
  it('signs fixed GET and create-only PUT capabilities for exactly 24 hours without a secret key in the URLs', async () => {
    location(); vi.stubEnv('VITE_S3_ORIGINS', 'https://s3.example');
    const id = crypto.randomUUID();
    const caps = await createS3Capabilities({ endpoint: 'https://s3.example', bucket: 'test-bucket', region: 'us-east-1',
      accessKeyId: 'TESTACCESS', secretAccessKey: 'never-share-this-secret', sessionToken: 'temporary-token' }, id);
    for (const value of [caps.snapshotPut, caps.download, caps.upload, caps.reviewUrl]) {
      const url = new URL(value);
      expect(url.searchParams.get('X-Amz-Expires')).toBe('86400');
      expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
      expect(url.searchParams.get('X-Amz-Security-Token')).toBe('temporary-token');
      expect(url.pathname).toContain(`/test-bucket/annotator-shares/${id}/`);
      expect(value).not.toContain('never-share-this-secret');
    }
    expect(new URL(caps.upload).searchParams.get('X-Amz-SignedHeaders')).toBe('host;if-none-match');
    expect(new URL(caps.download).searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(new URL(caps.upload).searchParams.get('X-Amz-Signature')).not.toBe(new URL(caps.reviewUrl).searchParams.get('X-Amz-Signature'));
  });
  it('keeps secrets in the fragment and refuses expired or unapproved-origin links without fetching', async () => {
    location();
    const { invitation } = fixture(), link = shareLink(invitation);
    expect(new URL(link).pathname).toBe('/annotator/');
    expect(new URL(link).search).toBe('');
    expect(parseShareLink(link)).toEqual(invitation);
    expect(() => parseShareLink(shareLink({ ...invitation, expires: '2020-01-01T00:00:00.000Z' }))).toThrow('expired');
    expect(() => parseShareLink(shareLink({ ...invitation, download: 'https://unapproved.example/secret' }))).toThrow('not allowed');
    expect(() => parseShareLink(link.replace('https://app.example/', 'https://evil.example/'))).toThrow('this app');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(downloadEncrypted('https://unapproved.example/secret')).rejects.toThrow('not allowed');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uploads only ciphertext with create-only writes, and makes expiry, replay and oversized downloads explicit', async () => {
    location();
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 })); vi.stubGlobal('fetch', fetch);
    await uploadEncrypted('https://app.example/put', new ArrayBuffer(10));
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: 'PUT', credentials: 'omit', redirect: 'error', headers: { 'If-None-Match': '*' } });
    fetch.mockResolvedValueOnce(new Response(null, { status: 412 }));
    await expect(uploadEncrypted('https://app.example/put', new ArrayBuffer(10))).rejects.toThrow('already has');
    fetch.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(downloadEncrypted('https://app.example/get')).rejects.toThrow('403');
    fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await downloadEncrypted('https://app.example/get')).toBeNull();
    fetch.mockResolvedValueOnce(new Response(new Uint8Array(MAX_OBJECT_BYTES + 1)));
    await expect(downloadEncrypted('https://app.example/get', MAX_OBJECT_BYTES)).rejects.toThrow('size');
    fetch.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
    expect(new Uint8Array((await downloadEncrypted('https://app.example/get'))!)).toEqual(new Uint8Array([1, 2, 3]));
  });
});
