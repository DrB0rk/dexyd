import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

function writeConfig(tempDir: string): string {
  const configPath = join(tempDir, 'dexyd.yaml');
  writeFileSync(
    configPath,
    `server:\n  host: 127.0.0.1\n  port: 4555\nstorage:\n  sqlitePath: ${join(tempDir, 'dexyd.db')}\nauth:\n  signingKey: test-signing-key-value\ncodex:\n  workspaceRoot: ${tempDir}\n`
  );
  return configPath;
}

describe('file and diff APIs', () => {
  it('lists and reads files without allowing traversal', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-files-'));
    cleanupPaths.push(tempDir);
    const workspace = join(tempDir, 'workspace');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'README.md'), '# hello\n');

    process.env.DEXYD_CONFIG = writeConfig(tempDir);
    const service = await createDexydApplication();

    try {
      const paired = await pairTestDevice(service.app);
      const headers = { authorization: `Bearer ${paired.accessToken}` };
      const created = await service.app.inject({ method: 'POST', url: '/sessions', headers, payload: { workspacePath: workspace, profile: 'default' } });
      const sessionId = (created.json() as { session: { id: string } }).session.id;

      const outsideWorkspace = await service.app.inject({
        method: 'POST',
        url: '/sessions',
        headers,
        payload: { workspacePath: tmpdir(), profile: 'default' }
      });
      expect(outsideWorkspace.statusCode).toBe(400);

      const listed = await service.app.inject({ method: 'GET', url: `/sessions/${sessionId}/files`, headers });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().entries.some((entry: { name: string }) => entry.name === 'README.md')).toBe(true);

      const read = await service.app.inject({ method: 'GET', url: `/sessions/${sessionId}/files/read?path=README.md`, headers });
      expect(read.statusCode).toBe(200);
      expect(read.json().content).toContain('# hello');

      const traversal = await service.app.inject({ method: 'GET', url: `/sessions/${sessionId}/files/read?path=../secret`, headers });
      expect(traversal.statusCode).toBe(400);

      writeFileSync(join(tempDir, 'secret.txt'), 'secret');
      symlinkSync(join(tempDir, 'secret.txt'), join(workspace, 'linked-secret.txt'));
      const symlink = await service.app.inject({ method: 'GET', url: `/sessions/${sessionId}/files/read?path=linked-secret.txt`, headers });
      expect(symlink.statusCode).toBe(400);
    } finally {
      await service.stop();
    }
  });

  it('returns git diff summary for a session workspace', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-diff-'));
    cleanupPaths.push(tempDir);
    const workspace = join(tempDir, 'workspace');
    mkdirSync(workspace);
    execFileSync('git', ['init'], { cwd: workspace });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: workspace });
    writeFileSync(join(workspace, 'file.txt'), 'before\n');
    execFileSync('git', ['add', 'file.txt'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: workspace });
    writeFileSync(join(workspace, 'file.txt'), 'after\n');

    process.env.DEXYD_CONFIG = writeConfig(tempDir);
    const service = await createDexydApplication();

    try {
      const paired = await pairTestDevice(service.app);
      const headers = { authorization: `Bearer ${paired.accessToken}` };
      const created = await service.app.inject({ method: 'POST', url: '/sessions', headers, payload: { workspacePath: workspace, profile: 'default' } });
      const sessionId = (created.json() as { session: { id: string } }).session.id;

      const diff = await service.app.inject({ method: 'GET', url: `/sessions/${sessionId}/diff`, headers });
      expect(diff.statusCode).toBe(200);
      expect(diff.json().status).toContain('file.txt');
      expect(diff.json().diff).toContain('-before');
      expect(diff.json().diff).toContain('+after');
    } finally {
      await service.stop();
    }
  });
});
