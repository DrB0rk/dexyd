import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDexydApplication } from '../src/app.js';
import { pairTestDevice } from './helpers.js';

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

  it('persists OpenCode-created sessions in the unified session list', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-opencode-shadow-'));
    cleanupPaths.push(tempDir);

    const workspace = join(tempDir, 'workspace');
    writeFileSync(join(tempDir, 'placeholder'), '');
    mkdirSync(workspace);
    const configPath = join(tempDir, 'dexyd.yaml');
    writeFileSync(
      configPath,
      `server:\n  host: 127.0.0.1\n  port: 4555\nstorage:\n  sqlitePath: ${join(tempDir, 'dexyd.db')}\nauth:\n  signingKey: test-signing-key-value\ncodex:\n  workspaceRoot: ${tempDir}\n`
    );

    process.env.DEXYD_CONFIG = configPath;

    const service = await createDexydApplication();

    try {
      service.context.opencodeSessionService.createSession = vi.fn(async () => ({
        id: 'ses-opencode-shadow',
        status: 'idle',
        profile: 'opencode',
        workspacePath: workspace,
        createdAt: '2026-06-15T08:00:00.000Z',
        updatedAt: '2026-06-15T08:00:00.000Z',
        source: 'opencode',
        title: 'OpenCode shadow',
        model: null,
        agent: 'build',
        tokenUsage: null,
        modelID: null,
        modelProviderID: null,
        summary: null,
        cost: null,
        tokens: null,
        slug: null,
        opencodePath: null,
        parentID: null
      }));

      const paired = await pairTestDevice(service.app);
      const authHeader = { authorization: `Bearer ${paired.accessToken}` };

      const created = await service.app.inject({
        method: 'POST',
        url: '/opencode/sessions',
        headers: authHeader,
        payload: { workspacePath: workspace, title: 'OpenCode shadow' }
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().session.source).toBe('opencode');

      const listed = await service.app.inject({
        method: 'GET',
        url: `/sessions?workspacePath=${encodeURIComponent(workspace)}`,
        headers: authHeader
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().sessions).toEqual([
        expect.objectContaining({
          id: 'ses-opencode-shadow',
          source: 'opencode',
          title: 'OpenCode shadow',
          workspacePath: workspace
        })
      ]);
    } finally {
      await service.stop();
    }
  });
});
