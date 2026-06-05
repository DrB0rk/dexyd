import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
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

  it('does not carry stale mobile chat history into later Dexyd-created prompts', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-chat-no-history-'));
    cleanupPaths.push(tempDir);

    const workspace = join(tempDir, 'workspace');
    mkdirSync(workspace);

    const argsFile = join(tempDir, 'codex-args.txt');
    const fakeCodex = join(tempDir, 'fake-codex.sh');
    writeFileSync(
      fakeCodex,
      `#!/usr/bin/env bash
printf '%s\n' "$@" > "${argsFile}"
echo "assistant response"
`
    );
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

      const first = await service.app.inject({
        method: 'POST',
        url: `/sessions/${sessionId}/chat`,
        headers: authHeader,
        payload: { message: 'create a new release' }
      });
      expect(first.statusCode).toBe(202);

      for (let attempt = 0; attempt < 20; attempt += 1) {
        const args = existsSync(argsFile) ? readFileSync(argsFile, 'utf8') : '';
        if (args.includes('create a new release')) break;
        await sleep(25);
      }

      const second = await service.app.inject({
        method: 'POST',
        url: `/sessions/${sessionId}/chat`,
        headers: authHeader,
        payload: { message: 'what is 2+2?' }
      });
      expect(second.statusCode).toBe(202);

      let args = '';
      for (let attempt = 0; attempt < 20; attempt += 1) {
        args = existsSync(argsFile) ? readFileSync(argsFile, 'utf8') : '';
        if (args.trim().endsWith('what is 2+2?')) break;
        await sleep(25);
      }

      const lines = args.trim().split('\n');
      expect(lines.at(-1)).toBe('what is 2+2?');
      expect(lines.at(-1)).not.toContain('create a new release');
      expect(lines).toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(args).not.toContain('workspace-write');
      expect(args).not.toContain('Conversation so far');
      expect(args).not.toContain('Latest user message');
      expect(args).not.toContain('You are running inside dexyd');
    } finally {
      await service.stop();
    }
  });

  it('creates mobile sessions as Codex-backed sessions and resumes them without a local duplicate', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-chat-codex-session-'));
    cleanupPaths.push(tempDir);

    const workspace = join(tempDir, 'workspace');
    const codexHome = join(tempDir, 'codex-home');
    mkdirSync(workspace, { recursive: true });
    process.env.CODEX_HOME = codexHome;

    const argsFile = join(tempDir, 'codex-args.txt');
    const fakeCodex = join(tempDir, 'fake-codex.sh');
    writeFileSync(
      fakeCodex,
      `#!/usr/bin/env bash
printf '%s\n' "$@" > "${argsFile}"
echo "assistant response"
`
    );
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
        payload: { workspacePath: workspace, profile: 'default', source: 'codex', title: 'Mobile project chat' }
      });
      expect(created.statusCode).toBe(201);
      const session = (created.json() as { session: { id: string; source: string; title: string } }).session;
      expect(session.source).toBe('codex');
      expect(session.title).toBe('Mobile project chat');

      const listedBefore = await service.app.inject({ method: 'GET', url: '/sessions', headers: authHeader });
      const sessionsBefore = (listedBefore.json() as { sessions: Array<{ id: string }> }).sessions;
      expect(sessionsBefore.filter((item) => item.id === session.id)).toHaveLength(1);

      const sent = await service.app.inject({
        method: 'POST',
        url: `/sessions/${session.id}/chat`,
        headers: authHeader,
        payload: { message: 'hello from mobile' }
      });
      expect(sent.statusCode).toBe(202);

      let args = '';
      for (let attempt = 0; attempt < 20; attempt += 1) {
        args = existsSync(argsFile) ? readFileSync(argsFile, 'utf8') : '';
        if (args.includes('hello from mobile')) break;
        await sleep(25);
      }

      const lines = args.trim().split('\n');
      expect(lines).toContain('exec');
      expect(lines).toContain('resume');
      expect(lines).toContain(session.id);
      expect(lines.at(-1)).toBe('hello from mobile');
      expect(args).not.toContain('-C');

      const listedAfter = await service.app.inject({ method: 'GET', url: '/sessions', headers: authHeader });
      const sessionsAfter = (listedAfter.json() as { sessions: Array<{ id: string; source: string }> }).sessions;
      expect(sessionsAfter.filter((item) => item.id === session.id)).toHaveLength(1);
      expect(sessionsAfter.filter((item) => item.source === 'dexyd')).toHaveLength(0);
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


  it('queues prompts while a session is busy and drains them after the active turn', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-chat-queue-'));
    cleanupPaths.push(tempDir);

    const workspace = join(tempDir, 'workspace');
    mkdirSync(workspace);

    const fakeCodex = join(tempDir, 'fake-codex.sh');
    writeFileSync(fakeCodex, '#!/usr/bin/env bash\nsleep 0.15\necho "assistant response from queue fake"\n');
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

      const first = await service.app.inject({
        method: 'POST',
        url: `/sessions/${sessionId}/chat`,
        headers: authHeader,
        payload: { message: 'first' }
      });
      expect(first.statusCode).toBe(202);
      expect((first.json() as { queued: boolean }).queued).toBe(false);

      const second = await service.app.inject({
        method: 'POST',
        url: `/sessions/${sessionId}/chat`,
        headers: authHeader,
        payload: { message: 'second' }
      });
      expect(second.statusCode).toBe(202);
      const secondBody = second.json() as { queued: boolean; queueId: string };
      expect(secondBody.queued).toBe(true);
      expect(secondBody.queueId).toBeTruthy();

      const third = await service.app.inject({
        method: 'POST',
        url: `/sessions/${sessionId}/chat`,
        headers: authHeader,
        payload: { message: 'third' }
      });
      const thirdBody = third.json() as { queued: boolean; queueId: string };
      expect(thirdBody.queued).toBe(true);

      const steered = await service.app.inject({
        method: 'POST',
        url: `/sessions/${sessionId}/queue/${secondBody.queueId}/steer`,
        headers: authHeader,
        payload: { message: 'prefer the short answer' }
      });
      expect(steered.statusCode).toBe(200);
      expect((steered.json() as { queued: { content: string } }).queued.content).toContain('Steering note: prefer the short answer');

      const removed = await service.app.inject({
        method: 'DELETE',
        url: `/sessions/${sessionId}/queue/${thirdBody.queueId}`,
        headers: authHeader
      });
      expect(removed.statusCode).toBe(200);
      expect((removed.json() as { removed: boolean }).removed).toBe(true);

      let queue: Array<{ queueId: string; content: string }> = [];
      const queued = await service.app.inject({ method: 'GET', url: `/sessions/${sessionId}/queue`, headers: authHeader });
      queue = (queued.json() as { queue: Array<{ queueId: string; content: string }> }).queue;
      expect(queue).toHaveLength(1);
      expect(queue[0]?.content).toContain('prefer the short answer');

      let messages: Array<{ role: string; content: string; status: string }> = [];
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const response = await service.app.inject({ method: 'GET', url: `/sessions/${sessionId}/chat`, headers: authHeader });
        messages = (response.json() as { messages: Array<{ role: string; content: string; status: string }> }).messages;
        if (messages.filter((message) => message.role === 'assistant').length >= 2) break;
        await sleep(25);
      }

      expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(2);
      expect(messages.some((message) => message.role === 'user' && message.content.includes('Steering note: prefer the short answer'))).toBe(true);

      const empty = await service.app.inject({ method: 'GET', url: `/sessions/${sessionId}/queue`, headers: authHeader });
      expect((empty.json() as { queue: unknown[] }).queue).toHaveLength(0);
    } finally {
      await service.stop();
    }
  }, 15_000);

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

  it('prefers live Codex transcript status over a stale local duplicate session', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-chat-duplicate-status-'));
    cleanupPaths.push(tempDir);

    const workspace = join(tempDir, 'workspace');
    const codexHome = join(tempDir, 'codex-home');
    const sessionDir = join(codexHome, 'sessions');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    process.env.CODEX_HOME = codexHome;

    const fakeCodex = join(tempDir, 'fake-codex.sh');
    writeFileSync(fakeCodex, '#!/usr/bin/env bash\necho unused\n');
    chmodSync(fakeCodex, 0o755);

    const sessionId = '98989898-9898-4989-8989-989898989898';
    writeFileSync(
      join(sessionDir, `rollout-${sessionId}.jsonl`),
      [
        rawTranscriptEntry('2026-06-01T10:00:00.000Z', 'session_meta', {
          cwd: workspace,
          timestamp: '2026-06-01T10:00:00.000Z'
        }),
        rawTranscriptEntry(new Date().toISOString(), 'event_msg', {
          type: 'task_started',
          turn_id: 'turn-open'
        }),
        rawTranscriptEntry(new Date().toISOString(), 'event_msg', {
          type: 'user_message',
          message: 'active from desktop'
        }),
        ''
      ].join('\n')
    );

    process.env.DEXYD_CONFIG = writeConfig(tempDir, fakeCodex);
    const service = await createDexydApplication();

    try {
      const db = new Database(service.context.config.storage.sqlitePath);
      try {
        db.prepare(
          `INSERT INTO sessions (id, status, profile, workspace_path, created_at, updated_at, title)
           VALUES (?, 'idle', 'default', ?, ?, ?, 'stale local')`
        ).run(sessionId, workspace, '2026-06-01T09:00:00.000Z', '2026-06-01T09:00:00.000Z');
      } finally {
        db.close();
      }

      const paired = await pairTestDevice(service.app);
      const authHeader = { authorization: `Bearer ${paired.accessToken}` };

      const listed = await service.app.inject({ method: 'GET', url: '/sessions', headers: authHeader });
      const sessions = (listed.json() as { sessions: Array<{ id: string; status: string }> }).sessions;
      expect(sessions.filter((session) => session.id === sessionId)).toHaveLength(1);
      expect(sessions.find((session) => session.id === sessionId)?.status).toBe('running');

      const fetched = await service.app.inject({ method: 'GET', url: `/sessions/${sessionId}`, headers: authHeader });
      expect(fetched.json().session.status).toBe('running');
    } finally {
      await service.stop();
    }
  });

  it('sends only the raw app message when resuming a Codex-backed session', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-chat-codex-raw-prompt-'));
    cleanupPaths.push(tempDir);

    const workspace = join(tempDir, 'workspace');
    const codexHome = join(tempDir, 'codex-home');
    const sessionDir = join(codexHome, 'sessions');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    process.env.CODEX_HOME = codexHome;

    const argsFile = join(tempDir, 'codex-args.txt');
    const fakeCodex = join(tempDir, 'fake-codex.sh');
    writeFileSync(
      fakeCodex,
      `#!/usr/bin/env bash
printf '%s\n' "$@" > "${argsFile}"
echo "raw prompt response"
`
    );
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
          type: 'user_message',
          message: 'old desktop message',
          turn_id: 'old-turn'
        }),
        rawTranscriptEntry('2026-06-01T10:00:02.000Z', 'response_item', {
          type: 'message',
          role: 'assistant',
          turn_id: 'old-turn',
          content: [{ type: 'output_text', text: 'old assistant answer' }]
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
        payload: { message: 'new app message only' }
      });
      expect(sent.statusCode).toBe(202);

      for (let attempt = 0; attempt < 20 && !existsSync(argsFile); attempt += 1) {
        await sleep(25);
      }

      const args = readFileSync(argsFile, 'utf8').trim().split('\n');
      expect(args.slice(0, 5)).toEqual(['exec', 'resume', '--all', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox']);
      expect(args).toContain(sessionId);
      expect(args.at(-1)).toBe('new app message only');
      expect(args.at(-1)).not.toContain('Conversation so far');
      expect(args.at(-1)).not.toContain('old assistant answer');
      expect(args.at(-1)).not.toContain('You are running inside dexyd');
    } finally {
      await service.stop();
    }
  });

  it('reports Codex-backed sessions as running while a mobile-started turn is active', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-chat-codex-status-'));
    cleanupPaths.push(tempDir);

    const workspace = join(tempDir, 'workspace');
    const codexHome = join(tempDir, 'codex-home');
    const sessionDir = join(codexHome, 'sessions');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    process.env.CODEX_HOME = codexHome;

    const fakeCodex = join(tempDir, 'fake-codex.sh');
    writeFileSync(fakeCodex, '#!/usr/bin/env bash\nsleep 0.2\necho "codex-backed response"\n');
    chmodSync(fakeCodex, 0o755);

    const sessionId = '88888888-8888-4888-8888-888888888888';
    writeFileSync(
      join(sessionDir, `rollout-${sessionId}.jsonl`),
      [
        rawTranscriptEntry('2026-06-01T10:00:00.000Z', 'session_meta', {
          cwd: workspace,
          timestamp: '2026-06-01T10:00:00.000Z'
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
        payload: { message: 'continue this codex session' }
      });
      expect(sent.statusCode).toBe(202);

      const active = await service.app.inject({ method: 'GET', url: `/sessions/${sessionId}`, headers: authHeader });
      expect(active.json().session.status).toBe('running');

      const listed = await service.app.inject({ method: 'GET', url: '/sessions', headers: authHeader });
      const sessions = (listed.json() as { sessions: Array<{ id: string; status: string }> }).sessions;
      expect(sessions.find((session) => session.id === sessionId)?.status).toBe('running');

      for (let attempt = 0; attempt < 30; attempt += 1) {
        const response = await service.app.inject({ method: 'GET', url: `/sessions/${sessionId}`, headers: authHeader });
        if (response.json().session.status === 'idle') return;
        await sleep(25);
      }

      const finished = await service.app.inject({ method: 'GET', url: `/sessions/${sessionId}`, headers: authHeader });
      expect(finished.json().session.status).toBe('idle');
    } finally {
      await service.stop();
    }
  });

  it('captures code diffs for the completed chat turn only', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-chat-turn-diff-'));
    cleanupPaths.push(tempDir);

    const workspace = join(tempDir, 'workspace');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'preexisting.txt'), 'dirty before turn\n');
    writeFileSync(join(workspace, 'changed.txt'), 'before\n');

    const fakeCodex = join(tempDir, 'fake-codex.sh');
    writeFileSync(
      fakeCodex,
      [
        '#!/usr/bin/env bash',
        'printf "after\\n" > changed.txt',
        'mkdir -p src',
        'printf "new file\\n" > src/new.txt',
        'echo "changed files"',
        ''
      ].join('\n')
    );
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
        payload: { message: 'edit files' }
      });
      expect(sent.statusCode).toBe(202);
      const turnId = (sent.json() as { turnId: string }).turnId;

      for (let attempt = 0; attempt < 30; attempt += 1) {
        const response = await service.app.inject({ method: 'GET', url: `/sessions/${sessionId}/chat`, headers: authHeader });
        const messages = (response.json() as { messages: Array<{ role: string }> }).messages;
        if (messages.some((message) => message.role === 'assistant')) break;
        await sleep(25);
      }

      const diff = await service.app.inject({
        method: 'GET',
        url: `/sessions/${sessionId}/diff?turnId=${encodeURIComponent(turnId)}`,
        headers: authHeader
      });
      expect(diff.statusCode).toBe(200);
      const body = diff.json() as { status: string; diff: string; stat: string };
      expect(body.status).toContain('M changed.txt');
      expect(body.status).toContain('A src/new.txt');
      expect(body.status).not.toContain('preexisting.txt');
      expect(body.diff).toContain('-before');
      expect(body.diff).toContain('+after');
      expect(body.diff).toContain('+new file');
      expect(body.diff).not.toContain('dirty before turn');

      const missing = await service.app.inject({
        method: 'GET',
        url: `/sessions/${sessionId}/diff?turnId=missing-turn`,
        headers: authHeader
      });
      expect(missing.statusCode).toBe(200);
      expect((missing.json() as { diff: string }).diff).toBe('');
    } finally {
      await service.stop();
    }
  });
});

function rawTranscriptEntry(timestamp: string, type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp, type, payload });
}
