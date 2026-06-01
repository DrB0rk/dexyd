import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDexydApplication } from '../src/app.js';
import { pairTestDevice } from './helpers.js';

const cleanupPaths: string[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  delete process.env.DEXYD_CONFIG;
  for (const path of cleanupPaths.splice(0, cleanupPaths.length)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function writeConfig(tempDir: string, fakeCodex: string): string {
  const configPath = join(tempDir, 'dexyd.yaml');
  writeFileSync(
    configPath,
    `server:\n  host: 127.0.0.1\n  port: 4555\nstorage:\n  sqlitePath: ${join(tempDir, 'dexyd.db')}\nauth:\n  signingKey: test-signing-key-value\nstream:\n  replayWindowSeconds: 600\n  maxReplayEvents: 500\ncodex:\n  runtimePath: ${fakeCodex}\n  workspaceRoot: ${tempDir}\n`
  );
  return configPath;
}

function writeHarnessConfig(tempDir: string, fakeHarness: string): string {
  const configPath = join(tempDir, 'dexyd-harness.yaml');
  writeFileSync(
    configPath,
    `server:\n  host: 127.0.0.1\n  port: 4555\nstorage:\n  sqlitePath: ${join(tempDir, 'dexyd.db')}\nauth:\n  signingKey: test-signing-key-value\nstream:\n  replayWindowSeconds: 600\n  maxReplayEvents: 500\ncodex:\n  runtimePath: codex-should-not-be-used\n  workspaceRoot: ${tempDir}\n  harness:\n    mode: omx\n    command: ${fakeHarness}\n    args:\n      - --direct\n`
  );
  return configPath;
}

describe('chat bridge', () => {
  it('accepts a chat prompt and records the assistant response', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-chat-'));
    cleanupPaths.push(tempDir);

    const workspace = join(tempDir, 'workspace');
    mkdirSync(workspace);

    const fakeCodex = join(tempDir, 'fake-codex.sh');
    writeFileSync(fakeCodex, '#!/usr/bin/env bash\necho "assistant response from fake codex"\n');
    chmodSync(fakeCodex, 0o755);

    process.env.DEXYD_CONFIG = writeConfig(tempDir, fakeCodex);
    const service = await createDexydApplication();

    try {
      const paired = await pairTestDevice(service.app);
      const authHeader = { authorization: `Bearer ${paired.accessToken}` };

      const created = await service.app.inject({
        method: 'POST',
        url: '/sessions',
        headers: authHeader,
        payload: { workspacePath: workspace, profile: 'default' }
      });
      const sessionId = (created.json() as { session: { id: string } }).session.id;

      const sent = await service.app.inject({
        method: 'POST',
        url: `/sessions/${sessionId}/chat`,
        headers: authHeader,
        payload: { message: 'hello' }
      });
      expect(sent.statusCode).toBe(202);

      let messages: Array<{ role: string; content: string }> = [];
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await service.app.inject({ method: 'GET', url: `/sessions/${sessionId}/chat`, headers: authHeader });
        messages = (response.json() as { messages: Array<{ role: string; content: string }> }).messages;
        if (messages.some((message) => message.role === 'assistant')) break;
        await sleep(25);
      }

      expect(messages.some((message) => message.role === 'user' && message.content === 'hello')).toBe(true);
      expect(messages.some((message) => message.role === 'assistant' && message.content.includes('assistant response'))).toBe(true);

      const finished = await service.app.inject({ method: 'GET', url: `/sessions/${sessionId}`, headers: authHeader });
      expect(finished.json().session.status).toBe('idle');
    } finally {
      await service.stop();
    }
  });

  it('reports a missing codex runtime once with actionable detail', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-chat-missing-'));
    cleanupPaths.push(tempDir);

    const workspace = join(tempDir, 'workspace');
    mkdirSync(workspace);

    process.env.DEXYD_CONFIG = writeConfig(tempDir, join(tempDir, 'missing-codex'));
    const service = await createDexydApplication();

    try {
      const paired = await pairTestDevice(service.app);
      const authHeader = { authorization: `Bearer ${paired.accessToken}` };

      const created = await service.app.inject({
        method: 'POST',
        url: '/sessions',
        headers: authHeader,
        payload: { workspacePath: workspace, profile: 'default' }
      });
      const sessionId = (created.json() as { session: { id: string } }).session.id;

      const sent = await service.app.inject({
        method: 'POST',
        url: `/sessions/${sessionId}/chat`,
        headers: authHeader,
        payload: { message: 'hello' }
      });
      expect(sent.statusCode).toBe(202);

      let messages: Array<{ role: string; content: string }> = [];
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await service.app.inject({ method: 'GET', url: `/sessions/${sessionId}/chat`, headers: authHeader });
        messages = (response.json() as { messages: Array<{ role: string; content: string }> }).messages;
        if (messages.some((message) => message.role === 'system')) break;
        await sleep(25);
      }

      const failures = messages.filter((message) => message.role === 'system');
      expect(failures).toHaveLength(1);
      expect(failures[0]?.content).toContain('Failed to start Codex launcher');
      expect(failures[0]?.content).not.toContain('code -2');

      const failed = await service.app.inject({ method: 'GET', url: `/sessions/${sessionId}`, headers: authHeader });
      expect(failed.json().session.status).toBe('failed');
    } finally {
      await service.stop();
    }
  });

  it('can launch chat turns through an OMX-compatible harness wrapper', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-chat-harness-'));
    cleanupPaths.push(tempDir);

    const workspace = join(tempDir, 'workspace');
    mkdirSync(workspace);

    const argsFile = join(tempDir, 'harness-args.txt');
    const fakeHarness = join(tempDir, 'fake-omx.sh');
    writeFileSync(
      fakeHarness,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argsFile}"\necho "assistant response from harness"\n`
    );
    chmodSync(fakeHarness, 0o755);

    process.env.DEXYD_CONFIG = writeHarnessConfig(tempDir, fakeHarness);
    const service = await createDexydApplication();

    try {
      const paired = await pairTestDevice(service.app);
      const authHeader = { authorization: `Bearer ${paired.accessToken}` };

      const created = await service.app.inject({
        method: 'POST',
        url: '/sessions',
        headers: authHeader,
        payload: { workspacePath: workspace, profile: 'default' }
      });
      const sessionId = (created.json() as { session: { id: string } }).session.id;

      const sent = await service.app.inject({
        method: 'POST',
        url: `/sessions/${sessionId}/chat`,
        headers: authHeader,
        payload: { message: 'hello from mobile' }
      });
      expect(sent.statusCode).toBe(202);

      let messages: Array<{ role: string; content: string }> = [];
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await service.app.inject({ method: 'GET', url: `/sessions/${sessionId}/chat`, headers: authHeader });
        messages = (response.json() as { messages: Array<{ role: string; content: string }> }).messages;
        if (messages.some((message) => message.role === 'assistant')) break;
        await sleep(25);
      }

      expect(messages.some((message) => message.role === 'assistant' && message.content.includes('assistant response from harness'))).toBe(true);
      const args = readFileSync(argsFile, 'utf8').trim().split('\n');
      expect(args.slice(0, 2)).toEqual(['--direct', 'exec']);
      expect(args).toContain('--skip-git-repo-check');
    } finally {
      await service.stop();
    }
  });
});
