import { z } from 'zod';
import { annotationSchema, documentSchema, reviewSchema } from '../domain/model';

export const SHARE_BYTES = 64 * 1024 * 1024;
export const invitationSchema = z.strictObject({
  version: z.literal(1), id: z.uuid(), key: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  transport: z.enum(['s3', 'file']).optional(),
  download: z.url().max(8192), upload: z.url().max(8192), expires: z.string().datetime().nullable(),
}).superRefine((invitation, context) => {
  if (invitation.transport === 'file'
    ? invitation.expires !== null || invitation.download !== `urn:annotator:file:${invitation.id}` ||
      invitation.upload !== invitation.download
    : invitation.expires === null) {
    context.addIssue({ code: 'custom', message: 'Invalid invitation transport or expiry.' });
  }
});
export type ShareInvitation = z.infer<typeof invitationSchema>;
export const shareReceiptSchema = z.strictObject({
  invitation: invitationSchema,
  role: z.enum(['owner', 'contributor']),
  name: z.string().trim().min(1).max(100),
  reviewUrl: z.url().max(8192),
  status: z.enum(['open', 'submitted', 'approved', 'rejected']),
  bases: z.array(documentSchema).max(10_000),
  maskDigests: z.record(z.string().regex(/^[0-9a-f-]{36}\/[0-9a-f-]{36}$/), z.string().regex(/^[0-9a-f]{64}$/)).optional(),
});
export type ShareReceipt = z.infer<typeof shareReceiptSchema>;
export const shareSummarySchema = shareReceiptSchema.omit({ bases: true, maskDigests: true });
export const shareSummariesSchema = z.array(shareSummarySchema).max(100);
export type ShareSummary = z.infer<typeof shareSummarySchema>;
export const proposalSchema = z.strictObject({
  version: z.literal(1), shareId: z.uuid(),
  author: z.string().trim().min(1).max(100),
  message: z.string().trim().min(1).max(2000),
  changes: z.array(z.strictObject({ base: documentSchema, next: documentSchema })).min(1).max(10_000),
});
export type ShareProposal = z.infer<typeof proposalSchema>;
export const proposalPreviewSchema = z.strictObject({
  token: z.uuid(), shareId: z.uuid(), author: z.string(), message: z.string(),
  images: z.array(z.strictObject({
    id: z.uuid(), name: z.string(), added: z.number().int().nonnegative(),
    changed: z.number().int().nonnegative(), removed: z.number().int().nonnegative(),
    reviewChanged: z.boolean(),
    reviewBefore: reviewSchema, reviewAfter: reviewSchema,
    edits: z.array(z.strictObject({ id: z.uuid(), before: annotationSchema.nullable(), after: annotationSchema.nullable() })),
  })),
  conflicts: z.array(z.string()),
});
export type ProposalPreview = z.infer<typeof proposalPreviewSchema>;
