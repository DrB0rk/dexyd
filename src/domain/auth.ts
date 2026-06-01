import { z } from 'zod';

export const completePairingRequestSchema = z.union([
  z.object({
    pairingId: z.string().uuid(),
    challenge: z.string().min(8),
    deviceLabel: z.string().min(1).max(120)
  }),
  z.object({
    pairingUri: z.string().min(10),
    deviceLabel: z.string().min(1).max(120)
  })
]);

export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(20)
});

export const revokeRequestSchema = z.object({
  refreshToken: z.string().min(20).optional()
});

export type AccessTokenPayload = {
  sub: string;
  type: 'access';
  exp: number;
  iat: number;
  sid: string;
};

export type RefreshTokenRecord = {
  id: string;
  deviceId: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
};
