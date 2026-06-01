import { z } from 'zod';

export const sessionStatusSchema = z.enum(['created', 'running', 'idle', 'completed', 'failed', 'cancelled']);

export const createSessionRequestSchema = z.object({
  workspacePath: z.string().trim().min(1).default('.'),
  profile: z.string().trim().min(1).max(120).default('default'),
  title: z.string().trim().max(160).optional()
});

export const patchSessionRequestSchema = z.object({
  status: sessionStatusSchema.optional(),
  profile: z.string().trim().min(1).max(120).optional()
});

export const sessionRecordSchema = z.object({
  id: z.string().min(1),
  status: sessionStatusSchema,
  profile: z.string().min(1),
  workspacePath: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  source: z.enum(['dexyd', 'codex']).default('dexyd').optional(),
  title: z.string().nullable().optional(),
  omx: z.boolean().optional()
});

export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;
export type PatchSessionRequest = z.infer<typeof patchSessionRequestSchema>;
export type SessionRecord = z.infer<typeof sessionRecordSchema>;
