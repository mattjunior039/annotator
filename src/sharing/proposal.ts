import { hex, openObject, sealObject } from '../crypto/vault';
import { fromBase64Url } from '../collaboration/encoding';
import { documentSchema } from '../domain/model';
import type { AnnotationDocument } from '../domain/model';
import { ImageHistory } from '../domain/history';
import type { Mask, MaskTile } from '../domain/masks';
import { proposalSchema } from './model';
import type { ShareInvitation, ShareProposal } from './model';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const comparable = (value: unknown) => JSON.stringify(value, (_key, item: unknown) =>
  item !== null && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export const same = (a: unknown, b: unknown) => comparable(a) === comparable(b);
export async function maskDigest(mask: Mask, tiles: readonly MaskTile[]) {
  const pixels = new Map(tiles.map(tile => [tile.id, tile.pixels]));
  const normalized = { ...mask, tiles: await Promise.all(mask.tiles.map(async tile => {
    const bytes = pixels.get(tile.blobId);
    if (!bytes) throw new Error('Workspace share mask tile is missing.');
    return { ...tile, blobId: hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))) };
  })) };
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encode(normalized))));
}

async function proposalKey(invitation: ShareInvitation) {
  return crypto.subtle.importKey('raw', fromBase64Url(invitation.key), 'HKDF', false, ['deriveKey']);
}
export async function encryptProposal(invitation: ShareInvitation, proposal: ShareProposal): Promise<ArrayBuffer> {
  return (await sealObject(await proposalKey(invitation), invitation.id, invitation.id,
    encode(proposalSchema.parse(proposal)), 'record')).buffer;
}
export async function decryptProposal(invitation: ShareInvitation, bytes: ArrayBuffer): Promise<ShareProposal> {
  const plain = await openObject(await proposalKey(invitation), invitation.id, invitation.id, new Uint8Array(bytes), 'record');
  const proposal = proposalSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)));
  if (proposal.shareId !== invitation.id) throw new Error('Workspace proposal belongs to a different invitation.');
  return proposal;
}

export function mergeProposal(base: AnnotationDocument, next: AnnotationDocument, latest: AnnotationDocument): AnnotationDocument {
  if (!same(base.image, next.image) || !same(base.classes, next.classes) || !same(base.skeletons, next.skeletons) ||
      base.image.id !== latest.image.id || !same(base.image.canonical, latest.image.canonical) ||
      !same(base.classes, latest.classes) || !same(base.skeletons, latest.skeletons)) {
    throw new Error('Image or dataset schema changed; create a new invitation.');
  }
  const before = new Map(base.annotations.map(item => [item.id, item]));
  const after = new Map(next.annotations.map(item => [item.id, item]));
  const current = new Map(latest.annotations.map(item => [item.id, item]));
  const history = new ImageHistory(latest);
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(id), proposed = after.get(id), now = current.get(id);
    if (same(old, proposed)) continue;
    if (old?.kind === 'mask' || proposed?.kind === 'mask') throw new Error('Mask changes cannot be submitted in an annotation proposal.');
    if (same(now, proposed)) continue;
    if (!same(old, now)) throw new Error(`Annotation ${id} was also edited or deleted by the owner.`);
    history.execute(proposed ? { type: 'put', annotation: proposed } : { type: 'remove', id }, history.snapshot().revision);
  }
  if (base.review !== next.review && latest.review !== next.review) {
    if (latest.review !== base.review) throw new Error('Review status was also changed by the owner.');
    history.execute({ type: 'review', review: next.review }, history.snapshot().revision);
  }
  const result = history.snapshot();
  return documentSchema.parse({ ...result, revision: latest.revision + (same(result.annotations, latest.annotations) && result.review === latest.review ? 0 : 1) });
}
