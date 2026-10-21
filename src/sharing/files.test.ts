import { describe, expect, it } from 'vitest';
import { fileInvitation, packShareFile, readSharedFile, SHARE_FILE_BYTES, unpackShareFile } from './files';
import { ShareArchive } from './archive';
import { invitationSchema } from './model';

describe('portable encrypted share files', () => {
  const id = crypto.randomUUID(), key = 'a'.repeat(43);
  it('carries only a public ID and opaque archive, not the separately sent secret', () => {
    const archive = new ShareArchive();
    archive.files.set('backup.json', new Uint8Array([1, 2]));
    archive.files.set('manifest.enc', new Uint8Array([3, 4]));
    const media = archive.pack(), packed = packShareFile(id, media);
    expect(new TextDecoder().decode(packed)).not.toContain(key);
    const result = unpackShareFile(packed, key);
    expect(result.media).toEqual(media);
    expect(result.invitation).toEqual(fileInvitation(id, key));
    expect(result.invitation.expires).toBeNull();
    expect(result.invitation.transport).toBe('file');
  });
  it('refuses network destinations or expiry suppression disguised as file invitations', () => {
    const invitation = fileInvitation(id, key);
    expect(() => invitationSchema.parse({ ...invitation, download: 'https://evil.example' })).toThrow();
    expect(() => invitationSchema.parse({ ...invitation, transport: 's3' })).toThrow();
    expect(() => invitationSchema.parse({ ...invitation, expires: new Date().toISOString() })).toThrow();
    expect(() => fileInvitation(id, 'short')).toThrow();
  });
  it('bounds file sizes and headers before reading or opening the archive', async () => {
    const packed = packShareFile(id, new ArrayBuffer(8));
    expect(() => unpackShareFile(packed.slice(0, 10), key)).toThrow();
    const damaged = packed.slice(0);
    new DataView(damaged).setUint32(4, 2000);
    expect(() => unpackShareFile(damaged, key)).toThrow('header');
    new Uint8Array(damaged)[0] = 0;
    expect(() => unpackShareFile(damaged, key)).toThrow('supported');
    expect(() => packShareFile(id, new ArrayBuffer(7))).toThrow('limit');
    await expect(readSharedFile(new File([], 'empty'), SHARE_FILE_BYTES)).rejects.toThrow('empty');
    const file = new File([new Uint8Array(packed)], 'share.annotator-share');
    await expect(readSharedFile(file, 1)).rejects.toThrow('size');
    expect(await readSharedFile(file, SHARE_FILE_BYTES)).toEqual(packed);
  });
});
