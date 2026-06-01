import { z } from 'zod';

export const interactionIdParamsSchema = z.object({
  interactionId: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[A-Za-z0-9_.:-]+$/, 'interaction id contains unsupported characters')
});

const sessionScopedSchema = z.object({
  sessionId: z.string().uuid().optional()
});

export const interactionResponseSchema = z.discriminatedUnion('kind', [
  sessionScopedSchema.extend({
    kind: z.literal('approval'),
    decision: z.enum(['approved', 'denied']),
    note: z.string().max(2000).optional()
  }),
  sessionScopedSchema.extend({
    kind: z.literal('question'),
    answer: z.string().min(1).max(4000),
    choiceId: z.string().min(1).max(160).optional()
  })
]);

export type InteractionResponse = z.infer<typeof interactionResponseSchema>;
