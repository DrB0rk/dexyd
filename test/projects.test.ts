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

describe('project management', () => {
  it('starts in the default location while allowing system-wide project paths', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-projects-'));
    cleanupPaths.push(tempDir);
    const workspaceRoot = join(tempDir, 'workspaces');
    const outsideRoot = join(tempDir, 'outside-root');
    mkdirSync(join(workspaceRoot, 'existing'), { recursive: true });
    mkdirSync(outsideRoot, { recursive: true });

    const configPath = join(tempDir, 'dexyd.yaml');
    writeFileSync(
      configPath,
      `server:\n  host: 127.0.0.1\n  port: 4555\nstorage:\n  sqlitePath: ${join(tempDir, 'dexyd.db')}\ncodex:\n  workspaceRoot: ${workspaceRoot}\n`
    );

    process.env.DEXYD_CONFIG = configPath;
    const service = await createDexydApplication();

    try {
      const tokens = await pairTestDevice(service.app);
      const headers = { authorization: `Bearer ${tokens.accessToken}` };

      const listed = await service.app.inject({ method: 'GET', url: '/projects', headers });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().entries.map((entry: { name: string }) => entry.name)).toContain('existing');

      const created = await service.app.inject({
        method: 'POST',
        url: '/projects',
        headers,
        payload: { parentPath: '', name: 'new-project' }
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().project.path).toBe('~/new-project');

      const suggested = await service.app.inject({ method: 'GET', url: '/projects/suggest?path=ex', headers });
      expect(suggested.statusCode).toBe(200);
      expect(suggested.json().suggestions.map((entry: { name: string }) => entry.name)).toContain('existing');

      const parent = await service.app.inject({ method: 'GET', url: '/projects?path=..', headers });
      expect(parent.statusCode).toBe(200);
      expect(parent.json().entries.map((entry: { name: string }) => entry.name)).toContain('outside-root');

      const absolute = await service.app.inject({
        method: 'GET',
        url: `/projects?path=${encodeURIComponent(outsideRoot)}`,
        headers
      });
      expect(absolute.statusCode).toBe(200);
      expect(absolute.json().absolutePath).toBe(outsideRoot);
    } finally {
      await service.stop();
    }
  });
});
