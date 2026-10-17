import { beforeAll, describe, expect, it } from 'vitest';
import { changeVaultPassphrase, CHUNK_BYTES, createDeviceKey, createVaultKey, hex, openDeviceKey, openObject, sealObject, unlockVaultKey } from './vault';

const workspaceId = crypto.randomUUID(), objectId = crypto.randomUUID();
let root: CryptoKey, wrapped: Awaited<ReturnType<typeof createVaultKey>>['wrapped'];
beforeAll(async () => { ({ root, wrapped } = await createVaultKey('a strong test passphrase', workspaceId)); });

describe('versioned vault format', () => {
  it('reopens a device-key workspace without pretending its locally stored key provides password protection', async () => {
    const { root, header } = await createDeviceKey(workspaceId);
    expect(root.extractable).toBe(false);
    expect(header.mode).toBe('device');
    expect(header.key).toHaveLength(64);
    const sealed = await sealObject(root, workspaceId, objectId, new TextEncoder().encode('local only'), 'record');
    const reopened = await openDeviceKey(JSON.parse(JSON.stringify(header)));
    expect(new TextDecoder().decode(await openObject(reopened, workspaceId, objectId, sealed, 'record'))).toBe('local only');
    await expect(openDeviceKey({ ...header, key: 'not a key' })).rejects.toThrow();
    const other = await createDeviceKey(workspaceId);
    await expect(openObject(other.root, workspaceId, objectId, sealed, 'record')).rejects.toThrow('authentication');
  });
  it('changes the wrapping passphrase without changing data keys and leaves the previous header untouched on failure', async () => {
    const previous = structuredClone(wrapped);
    const sealed = await sealObject(root, workspaceId, objectId, new TextEncoder().encode('saved data'), 'record');
    await expect(changeVaultPassphrase('incorrect passphrase', 'a different strong passphrase', wrapped)).rejects.toThrow('Unable to unlock');
    await expect(changeVaultPassphrase('a strong test passphrase', 'short', wrapped)).rejects.toThrow('Use a passphrase');
    expect(wrapped).toEqual(previous);
    const next = await changeVaultPassphrase('a strong test passphrase', 'a different strong passphrase', wrapped);
    expect(next.salt).not.toBe(wrapped.salt);
    expect(next.nonce).not.toBe(wrapped.nonce);
    expect(next.workspaceId).toBe(workspaceId);
    const changedRoot = await unlockVaultKey('a different strong passphrase', next);
    expect(changedRoot.extractable).toBe(false);
    expect(new TextDecoder().decode(await openObject(changedRoot, workspaceId, objectId, sealed, 'record'))).toBe('saved data');
    await expect(unlockVaultKey('a strong test passphrase', next)).rejects.toThrow('Unable to unlock');
    await expect(openObject(changedRoot, workspaceId, objectId,
      await sealObject(root, workspaceId, objectId, new Uint8Array(), 'backup-record'), 'record')).rejects.toThrow('binding');
  });
  it('wraps a non-extractable root, survives unlock, and rejects the wrong passphrase', async () => {
    expect(root.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', root)).rejects.toThrow();
    const sealed = await sealObject(root, workspaceId, objectId, new TextEncoder().encode('sensitive canary'), 'record');
    expect(new TextDecoder().decode(sealed)).not.toContain('sensitive canary');
    const unlocked = await unlockVaultKey('a strong test passphrase', wrapped);
    expect(new TextDecoder().decode(await openObject(unlocked, workspaceId, objectId, sealed, 'record'))).toBe('sensitive canary');
    await expect(openObject(unlocked, workspaceId, objectId, sealed, 'media')).rejects.toThrow('binding');
    await expect(unlockVaultKey('incorrect passphrase', wrapped)).rejects.toThrow('Unable to unlock');
    await expect(unlockVaultKey('a strong test passphrase', { ...wrapped, workspaceId: crypto.randomUUID() })).rejects.toThrow();
  });
  it.each([0, 1, CHUNK_BYTES, CHUNK_BYTES + 13])('round trips %i bytes with a final marker', async length => {
    const bytes = Uint8Array.from({ length }, (_, i) => i % 251);
    const sealed = await sealObject(root, workspaceId, objectId, bytes, 'record');
    expect(await openObject(root, workspaceId, objectId, sealed, 'record')).toEqual(bytes);
    await expect(openObject(root, workspaceId, objectId, sealed.slice(0, -1), 'record')).rejects.toThrow();
  });
  it('rejects corruption, binding substitution, trailing bytes, and chunk reordering', async () => {
    const sealed = await sealObject(root, workspaceId, objectId, new Uint8Array(CHUNK_BYTES * 2), 'record');
    const corrupt = sealed.slice(); corrupt[corrupt.length - 1]! ^= 1;
    await expect(openObject(root, workspaceId, objectId, corrupt, 'record')).rejects.toThrow('authentication');
    await expect(openObject(root, crypto.randomUUID(), objectId, sealed, 'record')).rejects.toThrow('binding');
    await expect(openObject(root, workspaceId, crypto.randomUUID(), sealed, 'record')).rejects.toThrow('binding');
    const extra = new Uint8Array(sealed.length + 1); extra.set(sealed);
    await expect(openObject(root, workspaceId, objectId, extra, 'record')).rejects.toThrow('Trailing');
    const start = 4 + new DataView(sealed.buffer).getUint32(0), frameLength = 12 + 4 + CHUNK_BYTES + 16;
    const reordered = sealed.slice();
    reordered.set(sealed.slice(start + frameLength, start + frameLength * 2), start);
    reordered.set(sealed.slice(start, start + frameLength), start + frameLength);
    await expect(openObject(root, workspaceId, objectId, reordered, 'record')).rejects.toThrow('authentication');
  });
  it('uses fresh object generations/salts and matches the NIST empty AES-GCM vector', async () => {
    const first = await sealObject(root, workspaceId, objectId, new Uint8Array(), 'record');
    const second = await sealObject(root, workspaceId, objectId, new Uint8Array(), 'record');
    expect(hex(first)).not.toBe(hex(second));
    const key = await crypto.subtle.importKey('raw', new Uint8Array(32), 'AES-GCM', false, ['encrypt']);
    expect(hex(new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: new Uint8Array(12), tagLength: 128 }, key, new Uint8Array(),
    )))).toBe('530f8afbc74536b9a963b4f1c4cb738b');
  });
});
