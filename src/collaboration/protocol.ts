import { z } from 'zod';
import { documentSchema } from '../domain/model';
import { commandSchema } from '../domain/history';
import { datasetSchemaSchema } from '../domain/dataset-schema';

export const displayNameSchema = z.string().trim().min(1).max(40);
const publicKeySchema = z.string().regex(/^[A-Za-z0-9_-]{87}$/);

export const guestHelloSchema = z.strictObject({ t: z.literal('hello'), name: displayNameSchema, key: publicKeySchema });
export const hostHelloSchema = z.strictObject({ t: z.literal('hello'), key: publicKeySchema });

// Guests may run only these storage operations on the host's workspace.
export const guestRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('workspace-list'), offset: z.number().int().nonnegative().max(1_000_000), limit: z.number().int().min(1).max(100) }),
  z.strictObject({ type: z.literal('workspace-read'), id: z.uuid() }),
  z.strictObject({ type: z.literal('workspace-thumbnail'), id: z.uuid() }),
  z.strictObject({ type: z.literal('workspace-mask-read'), id: z.uuid() }),
  z.strictObject({ type: z.literal('live-edit'), id: z.uuid(), commands: z.array(commandSchema).min(1).max(64) }),
]);
export type GuestRequest = z.infer<typeof guestRequestSchema>;

const rtcSchema = z.strictObject({
  t: z.literal('rtc'),
  description: z.strictObject({ type: z.enum(['offer', 'answer']), sdp: z.string().max(65_536) }).optional(),
  candidate: z.strictObject({
    candidate: z.string().max(1024), sdpMid: z.string().max(64).nullable(),
    sdpMLineIndex: z.number().int().nonnegative().max(64).nullable(),
  }).optional(),
});
export type RtcMessage = z.infer<typeof rtcSchema>;

export const participantSchema = z.strictObject({
  id: z.string().regex(/^[0-9a-f]{16}$/), name: displayNameSchema, host: z.boolean(),
  imageId: z.uuid().nullable(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});
export type Participant = z.infer<typeof participantSchema>;

export const hostMessageSchema = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('ready'), you: z.string().regex(/^[0-9a-f]{16}$/), workspaceName: z.string().min(1).max(100), schema: datasetSchemaSchema }),
  z.strictObject({ t: z.literal('reply'), id: z.number().int().positive(), ok: z.boolean(), value: z.unknown().optional(), error: z.string().max(1024).optional() }),
  z.strictObject({ t: z.literal('document'), document: documentSchema }),
  z.strictObject({ t: z.literal('schema'), schema: datasetSchemaSchema }),
  z.strictObject({ t: z.literal('index') }),
  z.strictObject({ t: z.literal('presence'), participants: z.array(participantSchema).max(8) }),
  z.strictObject({ t: z.literal('end'), reason: z.string().max(256) }),
  rtcSchema,
]);
export type HostMessage = z.infer<typeof hostMessageSchema>;

export const guestMessageSchema = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('request'), id: z.number().int().positive(), payload: guestRequestSchema }),
  z.strictObject({ t: z.literal('viewing'), imageId: z.uuid().nullable() }),
  rtcSchema,
]);
export type GuestMessage = z.infer<typeof guestMessageSchema>;
