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

function writeConfig(tempDir: string): string {
  const configPath = join(tempDir, 'dexyd.yaml');
  writeFileSync(
    configPath,
    `server:\n  host: 127.0.0.1\n  port: 4555\nstorage:\n  sqlitePath: ${join(tempDir, 'dexyd.db')}\nauth:\n  signingKey: test-signing-key-value\nstream:\n  replayWindowSeconds: 600\n  maxReplayEvents: 500\ncodex:\n  workspaceRoot: ${tempDir}\n`
  );
  return configPath;
}

describe('milestone 2 sessions and replay', () => {
  it('supports session lifecycle and event replay', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-m2-'));
    cleanupPaths.push(tempDir);
    const workspace = join(tempDir, 'workspace');
    mkdirSync(workspace);
    process.env.DEXYD_CONFIG = writeConfig(tempDir);

    const service = await createDexydApplication();

    try {
      const paired = await pairTestDevice(service.app);
      const authHeader = { authorization: `Bearer ${paired.accessToken}` };

      const created = await service.app.inject({
        method: 'POST',
        url: '/sessions',
        headers: authHeader,
        payload: {
          workspacePath: workspace,
          profile: 'default'
        }
      });

      expect(created.statusCode).toBe(201);
      const createdBody = created.json() as { session: { id: string } };
      const sessionId = createdBody.session.id;

      const fetched = await service.app.inject({
        method: 'GET',
        url: `/sessions/${sessionId}`,
        headers: authHeader
      });
      expect(fetched.statusCode).toBe(200);

      const patched = await service.app.inject({
        method: 'PATCH',
        url: `/sessions/${sessionId}`,
        headers: authHeader,
        payload: { status: 'running' }
      });

      expect(patched.statusCode).toBe(200);
      expect(patched.json().session.status).toBe('running');

      const emitted = await service.app.inject({
        method: 'POST',
        url: `/sessions/${sessionId}/events`,
        headers: authHeader,
        payload: {
          eventType: 'stream.stdout',
          payload: { chunk: 'hello world' },
          source: 'session'
        }
      });

      expect(emitted.statusCode).toBe(201);

      const replay = await service.app.inject({
        method: 'GET',
        url: '/events/replay?lastSeenSequence=0',
        headers: authHeader
      });

      expect(replay.statusCode).toBe(200);
      const replayBody = replay.json() as {
        replayExpired: boolean;
        events: Array<{ eventType: string }>;
      };

      expect(replayBody.replayExpired).toBe(false);
      expect(replayBody.events.length).toBeGreaterThanOrEqual(3);
      expect(replayBody.events.some((event) => event.eventType === 'session.created')).toBe(true);
      expect(replayBody.events.some((event) => event.eventType === 'session.updated')).toBe(true);
      expect(replayBody.events.some((event) => event.eventType === 'stream.stdout')).toBe(true);
    } finally {
      await service.stop();
    }
  });
});
