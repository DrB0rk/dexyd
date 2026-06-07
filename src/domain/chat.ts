import { z } from 'zod';

export const sendChatMessageRequestSchema = z.object({
  message: z.string().trim().min(1).max(12000)
});

export const scheduleChatMessageRequestSchema = z.object({
  message: z.string().trim().min(1).max(12000),
  runAt: z.string().datetime(),
  repeat: z
    .object({
      intervalMs: z.coerce
        .number()
        .int()
        .min(60_000)
        .max(31 * 24 * 60 * 60 * 1000),
      maxRuns: z.coerce.number().int().min(1).max(365).optional()
    })
    .optional()
});

export const chatQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200)
});

export type SendChatMessageRequest = z.infer<typeof sendChatMessageRequestSchema>;
export type ScheduleChatMessageRequest = z.infer<typeof scheduleChatMessageRequestSchema>;

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool';

export type ChatMessage = {
  id: string;
  turnId: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  sequence: number;
  status: 'sent' | 'running' | 'failed' | 'cancelled' | 'queued';
  queueId?: string;
};

export type ScheduledChatMessageStatus = 'scheduled' | 'completed' | 'cancelled' | 'failed';

export type ScheduledChatMessage = {
  id: string;
  sessionId: string;
  content: string;
  actorDeviceId: string;
  nextRunAt: string;
  repeatIntervalMs: number | null;
  repeatMaxRuns: number | null;
  runCount: number;
  status: ScheduledChatMessageStatus;
  lastRunAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};
