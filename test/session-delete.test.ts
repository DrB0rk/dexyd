import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDexydApplication } from '../src/app.js';
import { pairTestDevice } from './helpers.js';

const cleanupPaths: string[] = [];

afterEach(() => {
  delete process.env.DEXYD_CONFIG;
  for (const path of cleanupPaths.splice(0, cleanupPaths.length)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('session deletion', () => {
  it('removes local sessions and hides repeated/codex-backed ids from the session list', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-session-delete-'));
    cleanupPaths.push(tempDir);
    const workspaceRoot = join(tempDir, 'workspace');
    mkdirSync(workspaceRoot, { recursive: true });
    const configPath = join(tempDir, 'dexyd.yaml');
    writeFileSync(
      configPath,
      `server:\n  host: 127.0.0.1\n  port: 4555\nstorage:\n  sqlitePath: ${join(tempDir, 'dexyd.db')}\ncodex:\n  workspaceRoot: ${workspaceRoot}\n`,
    );

    process.env.DEXYD_CONFIG = configPath;
    const service = await createDexydApplication();

    try {
      const tokens = await pairTestDevice(service.app);
      const headers = { authorization: `Bearer ${tokens.accessToken}` };

      const created = await service.app.inject({
        method: 'POST',
        url: '/sessions',
        headers,
        payload: { workspacePath: '.', title: 'delete me' },
      });
      expect(created.statusCode).toBe(201);
      const sessionId = created.json().session.id as string;

      const deleted = await service.app.inject({ method: 'DELETE', url: `/sessions/${sessionId}`, headers });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json()).toMatchObject({ deleted: true, hidden: false });

      const listed = await service.app.inject({ method: 'GET', url: '/sessions', headers });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().sessions.map((session: { id: string }) => session.id)).not.toContain(sessionId);

      const hiddenOnly = await service.app.inject({ method: 'DELETE', url: '/sessions/11111111-1111-4111-8111-111111111111', headers });
      expect(hiddenOnly.statusCode).toBe(200);
      expect(hiddenOnly.json()).toMatchObject({ deleted: false, hidden: true });

      const codexStyleId = 'omx-1780346116228-qdcfss';
      const hiddenCodexStyle = await service.app.inject({ method: 'DELETE', url: `/sessions/${codexStyleId}`, headers });
      expect(hiddenCodexStyle.statusCode).toBe(200);
      expect(hiddenCodexStyle.json()).toMatchObject({ deleted: false, hidden: true });

      const unsafeId = await service.app.inject({ method: 'DELETE', url: '/sessions/../../bad', headers });
      expect(unsafeId.statusCode).toBe(404);
    } finally {
      await service.stop();
    }
  });

  it('lists hidden sessions, restores them, and includes child workspaces in project session filters', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-session-restore-'));
    cleanupPaths.push(tempDir);
    const workspaceRoot = join(tempDir, 'workspace');
    const projectRoot = join(workspaceRoot, 'dexyd');
    const nestedProjectDir = join(projectRoot, 'mobile');
    mkdirSync(nestedProjectDir, { recursive: true });
    const configPath = join(tempDir, 'dexyd.yaml');
    writeFileSync(
      configPath,
      `server:
  host: 127.0.0.1
  port: 4555
storage:
  sqlitePath: ${join(tempDir, 'dexyd.db')}
codex:
  workspaceRoot: ${workspaceRoot}
`,
    );

    process.env.DEXYD_CONFIG = configPath;
    const service = await createDexydApplication();

    try {
      const tokens = await pairTestDevice(service.app);
      const headers = { authorization: `Bearer ${tokens.accessToken}` };

      const created = await service.app.inject({
        method: 'POST',
        url: '/sessions',
        headers,
        payload: { workspacePath: projectRoot, title: 'project work' },
      });
      expect(created.statusCode).toBe(201);
      const sessionId = created.json().session.id as string;

      const nested = await service.app.inject({
        method: 'POST',
        url: '/sessions',
        headers,
        payload: { workspacePath: nestedProjectDir, title: 'nested work' },
      });
      expect(nested.statusCode).toBe(201);
      const nestedSessionId = nested.json().session.id as string;

      const listedByProject = await service.app.inject({
        method: 'GET',
        url: `/sessions?workspacePath=${encodeURIComponent(projectRoot)}&limit=20`,
        headers,
      });
      expect(listedByProject.statusCode).toBe(200);
      const listedProjectSessionIds = listedByProject.json().sessions.map((session: { id: string }) => session.id);
      expect(listedProjectSessionIds).toContain(sessionId);
      expect(listedProjectSessionIds).toContain(nestedSessionId);

      const deleted = await service.app.inject({ method: 'DELETE', url: `/sessions/${sessionId}`, headers });
      expect(deleted.statusCode).toBe(200);

      const hidden = await service.app.inject({ method: 'GET', url: '/sessions/hidden', headers });
      expect(hidden.statusCode).toBe(200);
      expect(hidden.json().sessions.map((session: { id: string }) => session.id)).toContain(sessionId);

      const restored = await service.app.inject({ method: 'POST', url: `/sessions/${sessionId}/restore`, headers, payload: {} });
      expect(restored.statusCode).toBe(200);
      expect(restored.json()).toMatchObject({ restored: true });

      const hiddenAfterRestore = await service.app.inject({ method: 'GET', url: '/sessions/hidden', headers });
      expect(hiddenAfterRestore.statusCode).toBe(200);
      expect(hiddenAfterRestore.json().sessions.map((session: { id: string }) => session.id)).not.toContain(sessionId);
    } finally {
      await service.stop();
    }
  });

});
