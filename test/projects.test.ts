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
  it('browses, suggests, and creates projects inside the configured workspace root', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-projects-'));
    cleanupPaths.push(tempDir);
    const workspaceRoot = join(tempDir, 'workspaces');
    mkdirSync(join(workspaceRoot, 'existing'), { recursive: true });

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

      const escaped = await service.app.inject({ method: 'GET', url: '/projects?path=..', headers });
      expect(escaped.statusCode).toBe(400);
    } finally {
      await service.stop();
    }
  });
});
