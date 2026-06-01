import { z } from 'zod';

export const sendChatMessageRequestSchema = z.object({
  message: z.string().trim().min(1).max(12000)
});

export const chatQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200)
});

export type SendChatMessageRequest = z.infer<typeof sendChatMessageRequestSchema>;

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool';

export type ChatMessage = {
  id: string;
  turnId: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  sequence: number;
  status: 'sent' | 'running' | 'failed' | 'cancelled';
};
