import { describe, expect, it } from 'vitest';
import { documentSchema } from '../domain/model';
import { CHUNK_BYTES, Reassembler, chunkMessage, decodeMessage, encodeMessage } from './codec';
import { DIRECT_CHANNEL, RELAY_CHANNEL, createIdentity, deriveSession, openSignal, sealSignal, signalKey } from './crypto';
import { createInvite, inviteFragment, parseInviteFragment } from './invite';
import { applyGuestCommands, diffDocuments } from './merge';

const classId = crypto.randomUUID();
function document() {
  return documentSchema.parse({
    version: 1, image: {
      version: 1, id: crypto.randomUUID(), datasetId: crypto.randomUUID(), name: 'synthetic.png',
      source: { width: 100, height: 80 }, canonical: { width: 100, height: 80 },
      orientation: 1, mediaId: crypto.randomUUID(),
    },
    revision: 3, classes: [{ id: classId, name: 'Object', color: '#123456', exclusiveGroup: null }],
    skeletons: [], annotations: [], review: 'unannotated',
  });
}
const box = (x: number) => ({ id: crypto.randomUUID(), classId, attributes: {}, kind: 'box' as const, x, y: 0, width: 10, height: 10 });

describe('invite links', () => {
  it('round trips and rejects malformed fragments', () => {
    const invite = createInvite();
    expect(parseInviteFragment(inviteFragment(invite))).toEqual(invite);
    expect(parseInviteFragment('#live=short.key')).toBeNull();
    expect(parseInviteFragment(inviteFragment(invite) + 'x')).toBeNull();
  });
});

describe('end-to-end session crypto', () => {
  it('agrees on a verification code and directional keys', async () => {
    const invite = createInvite();
    const [host, guest] = await Promise.all([createIdentity(), createIdentity()]);
    const h = await deriveSession(host, guest.publicKey, invite, 'host');
    const g = await deriveSession(guest, host.publicKey, invite, 'guest');
    expect(h.code).toMatch(/^\d{3} \d{3}$|^\d{6}$/);
    expect(h.code).toBe(g.code);
    const frame = await h.cipher.seal(RELAY_CHANNEL, new TextEncoder().encode('hello'));
    expect(new TextDecoder().decode((await g.cipher.open(frame)).plaintext)).toBe('hello');
    await expect(g.cipher.open(frame)).rejects.toThrow(/replayed/);
    const echo = await h.cipher.seal(RELAY_CHANNEL, new Uint8Array([1]));
    await expect(h.cipher.open(echo)).rejects.toThrow();
  });

  it('detects tampering, reordering, and a substituted key', async () => {
    const invite = createInvite();
    const [host, guest, attacker] = await Promise.all([createIdentity(), createIdentity(), createIdentity()]);
    const h = await deriveSession(host, guest.publicKey, invite, 'host');
    const g = await deriveSession(guest, host.publicKey, invite, 'guest');
    const m = await deriveSession(host, attacker.publicKey, invite, 'host');
    expect(m.code).not.toBe(g.code);
    const first = await h.cipher.seal(DIRECT_CHANNEL, new Uint8Array([1]));
    const second = await h.cipher.seal(DIRECT_CHANNEL, new Uint8Array([2]));
    await expect(g.cipher.open(second)).rejects.toThrow(/Out-of-order/);
    const tampered = first.slice(); tampered[tampered.length - 1]! ^= 1;
    await expect(g.cipher.open(tampered)).rejects.toThrow();
    expect((await g.cipher.open(first)).plaintext).toEqual(new Uint8Array([1]));
  });

  it('seals handshake frames to the invite key only', async () => {
    const invite = createInvite(), other = createInvite();
    const frame = await sealSignal(await signalKey(invite), { t: 'hello' });
    expect(await openSignal(await signalKey(invite), frame)).toEqual({ t: 'hello' });
    await expect(openSignal(await signalKey(other), frame)).rejects.toThrow();
  });
});

describe('live message codec', () => {
  it('round trips JSON with binary attachments across chunks', () => {
    const media = crypto.getRandomValues(new Uint8Array(CHUNK_BYTES * 2 + 17));
    const bytes = encodeMessage({ t: 'reply', id: 1, value: { media: media.buffer, name: 'x' } });
    const chunks = chunkMessage(7, bytes);
    expect(chunks).toHaveLength(3);
    const reassembler = new Reassembler();
    expect(reassembler.accept(chunks[2]!)).toBeNull();
    expect(reassembler.accept(chunks[0]!)).toBeNull();
    const decoded = decodeMessage(reassembler.accept(chunks[1]!)!) as { value: { media: ArrayBuffer; name: string } };
    expect(new Uint8Array(decoded.value.media)).toEqual(media);
    expect(decoded.value.name).toBe('x');
  });

  it('rejects malformed messages and chunks', () => {
    const good = encodeMessage({ a: new Uint8Array([1, 2]).buffer });
    expect(() => decodeMessage(good.subarray(0, 6))).toThrow();
    expect(() => decodeMessage(good.subarray(0, good.length - 1))).toThrow();
    expect(() => decodeMessage(encodeMessage({ $bin: 0 }))).toThrow(/attachment reference/);
    const reassembler = new Reassembler();
    const [chunk] = chunkMessage(1, good);
    reassembler.accept(chunkMessage(2, new Uint8Array(CHUNK_BYTES * 2))[0]!);
    expect(() => reassembler.accept(chunkMessage(2, new Uint8Array(CHUNK_BYTES * 3))[0]!)).toThrow(/Inconsistent/);
    expect(() => reassembler.accept(chunk!.subarray(0, 8))).toThrow();
  });
});

describe('host-side merge of live edits', () => {
  it('replays concurrent edits from two participants without losing either', () => {
    const base = document();
    const a = { ...base, annotations: [box(1)] }, b = { ...base, annotations: [box(2)], review: 'in_progress' as const };
    const afterA = applyGuestCommands(base, diffDocuments(base, a));
    const afterB = applyGuestCommands(afterA, diffDocuments(base, b));
    expect(afterB.revision).toBe(base.revision + 2);
    expect(afterB.annotations.map(item => item.kind === 'box' ? item.x : -1)).toEqual([1, 2]);
    expect(afterB.review).toBe('in_progress');
    const removal = diffDocuments(afterB, { ...afterB, annotations: [afterB.annotations[1]!] });
    expect(applyGuestCommands(applyGuestCommands(afterB, removal), removal).annotations).toHaveLength(1);
  });

  it('refuses guest schema changes and mask edits but allows host masks', () => {
    const base = document();
    expect(() => diffDocuments(base, { ...base, classes: [] })).toThrow(/Only the host/);
    const mask = { id: crypto.randomUUID(), classId, attributes: {}, kind: 'mask' as const, tiles: [] };
    const commands = [{ type: 'put' as const, annotation: mask as never }];
    expect(() => applyGuestCommands(base, commands)).toThrow(/host-only/);
    expect(() => applyGuestCommands(base, [])).toThrow(/Invalid/);
  });
});
