import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDexydApplication } from '../src/app.js';
import { pairTestDevice } from './helpers.js';

const cleanupPaths: string[] = [];
const originalCodexHome = process.env.CODEX_HOME;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  delete process.env.DEXYD_CONFIG;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
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

  it('rejects new prompts when Codex usage limits are exhausted', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-chat-limit-'));
    cleanupPaths.push(tempDir);

    const workspace = join(tempDir, 'workspace');
    const codexHome = join(tempDir, 'codex-home');
    const sessionDir = join(codexHome, 'sessions');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    process.env.CODEX_HOME = codexHome;

    const fakeCodex = join(tempDir, 'fake-codex.sh');
    writeFileSync(fakeCodex, '#!/usr/bin/env bash\necho "should not run"\n');
    chmodSync(fakeCodex, 0o755);

    const sessionId = '77777777-7777-4777-8777-777777777777';
    writeFileSync(
      join(sessionDir, `rollout-${sessionId}.jsonl`),
      [
        rawTranscriptEntry('2026-06-01T10:00:00.000Z', 'session_meta', {
          cwd: workspace,
          timestamp: '2026-06-01T10:00:00.000Z'
        }),
        rawTranscriptEntry('2026-06-01T10:00:01.000Z', 'event_msg', {
          type: 'token_count',
          info: {
            total_token_usage: { total_tokens: 100 },
            last_token_usage: { total_tokens: 100 },
            model_context_window: 1000
          },
          rate_limits: {
            requests: {
              remaining: 0,
              limit: 100
            }
          }
        }),
        ''
      ].join('\n')
    );

    process.env.DEXYD_CONFIG = writeConfig(tempDir, fakeCodex);
    const service = await createDexydApplication();

    try {
      const paired = await pairTestDevice(service.app);
      const authHeader = { authorization: `Bearer ${paired.accessToken}` };

      const sent = await service.app.inject({
        method: 'POST',
        url: `/sessions/${sessionId}/chat`,
        headers: authHeader,
        payload: { message: 'please continue' }
      });

      expect(sent.statusCode).toBe(429);
      const body = sent.json() as { error: string; usage: { limits: { status: string; label: string } } };
      expect(body.error).toBe('usage_limit_reached');
      expect(body.usage.limits.status).toBe('error');
      expect(body.usage.limits.label).toBe('limit reached');
    } finally {
      await service.stop();
    }
  });
});

function rawTranscriptEntry(timestamp: string, type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp, type, payload });
}
