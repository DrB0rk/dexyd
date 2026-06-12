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

describe('dexyd app foundation', () => {
  it('serves liveness and readiness endpoints', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-app-'));
    cleanupPaths.push(tempDir);

    const configPath = join(tempDir, 'dexyd.yaml');
    writeFileSync(
      configPath,
      `server:\n  host: 127.0.0.1\n  port: 4555\nstorage:\n  sqlitePath: ${join(tempDir, 'dexyd.db')}\n`
    );

    process.env.DEXYD_CONFIG = configPath;

    const service = await createDexydApplication();

    try {
      const live = await service.app.inject({ method: 'GET', url: '/health/live' });
      expect(live.statusCode).toBe(200);

      const ready = await service.app.inject({ method: 'GET', url: '/health/ready' });
      expect(ready.statusCode).toBe(200);

      const body = ready.json();
      expect(body.status).toBe('ready');
      expect(body.database.status).toBe('ready');
      expect(body.modules).toBeDefined();
      expect(body.bridge.advertisedBaseUrl).toBe('http://127.0.0.1:4555');
      expect(body.cloudflare).toMatchObject({ configured: false, tunnelName: 'dexyd', publicUrl: null });
      expect(body.assistant).toMatchObject({ codexHarnessMode: 'direct', opencodeEnabled: true });

      const caps = await service.app.inject({ method: 'GET', url: '/capabilities' });
      expect(caps.statusCode).toBe(200);
    } finally {
      await service.stop();
    }
  });
});
