import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import { SqliteService } from '../db/sqlite.js';
import { PairingPayload, pairingPayloadSchema } from '../domain/pairing.js';
import { AuthService } from './auth-service.js';

type LoggerLike = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

export class PairingService {
  constructor(
    private readonly db: SqliteService,
    private readonly authService: AuthService,
    private readonly defaultBridgeBaseUrl: string,
    private readonly logger: LoggerLike
  ) {}

  async startPairing(input?: { bridgeBaseUrl?: string; expiresInSeconds?: number }): Promise<{
    pairingId: string;
    expiresAt: string;
    pairingUri: string;
    payload: PairingPayload;
    qrCodeDataUrl: string;
  }> {
    const expiresInSeconds = input?.expiresInSeconds ?? 300;
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
    const challenge = randomBytes(24).toString('base64url');
    const pairingId = randomUUID();

    const payload: PairingPayload = {
      version: 1,
      bridgeBaseUrl: input?.bridgeBaseUrl ?? this.defaultBridgeBaseUrl,
      pairingId,
      challenge,
      expiresAt
    };

    this.db.createPairingSession({
      pairingId,
      challenge,
      expiresAt,
      payload
    });

    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const pairingUri = `dexyd://pair?payload=${encoded}`;
    const qrCodeDataUrl = await QRCode.toDataURL(pairingUri, {
      margin: 1,
      errorCorrectionLevel: 'M'
    });

    this.logger.info({ pairingId, expiresAt }, 'pairing session started');

    return {
      pairingId,
      expiresAt,
      pairingUri,
      payload,
      qrCodeDataUrl
    };
  }

  completePairing(input: { pairingId: string; challenge: string; deviceLabel: string }): {
    deviceId: string;
    accessToken: string;
    refreshToken: string;
    accessExpiresAt: string;
    refreshExpiresAt: string;
  } {
    const session = this.db.getPairingSession(input.pairingId);

    if (!session) {
      throw new Error('pairing_not_found');
    }

    if (session.status !== 'pending') {
      throw new Error('pairing_not_pending');
    }

    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      throw new Error('pairing_expired');
    }

    if (!safeEqual(session.challenge, input.challenge)) {
      throw new Error('pairing_challenge_mismatch');
    }

    const device = this.db.createDevice({ label: input.deviceLabel });
    this.db.markPairingSessionCompleted({ pairingId: session.id, deviceId: device.id });

    const tokens = this.authService.issueDeviceTokens(device.id);

    this.db.addAuditLog({
      actor: 'pairing',
      action: 'pairing.completed',
      target: device.id,
      metadata: {
        pairingId: session.id,
        deviceLabel: input.deviceLabel
      }
    });

    return {
      deviceId: device.id,
      ...tokens
    };
  }


  completePairingFromUri(input: { pairingUri: string; deviceLabel: string }) {
    const payload = this.parsePairingUri(input.pairingUri);
    return this.completePairing({
      pairingId: payload.pairingId,
      challenge: payload.challenge,
      deviceLabel: input.deviceLabel
    });
  }
  parsePairingUri(pairingUri: string): PairingPayload {
    let url: URL;
    try {
      url = new URL(pairingUri);
    } catch {
      throw new Error('invalid_pairing_uri');
    }

    if (url.protocol !== 'dexyd:') {
      throw new Error('invalid_pairing_uri_scheme');
    }

    const encoded = url.searchParams.get('payload');
    if (!encoded) {
      throw new Error('missing_pairing_payload');
    }

    try {
      const raw = Buffer.from(encoded, 'base64url').toString('utf8');
      const parsed = JSON.parse(raw);
      return pairingPayloadSchema.parse(parsed);
    } catch {
      throw new Error('invalid_pairing_payload');
    }
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
