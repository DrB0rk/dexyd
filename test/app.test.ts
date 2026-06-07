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

      const caps = await service.app.inject({ method: 'GET', url: '/capabilities' });
      expect(caps.statusCode).toBe(200);
    } finally {
      await service.stop();
    }
  });

  it('serves the web app and bootstraps local web auth tokens', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-web-'));
    cleanupPaths.push(tempDir);

    const configPath = join(tempDir, 'dexyd.yaml');
    writeFileSync(
      configPath,
      `server:\n  host: 127.0.0.1\n  port: 4555\nstorage:\n  sqlitePath: ${join(tempDir, 'dexyd.db')}\n`
    );

    process.env.DEXYD_CONFIG = configPath;

    const service = await createDexydApplication();

    try {
      const web = await service.app.inject({ method: 'GET', url: '/' });
      expect(web.statusCode).toBe(200);
      expect(web.headers['content-type']).toContain('text/html');
      expect(web.body).toContain('Dexyd Web');

      const bootstrap = await service.app.inject({
        method: 'POST',
        url: '/web/auth/bootstrap',
        headers: { host: '127.0.0.1:4555' },
        remoteAddress: '127.0.0.1',
        payload: {}
      });
      expect(bootstrap.statusCode).toBe(201);
      const tokens = bootstrap.json() as { accessToken: string; refreshToken: string };
      expect(tokens.accessToken).toMatch(/^ey/);
      expect(tokens.refreshToken).toMatch(/^rt\./);

      const sessions = await service.app.inject({
        method: 'GET',
        url: '/sessions',
        headers: { authorization: `Bearer ${tokens.accessToken}` }
      });
      expect(sessions.statusCode).toBe(200);
    } finally {
      await service.stop();
    }
  });

  it('rejects automatic web auth from public hosts', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-web-public-'));
    cleanupPaths.push(tempDir);

    const configPath = join(tempDir, 'dexyd.yaml');
    writeFileSync(
      configPath,
      `server:\n  host: 127.0.0.1\n  port: 4555\nstorage:\n  sqlitePath: ${join(tempDir, 'dexyd.db')}\n`
    );

    process.env.DEXYD_CONFIG = configPath;

    const service = await createDexydApplication();

    try {
      const bootstrap = await service.app.inject({
        method: 'POST',
        url: '/web/auth/bootstrap',
        headers: { host: 'dexyd.example.com' },
        remoteAddress: '172.18.0.2',
        payload: {}
      });
      expect(bootstrap.statusCode).toBe(403);
    } finally {
      await service.stop();
    }
  });
});
