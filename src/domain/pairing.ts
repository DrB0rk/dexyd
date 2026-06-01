import { z } from 'zod';

const bridgeBaseUrlSchema = z.string().url().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}, 'bridgeBaseUrl must be an http(s) URL');

export const createPairingRequestSchema = z
  .object({
    bridgeBaseUrl: bridgeBaseUrlSchema.optional(),
    expiresInSeconds: z.number().int().min(30).max(900).optional()
  })
  .default({});

export const pairingPayloadSchema = z.object({
  version: z.literal(1),
  bridgeBaseUrl: bridgeBaseUrlSchema,
  pairingId: z.string().uuid(),
  challenge: z.string(),
  expiresAt: z.string()
});

export type PairingPayload = z.infer<typeof pairingPayloadSchema>;
