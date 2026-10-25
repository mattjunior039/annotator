import { z } from 'zod';

export const MAX_BYTES = 256 * 1024;
export const MAX_RESULT_BYTES = 24 * 1024 * 1024;
export const PORT = 47321;
export const PAIR_TTL = 120_000;
export const SESSION_TTL = 8 * 60 * 60_000;
// Below Antigravity's default 180-second tool-call limit, leaving time for user approval.
export const JOB_TTL = 150_000;
export const OFFLINE_AFTER = 10_000;
export const MAX_VIEW_IMAGES = 6;

export const opaqueId = z.uuid();
export const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const scope = z.enum(['metadata', 'pixels', 'propose']);
export const scopes = z.array(scope).min(1).max(3).refine(items => new Set(items).size === items.length);
export const reviewState = z.enum(['unannotated', 'in_progress', 'annotated', 'reviewed']);
export const originSchema = z.string().max(200).refine(value => {
  try {
    const url = new URL(value);
    return url.origin === value && (url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)));
  } catch { return false; }
});

const coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
const pair = z.tuple([coordinate, coordinate]);
const box = z.tuple([coordinate, coordinate, coordinate, coordinate]);
const label = z.string().trim().min(1).max(100);

// Editor tool inputs. The companion validates these before the browser sees them.
export const listImagesInput = z.strictObject({
  offset: z.number().int().min(0).max(1_000_000).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  review: reviewState.optional(),
});
export const getAnnotationsInput = z.strictObject({
  imageIds: z.array(opaqueId).min(1).max(25).refine(items => new Set(items).size === items.length),
});
export const viewImagesInput = z.strictObject({
  imageIds: z.array(opaqueId).min(1).max(MAX_VIEW_IMAGES).refine(items => new Set(items).size === items.length),
  maxSize: z.number().int().min(256).max(2048).optional(),
});
const shape = z.strictObject({ label, box: box.optional(), polygon: z.array(pair).min(3).max(500).optional() })
  .refine(item => !(item.box && item.polygon), 'Use either box or polygon, not both.');
const update = z.strictObject({
  id: opaqueId, label: label.optional(), box: box.optional(), polygon: z.array(pair).min(3).max(500).optional(),
}).refine(item => !(item.box && item.polygon), 'Use either box or polygon, not both.');
export const annotateInput = z.strictObject({
  units: z.enum(['pixels', 'normalized']).optional(),
  edits: z.array(z.strictObject({
    imageId: opaqueId,
    expectedRevision: revision.optional(),
    add: z.array(shape).max(300).optional(),
    update: z.array(update).max(300).optional(),
    remove: z.array(opaqueId).max(300).optional(),
    review: reviewState.optional(),
  })).min(1).max(50),
}).superRefine((value, context) => {
  const ids = value.edits.map(edit => edit.imageId);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', message: 'Each image may appear once per call.' });
  const operations = value.edits.reduce((sum, edit) =>
    sum + (edit.add?.length ?? 0) + (edit.update?.length ?? 0) + (edit.remove?.length ?? 0) + (edit.review ? 1 : 0), 0);
  if (operations < 1 || operations > 2000) context.addIssue({ code: 'custom', message: 'Provide 1–2000 operations.' });
});
export type AnnotateInput = z.infer<typeof annotateInput>;

// Browser results. Strict schemas keep filenames, paths and other fields from reaching the editor.
const classInfo = z.strictObject({ id: opaqueId, name: z.string().min(1).max(256) });
export const listImagesResult = z.strictObject({
  total: z.number().int().nonnegative(), offset: z.number().int().nonnegative(),
  images: z.array(z.strictObject({
    id: opaqueId, width: z.number().int().positive(), height: z.number().int().positive(),
    review: reviewState, annotationCount: z.number().int().nonnegative(),
  })).max(200),
  classes: z.array(classInfo).max(10_000),
});
const keypoint = z.strictObject({ name: z.string().max(256), x: z.number().finite(), y: z.number().finite(),
  visibility: z.enum(['absent', 'occluded', 'visible']) });
export const annotationOutput = z.strictObject({
  id: opaqueId, label: z.string().min(1).max(256),
  kind: z.enum(['box', 'polygon', 'line', 'keypoints', 'mask', 'image-label']),
  box: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  points: z.array(z.union([z.tuple([z.number(), z.number()]), keypoint])).max(4096).optional(),
  locked: z.literal(true).optional(),
});
export const getAnnotationsResult = z.strictObject({
  images: z.array(z.strictObject({
    id: opaqueId, width: z.number().int().positive(), height: z.number().int().positive(),
    revision, review: reviewState, annotations: z.array(annotationOutput).max(100_000),
  })).max(25),
});
export const viewImagesResult = z.strictObject({
  images: z.array(z.strictObject({
    id: opaqueId, width: z.number().int().positive(), height: z.number().int().positive(),
    sentWidth: z.number().int().positive(), sentHeight: z.number().int().positive(),
    mimeType: z.literal('image/jpeg'), data: z.string().max(6_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })).min(1).max(MAX_VIEW_IMAGES),
});
export const annotateResult = z.strictObject({
  state: z.enum(['applied', 'rejected']),
  createdClasses: z.array(z.string().max(256)).max(300),
  images: z.array(z.strictObject({
    id: opaqueId, revision: revision.optional(), added: z.array(opaqueId).max(300),
    updated: z.number().int().nonnegative(), removed: z.number().int().nonnegative(),
  })).max(50),
});

export const jobKinds = {
  list: { scope: 'metadata', input: listImagesInput, result: listImagesResult },
  annotations: { scope: 'metadata', input: getAnnotationsInput, result: getAnnotationsResult },
  images: { scope: 'pixels', input: viewImagesInput, result: viewImagesResult },
  annotate: { scope: 'propose', input: annotateInput, result: annotateResult },
} as const;
export type JobKind = keyof typeof jobKinds;
export const jobKind = z.enum(['list', 'annotations', 'images', 'annotate']);
export const jobFailure = z.enum(['declined', 'stale', 'invalid', 'failed']);

export const pairRequest = z.strictObject({ type: z.literal('pair-request'), workspaceId: opaqueId, scopes });
export const pairCheck = z.strictObject({ type: z.literal('pair-check'), ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
export const pairCode = z.strictObject({ code: z.string().max(20) });
export const browserMessage = z.union([
  z.strictObject({ type: z.literal('poll') }),
  z.strictObject({ type: z.literal('revoke') }),
  z.strictObject({ type: z.literal('lock') }),
  z.strictObject({ type: z.literal('result'), jobId: opaqueId, ok: z.literal(true), value: z.unknown() }),
  z.strictObject({ type: z.literal('result'), jobId: opaqueId, ok: z.literal(false), error: jobFailure,
    message: z.string().max(500).optional() }),
]);
export const pollResponse = z.strictObject({
  authorized: z.literal(true), expiresAt: z.number().int(),
  jobs: z.array(z.strictObject({ id: opaqueId, kind: jobKind, args: z.unknown() })).max(16),
});
export type Scope = z.infer<typeof scope>;
