import { z } from 'zod';

export const replayRequestSchema = z.object({
  type: z.literal('replay.request'),
  lastSeenSequence: z.number().int().min(0),
  sessionId: z.string().uuid().optional(),
  deviceId: z.string().min(1).optional()
});

export const emitEventRequestSchema = z.object({
  eventType: z.string().min(1),
  payload: z.unknown(),
  sessionId: z.string().uuid().optional(),
  streamId: z.string().min(1).optional(),
  source: z.enum(['system', 'stream', 'session', 'harness', 'plugin', 'codexAdapter']).default('session')
});

export type ReplayRequest = z.infer<typeof replayRequestSchema>;
export type EmitEventRequest = z.infer<typeof emitEventRequestSchema>;
