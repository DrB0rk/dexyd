import { z } from 'zod';

export const createPairingRequestSchema = z
  .object({
    bridgeBaseUrl: z.string().url().optional(),
    expiresInSeconds: z.number().int().min(30).max(900).optional()
  })
  .default({});

export const pairingPayloadSchema = z.object({
  version: z.literal(1),
  bridgeBaseUrl: z.string().url(),
  pairingId: z.string().uuid(),
  challenge: z.string(),
  expiresAt: z.string()
});

export type PairingPayload = z.infer<typeof pairingPayloadSchema>;
