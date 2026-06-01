import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDexydApplication } from '../src/app.js';

const cleanupPaths: string[] = [];

afterEach(() => {
  delete process.env.DEXYD_CONFIG;
  for (const path of cleanupPaths.splice(0, cleanupPaths.length)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function writeConfig(tempDir: string): string {
  const configPath = join(tempDir, 'dexyd.yaml');
  writeFileSync(
    configPath,
    `server:\n  host: 127.0.0.1\n  port: 4555\nstorage:\n  sqlitePath: ${join(tempDir, 'dexyd.db')}\nauth:\n  signingKey: test-signing-key-value\n`
  );
  return configPath;
}

describe('security pairing flow', () => {
  it('rejects pairing challenge creation from public client addresses', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-sec-public-'));
    cleanupPaths.push(tempDir);
    process.env.DEXYD_CONFIG = writeConfig(tempDir);

    const service = await createDexydApplication();

    try {
      const start = await service.app.inject({
        method: 'POST',
        url: '/pairing/start',
        headers: {
          'x-forwarded-for': '203.0.113.10'
        },
        payload: {}
      });

      expect(start.statusCode).toBe(403);
    } finally {
      await service.stop();
    }
  });

  it('issues tokens from pairing and refreshes access', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-sec-'));
    cleanupPaths.push(tempDir);
    process.env.DEXYD_CONFIG = writeConfig(tempDir);

    const service = await createDexydApplication();

    try {
      const start = await service.app.inject({
        method: 'POST',
        url: '/pairing/start',
        payload: {}
      });

      expect(start.statusCode).toBe(201);
      const startBody = start.json() as {
        pairingId: string;
        pairingUri: string;
        payload: { challenge: string };
      };

      expect(startBody.pairingUri.startsWith('dexyd://pair?payload=')).toBe(true);

      const complete = await service.app.inject({
        method: 'POST',
        url: '/pairing/complete',
        payload: {
          pairingId: startBody.pairingId,
          challenge: startBody.payload.challenge,
          deviceLabel: 'my-phone'
        }
      });

      expect(complete.statusCode).toBe(201);
      const completeBody = complete.json() as {
        accessToken: string;
        refreshToken: string;
      };

      const unauthorized = await service.app.inject({
        method: 'GET',
        url: '/sessions'
      });

      expect(unauthorized.statusCode).toBe(401);

      const devices = await service.app.inject({
        method: 'GET',
        url: '/devices',
        headers: {
          authorization: `Bearer ${completeBody.accessToken}`
        }
      });

      expect(devices.statusCode).toBe(200);
      expect(devices.json().devices.length).toBe(1);

      const refreshed = await service.app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: {
          refreshToken: completeBody.refreshToken
        }
      });

      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.json().accessToken).toBeTruthy();
    } finally {
      await service.stop();
    }
  });
});
