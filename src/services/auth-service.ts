import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AccessTokenPayload } from '../domain/auth.js';
import { SqliteService } from '../db/sqlite.js';

function base64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64url(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
  return Buffer.from(padded, 'base64');
}

type LoggerLike = {
  warn: (obj: unknown, msg?: string) => void;
};

export class AuthService {
  constructor(
    private readonly db: SqliteService,
    private readonly signingKey: string,
    private readonly accessTokenTtlSeconds: number,
    private readonly refreshTokenTtlSeconds: number,
    private readonly logger: LoggerLike
  ) {}

  issueDeviceTokens(deviceId: string): {
    accessToken: string;
    refreshToken: string;
    accessExpiresAt: string;
    refreshExpiresAt: string;
  } {
    const accessPayload: AccessTokenPayload = {
      sub: deviceId,
      type: 'access',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + this.accessTokenTtlSeconds,
      sid: randomBytes(8).toString('hex')
    };

    const accessToken = this.signAccessToken(accessPayload);

    const refreshTokenBytes = randomBytes(48).toString('base64url');
    const refreshToken = `rt.${refreshTokenBytes}`;
    const refreshHash = this.hashRefreshToken(refreshToken);
    const refreshExpiresAt = new Date(Date.now() + this.refreshTokenTtlSeconds * 1000).toISOString();

    this.db.storeRefreshToken({
      deviceId,
      tokenHash: refreshHash,
      expiresAt: refreshExpiresAt
    });

    return {
      accessToken,
      refreshToken,
      accessExpiresAt: new Date(accessPayload.exp * 1000).toISOString(),
      refreshExpiresAt
    };
  }

  rotateRefreshToken(refreshToken: string): {
    deviceId: string;
    accessToken: string;
    refreshToken: string;
    accessExpiresAt: string;
    refreshExpiresAt: string;
  } | null {
    const refreshHash = this.hashRefreshToken(refreshToken);
    const existing = this.db.findActiveRefreshToken(refreshHash);

    if (!existing) {
      return null;
    }

    this.db.revokeRefreshTokenByHash(refreshHash);

    const tokens = this.issueDeviceTokens(existing.device_id);

    return {
      deviceId: existing.device_id,
      ...tokens
    };
  }

  revokeByRefreshToken(refreshToken: string): void {
    const refreshHash = this.hashRefreshToken(refreshToken);
    const existing = this.db.findActiveRefreshToken(refreshHash);
    if (!existing) {
      return;
    }
    this.db.revokeRefreshTokenByHash(refreshHash);
    this.db.revokeAllRefreshTokensForDevice(existing.device_id);
  }

  verifyAccessToken(token: string): AccessTokenPayload | null {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }

    const [headerPart, payloadPart, signaturePart] = parts;

    if (!headerPart || !payloadPart || !signaturePart) {
      return null;
    }

    const unsigned = `${headerPart}.${payloadPart}`;
    const expectedSignature = this.sign(unsigned);

    const provided = fromBase64url(signaturePart);
    const expected = fromBase64url(expectedSignature);

    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return null;
    }

    try {
      const payload = JSON.parse(fromBase64url(payloadPart).toString('utf8')) as AccessTokenPayload;

      if (payload.type !== 'access' || !payload.sub || !payload.exp) {
        return null;
      }

      const now = Math.floor(Date.now() / 1000);
      if (payload.exp <= now) {
        return null;
      }

      const device = this.db.getDevice(payload.sub);
      if (!device || device.trustState !== 'trusted') {
        return null;
      }

      this.db.touchDevice(payload.sub);

      return payload;
    } catch (error) {
      this.logger.warn({ error }, 'access token decode failed');
      return null;
    }
  }

  private signAccessToken(payload: AccessTokenPayload): string {
    const header = {
      alg: 'HS256',
      typ: 'JWT'
    };

    const headerPart = base64url(JSON.stringify(header));
    const payloadPart = base64url(JSON.stringify(payload));
    const unsigned = `${headerPart}.${payloadPart}`;
    const signature = this.sign(unsigned);

    return `${unsigned}.${signature}`;
  }

  private sign(input: string): string {
    return base64url(createHmac('sha256', this.signingKey).update(input).digest());
  }

  private hashRefreshToken(token: string): string {
    return createHmac('sha256', this.signingKey).update(token).digest('hex');
  }
}
