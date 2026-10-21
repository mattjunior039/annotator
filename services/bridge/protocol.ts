import { z } from 'zod';

export const MAX_BYTES = 256 * 1024;
export const PORT = 47321;
export const PAIR_TTL = 60_000;
export const SESSION_TTL = 15 * 60_000;
export const DATA_TTL = 60_000;
export const opaqueId = z.uuid();
export const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const scope = z.enum(['metadata', 'counts', 'propose']);
export const scopes = z.array(scope).min(1).max(3).refine(items => new Set(items).size === items.length);
export const originSchema = z.string().max(200).refine(value => {
  try {
    const url = new URL(value);
    return url.origin === value && (url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)));
  } catch { return false; }
});
const box = z.tuple([z.number().finite().nonnegative(), z.number().finite().nonnegative(),
  z.number().finite().positive(), z.number().finite().positive()]);
export const annotation = z.strictObject({
  id: opaqueId, imageId: opaqueId, classId: opaqueId, box,
  review: z.enum(['unreviewed', 'accepted', 'rejected']),
});
export const snapshotSchema = z.strictObject({
  revision,
  classes: z.array(opaqueId).max(1000),
  images: z.array(z.strictObject({
    id: opaqueId, width: z.number().int().positive().max(100_000),
    height: z.number().int().positive().max(100_000),
  })).max(1000),
  annotations: z.array(annotation).max(2000),
}).superRefine((data, ctx) => {
  const unique = (ids: string[]) => new Set(ids).size === ids.length;
  if (!unique(data.classes) || !unique(data.images.map(image => image.id)) ||
      !unique(data.annotations.map(item => item.id))) {
    ctx.addIssue({ code: 'custom', message: 'Invalid snapshot' });
  }
  for (const item of data.annotations) {
    const image = data.images.find(value => value.id === item.imageId);
    if (!image || !data.classes.includes(item.classId) ||
        item.box[0] + item.box[2] > image.width || item.box[1] + item.box[3] > image.height) {
      ctx.addIssue({ code: 'custom', message: 'Invalid snapshot' });
    }
  }
});
export const pairingSchema = z.strictObject({ origin: originSchema, workspaceId: opaqueId, scopes });
export const pairMessage = z.strictObject({
  type: z.literal('pair'), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  workspaceId: opaqueId, approved: z.literal(true), scopes,
});
export const proposalSchema = z.strictObject({
  baseRevision: revision,
  operations: z.array(z.strictObject({ type: z.literal('replace-box'), annotation })).min(1).max(100),
});
export const browserMessage = z.union([
  z.strictObject({ type: z.literal('snapshot'), snapshot: snapshotSchema }),
  z.strictObject({ type: z.literal('status') }),
  z.strictObject({ type: z.literal('revoke') }),
  z.strictObject({ type: z.literal('lock') }),
  z.strictObject({
    type: z.literal('review'), proposalId: opaqueId, baseRevision: revision,
    outcome: z.literal('rejected'),
  }),
  z.strictObject({
    type: z.literal('review'), proposalId: opaqueId, baseRevision: revision,
    outcome: z.literal('applied'), snapshot: snapshotSchema,
  }),
]);
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Scope = z.infer<typeof scope>;
