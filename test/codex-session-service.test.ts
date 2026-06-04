import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexSessionService } from '../src/services/codex-session-service.js';

const cleanupPaths: string[] = [];
const originalCodexHome = process.env.CODEX_HOME;

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;

  for (const path of cleanupPaths.splice(0, cleanupPaths.length)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('codex session transcript chat projection', () => {
  it('creates a Codex-backed session transcript that Dexyd can list and resume', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-codex-create-'));
    cleanupPaths.push(tempDir);
    const workspace = join(tempDir, 'workspace');
    const codexHome = join(tempDir, 'codex-home');
    mkdirSync(workspace, { recursive: true });
    process.env.CODEX_HOME = codexHome;

    const service = new CodexSessionService(workspace, { warn: () => undefined });
    const created = service.createSession({ workspacePath: workspace, title: 'Mobile session' });

    expect(created.source).toBe('codex');
    expect(created.workspacePath).toBe(workspace);
    expect(created.title).toBe('Mobile session');
    expect(existsSync(created.codexSessionPath)).toBe(true);

    const transcript = readFileSync(created.codexSessionPath, 'utf8');
    expect(transcript).toContain('"type":"session_meta"');
    expect(transcript).toContain(`"id":"${created.id}"`);
    expect(existsSync(join(codexHome, 'history.jsonl'))).toBe(false);
    expect(readFileSync(join(codexHome, 'session_index.jsonl'), 'utf8')).toContain('Mobile session');
    expect(service.listSessions()).toHaveLength(1);
    expect(service.getSession(created.id)?.id).toBe(created.id);
  });

  it('shows compact progress for active tool work without raw tool output', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-codex-transcript-'));
    cleanupPaths.push(tempDir);
    const workspace = join(tempDir, 'workspace');
    const codexHome = join(tempDir, 'codex-home');
    const sessionDir = join(codexHome, 'sessions');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    process.env.CODEX_HOME = codexHome;

    const sessionId = '11111111-1111-4111-8111-111111111111';
    writeFileSync(
      join(sessionDir, `rollout-${sessionId}.jsonl`),
      [
        entry('session_meta', { cwd: workspace, timestamp: '2026-06-01T10:00:00.000Z' }),
        entry('event_msg', { type: 'user_message', message: 'run checks', turn_id: 'turn-1' }),
        entry('response_item', {
          type: 'function_call',
          call_id: 'call-1',
          name: 'exec_command',
          turn_id: 'turn-1',
          arguments: '{"cmd":"npm test"}'
        }),
        entry('response_item', {
          type: 'function_call_output',
          call_id: 'call-1',
          output: 'Chunk ID: abc\nWall time: 1s\nExit code: 0\nOutput:\nsecret raw command output'
        }),
        ''
      ].join('\n')
    );

    const service = new CodexSessionService(workspace, { warn: () => undefined });
    const messages = service.getMessages(sessionId);

    expect(messages.map((message) => message.role)).toEqual(['user', 'tool']);
    expect(messages[1]?.content).toBe('Command finished · npm test.');
    expect(messages[1]?.content).not.toContain('Chunk ID');
    expect(messages[1]?.content).not.toContain('secret raw command output');
  });

  it('hides completed tool progress once the assistant answer is available', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-codex-transcript-'));
    cleanupPaths.push(tempDir);
    const workspace = join(tempDir, 'workspace');
    const codexHome = join(tempDir, 'codex-home');
    const sessionDir = join(codexHome, 'sessions');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    process.env.CODEX_HOME = codexHome;

    const sessionId = '22222222-2222-4222-8222-222222222222';
    writeFileSync(
      join(sessionDir, `rollout-${sessionId}.jsonl`),
      [
        entry('session_meta', { cwd: workspace, timestamp: '2026-06-01T10:00:00.000Z' }),
        entry('event_msg', { type: 'user_message', message: 'fix it', turn_id: 'turn-2' }),
        entry('response_item', {
          type: 'custom_tool_call',
          call_id: 'call-2',
          name: 'apply_patch',
          turn_id: 'turn-2',
          input: '*** Begin Patch'
        }),
        entry('response_item', {
          type: 'custom_tool_call_output',
          call_id: 'call-2',
          output: 'Exit code: 0'
        }),
        entry('response_item', {
          type: 'message',
          role: 'assistant',
          turn_id: 'turn-2',
          content: [{ type: 'output_text', text: 'Done.' }]
        }),
        ''
      ].join('\n')
    );

    const service = new CodexSessionService(workspace, { warn: () => undefined });
    const messages = service.getMessages(sessionId);

    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messages[1]?.content).toBe('Done.');
  });

  it('shows the current running command without raw tool output', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-codex-running-tool-'));
    cleanupPaths.push(tempDir);
    const workspace = join(tempDir, 'workspace');
    const codexHome = join(tempDir, 'codex-home');
    const sessionDir = join(codexHome, 'sessions');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    process.env.CODEX_HOME = codexHome;

    const sessionId = '12121212-1212-4121-8121-121212121212';
    writeFileSync(
      join(sessionDir, `rollout-${sessionId}.jsonl`),
      [
        entry('session_meta', { cwd: workspace, timestamp: '2026-06-01T10:00:00.000Z' }),
        entry('event_msg', { type: 'user_message', message: 'check lint', turn_id: 'turn-1' }),
        entry('response_item', {
          type: 'function_call',
          call_id: 'call-1',
          name: 'exec_command',
          turn_id: 'turn-1',
          arguments: JSON.stringify({ cmd: 'npm run lint -- --quiet', workdir: 'mobile/dexydMobile' })
        }),
        ''
      ].join('\n')
    );

    const service = new CodexSessionService(workspace, { warn: () => undefined });
    const messages = service.getMessages(sessionId);

    expect(messages.map((message) => message.role)).toEqual(['user', 'tool']);
    expect(messages[1]?.status).toBe('running');
    expect(messages[1]?.content).toBe('Running command · npm run lint -- --quiet @ mobile/dexydMobile…');
    expect(messages[1]?.content).not.toContain('arguments');
  });


  it('shows only the latest user message from Dexyd wrapper prompts', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-codex-wrapper-prompt-'));
    cleanupPaths.push(tempDir);
    const workspace = join(tempDir, 'workspace');
    const codexHome = join(tempDir, 'codex-home');
    const sessionDir = join(codexHome, 'sessions');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    process.env.CODEX_HOME = codexHome;

    const sessionId = '90909090-9090-4909-8909-909090909090';
    writeFileSync(
      join(sessionDir, `rollout-${sessionId}.jsonl`),
      [
        entry('session_meta', { cwd: workspace, timestamp: '2026-06-01T10:00:00.000Z' }),
        entry('event_msg', {
          type: 'user_message',
          turn_id: 'turn-wrapper',
          message: [
            'You are running inside dexyd as the assistant for a mobile chat session.',
            '',
            'Answer concisely and directly.',
            '',
            'Conversation so far:',
            'USER: older question',
            '',
            'ASSISTANT: older answer that must not appear as user text',
            '',
            'Latest user message:',
            'fix the chat flow'
          ].join('\n')
        }),
        entry('response_item', {
          type: 'message',
          role: 'assistant',
          turn_id: 'turn-wrapper',
          content: [{ type: 'output_text', text: 'Fixed.' }]
        }),
        ''
      ].join('\n')
    );

    const service = new CodexSessionService(workspace, { warn: () => undefined });
    const messages = service.getMessages(sessionId);

    expect(messages.map((message) => `${message.role}:${message.content}`)).toEqual([
      'user:fix the chat flow',
      'assistant:Fixed.'
    ]);
  });

  it('extracts the latest prompt from nested environment wrapper transcript messages', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-codex-nested-wrapper-'));
    cleanupPaths.push(tempDir);
    const workspace = join(tempDir, 'workspace');
    const codexHome = join(tempDir, 'codex-home');
    const sessionDir = join(codexHome, 'sessions');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    process.env.CODEX_HOME = codexHome;

    const sessionId = '91919191-9191-4919-8919-919191919191';
    writeFileSync(
      join(sessionDir, `rollout-${sessionId}.jsonl`),
      [
        entry('session_meta', { cwd: workspace, timestamp: '2026-06-01T10:00:00.000Z' }),
        entry('event_msg', {
          type: 'user_message',
          turn_id: 'turn-nested-wrapper',
          message: [
            '<environment_context>',
            '  <current_date>2026-06-04</current_date>',
            '  <filesystem><workspace_roots><root>/home/drb0rk/Projects/dexyd</root></workspace_roots></filesystem>',
            '</environment_context>',
            '',
            'USER: You are running inside dexyd as the assistant for a mobile chat session.',
            '',
            'Conversation so far:',
            'ASSISTANT: older release details that must not appear as user text',
            '',
            'Latest user message:',
            'Make text in the chat copyable.'
          ].join('\n')
        }),
        entry('response_item', {
          type: 'message',
          role: 'assistant',
          turn_id: 'turn-nested-wrapper',
          content: [{ type: 'output_text', text: 'Done.' }]
        }),
        ''
      ].join('\n')
    );

    const service = new CodexSessionService(workspace, { warn: () => undefined });
    const messages = service.getMessages(sessionId);

    expect(messages.map((message) => `${message.role}:${message.content}`)).toEqual([
      'user:Make text in the chat copyable.',
      'assistant:Done.'
    ]);
  });

  it('renders OMX hook prompts as automation instead of user messages', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-codex-transcript-'));
    cleanupPaths.push(tempDir);
    const workspace = join(tempDir, 'workspace');
    const codexHome = join(tempDir, 'codex-home');
    const sessionDir = join(codexHome, 'sessions');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    process.env.CODEX_HOME = codexHome;

    const sessionId = '33333333-3333-4333-8333-333333333333';
    writeFileSync(
      join(sessionDir, `rollout-${sessionId}.jsonl`),
      [
        entry('session_meta', { cwd: workspace, timestamp: '2026-06-01T10:00:00.000Z' }),
        entry('response_item', {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: '<hook_prompt hook_run_id="stop:1:test">OMX autopilot is still active (phase: deep-interview); continue the task and gather fresh verification evidence before stopping.</hook_prompt>'
            }
          ]
        }),
        ''
      ].join('\n')
    );

    const service = new CodexSessionService(workspace, { warn: () => undefined });
    const messages = service.getMessages(sessionId);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toBe('OMX automation: continuing the active autopilot task.');
    expect(messages[0]?.content).not.toContain('<hook_prompt');
  });

  it('deduplicates adjacent user transcript mirrors with tiny timestamp differences', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-codex-transcript-'));
    cleanupPaths.push(tempDir);
    const workspace = join(tempDir, 'workspace');
    const codexHome = join(tempDir, 'codex-home');
    const sessionDir = join(codexHome, 'sessions');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    process.env.CODEX_HOME = codexHome;

    const sessionId = '44444444-4444-4444-8444-444444444444';
    writeFileSync(
      join(sessionDir, `rollout-${sessionId}.jsonl`),
      [
        rawEntry('2026-06-01T10:00:00.000Z', 'session_meta', {
          cwd: workspace,
          timestamp: '2026-06-01T10:00:00.000Z'
        }),
        rawEntry('2026-06-01T10:00:01.000Z', 'response_item', {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'open settings' }]
        }),
        rawEntry('2026-06-01T10:00:01.001Z', 'event_msg', {
          type: 'user_message',
          message: 'open settings'
        }),
        ''
      ].join('\n')
    );

    const service = new CodexSessionService(workspace, { warn: () => undefined });
    const messages = service.getMessages(sessionId);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.content).toBe('open settings');
  });

  it('keeps a session running while Codex is reasoning between completed tool calls', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-codex-reasoning-session-'));
    cleanupPaths.push(tempDir);
    const workspace = join(tempDir, 'workspace');
    const codexHome = join(tempDir, 'codex-home');
    const sessionDir = join(codexHome, 'sessions');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    process.env.CODEX_HOME = codexHome;

    const sessionId = '78787878-7878-4787-8787-787878787878';
    writeFileSync(
      join(sessionDir, `rollout-${sessionId}.jsonl`),
      [
        entry('session_meta', { cwd: workspace, timestamp: '2026-06-01T10:00:00.000Z' }),
        entry('event_msg', { type: 'user_message', message: 'still working' }),
        entry('response_item', {
          type: 'function_call',
          call_id: 'call-done',
          name: 'exec_command',
          arguments: JSON.stringify({ cmd: 'npm test' })
        }),
        entry('response_item', {
          type: 'function_call_output',
          call_id: 'call-done',
          output: 'Exit code: 0'
        }),
        entry('event_msg', { type: 'token_count', info: { last_token_usage: { total_tokens: 10 } } }),
        entry('response_item', { type: 'reasoning', summary: [] }),
        ''
      ].join('\n')
    );

    const service = new CodexSessionService(workspace, { warn: () => undefined });
    const session = service.listSessions().find((item) => item.id === sessionId);

    expect(session?.status).toBe('running');
  });

  it('marks Codex transcript sessions running while a task is open', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-codex-active-session-'));
    cleanupPaths.push(tempDir);
    const workspace = join(tempDir, 'workspace');
    const codexHome = join(tempDir, 'codex-home');
    const sessionDir = join(codexHome, 'sessions');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    process.env.CODEX_HOME = codexHome;

    const runningSessionId = '34343434-3434-4343-8434-343434343434';
    writeFileSync(
      join(sessionDir, `rollout-${runningSessionId}.jsonl`),
      [
        entry('session_meta', { cwd: workspace, timestamp: '2026-06-01T10:00:00.000Z' }),
        entry('event_msg', { type: 'task_started', turn_id: 'turn-open', started_at: Date.now() / 1000 }),
        entry('event_msg', { type: 'user_message', message: 'still working', turn_id: 'turn-open' }),
        ''
      ].join('\n')
    );

    const completedSessionId = '45454545-4545-4545-8545-454545454545';
    writeFileSync(
      join(sessionDir, `rollout-${completedSessionId}.jsonl`),
      [
        entry('session_meta', { cwd: workspace, timestamp: '2026-06-01T10:00:00.000Z' }),
        entry('event_msg', { type: 'task_started', turn_id: 'turn-done', started_at: Date.now() / 1000 }),
        entry('event_msg', { type: 'task_complete', turn_id: 'turn-done', completed_at: Date.now() / 1000 }),
        ''
      ].join('\n')
    );

    const service = new CodexSessionService(workspace, { warn: () => undefined });
    const sessions = service.listSessions();

    expect(sessions.find((session) => session.id === runningSessionId)?.status).toBe('running');
    expect(sessions.find((session) => session.id === completedSessionId)?.status).toBe('idle');
  });

  it('adds per-session context usage to session list entries', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-codex-session-context-'));
    cleanupPaths.push(tempDir);
    const workspace = join(tempDir, 'workspace');
    const codexHome = join(tempDir, 'codex-home');
    const sessionDir = join(codexHome, 'sessions');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    process.env.CODEX_HOME = codexHome;

    const sessionId = '56565656-5656-4656-8565-565656565656';
    writeFileSync(
      join(sessionDir, `rollout-${sessionId}.jsonl`),
      [
        entry('session_meta', { cwd: workspace, timestamp: '2026-06-01T10:00:00.000Z' }),
        entry('event_msg', {
          type: 'token_count',
          info: {
            last_token_usage: { total_tokens: 420 },
            model_context_window: 1000
          }
        }),
        ''
      ].join('\n')
    );

    const service = new CodexSessionService(workspace, { warn: () => undefined });
    const session = service.listSessions().find((item) => item.id === sessionId);

    expect(session?.usageContext?.percent).toBe(42);
    expect(session?.usageContext?.status).toBe('ok');
  });

  it('reports context usage and limit status from Codex token telemetry', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-codex-transcript-'));
    cleanupPaths.push(tempDir);
    const workspace = join(tempDir, 'workspace');
    const codexHome = join(tempDir, 'codex-home');
    const sessionDir = join(codexHome, 'sessions');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    process.env.CODEX_HOME = codexHome;

    const sessionId = '55555555-5555-4555-8555-555555555555';
    writeFileSync(
      join(sessionDir, `rollout-${sessionId}.jsonl`),
      [
        rawEntry('2026-06-01T10:00:00.000Z', 'session_meta', {
          cwd: workspace,
          timestamp: '2026-06-01T10:00:00.000Z'
        }),
        rawEntry('2026-06-01T10:00:02.000Z', 'event_msg', {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 200,
              output_tokens: 50,
              reasoning_output_tokens: 10,
              total_tokens: 1050
            },
            last_token_usage: {
              input_tokens: 800,
              cached_input_tokens: 100,
              output_tokens: 50,
              reasoning_output_tokens: 10,
              total_tokens: 850
            },
            model_context_window: 1000
          },
          rate_limits: {
            requests: {
              remaining: 12,
              limit: 100
            }
          }
        }),
        ''
      ].join('\n')
    );

    const service = new CodexSessionService(workspace, { warn: () => undefined });
    const usage = service.getUsageStatus(sessionId);

    expect(usage.sessionId).toBe(sessionId);
    expect(usage.context.percent).toBe(85);
    expect(usage.context.status).toBe('warn');
    expect(usage.limits.status).toBe('warn');
    expect(usage.last?.totalTokens).toBe(850);
  });

  it('converts Codex used_percent account telemetry into remaining usage', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-codex-used-percent-'));
    cleanupPaths.push(tempDir);
    const workspace = join(tempDir, 'workspace');
    const codexHome = join(tempDir, 'codex-home');
    const sessionDir = join(codexHome, 'sessions');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    process.env.CODEX_HOME = codexHome;

    const sessionId = '67676767-6767-4676-8767-676767676767';
    writeFileSync(
      join(sessionDir, `rollout-${sessionId}.jsonl`),
      [
        entry('session_meta', { cwd: workspace, timestamp: '2026-06-01T10:00:00.000Z' }),
        entry('event_msg', {
          type: 'token_count',
          info: {
            last_token_usage: { total_tokens: 100 },
            model_context_window: 1000
          },
          rate_limits: {
            primary: {
              used_percent: 21,
              window_minutes: 10080
            }
          }
        }),
        ''
      ].join('\n')
    );

    const service = new CodexSessionService(workspace, { warn: () => undefined });
    const usage = service.getUsageStatus(sessionId);

    expect(usage.limits.status).toBe('ok');
    expect(usage.limits.label).toBe('limits ok');
    expect(usage.limits.detail).toBe('79% remaining');
  });


  it('does not promote high context usage into a usage warning', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-codex-context-'));
    cleanupPaths.push(tempDir);
    const workspace = join(tempDir, 'workspace');
    const codexHome = join(tempDir, 'codex-home');
    const sessionDir = join(codexHome, 'sessions');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    process.env.CODEX_HOME = codexHome;

    const sessionId = '66666666-6666-4666-8666-666666666666';
    writeFileSync(
      join(sessionDir, `rollout-${sessionId}.jsonl`),
      [
        rawEntry('2026-06-01T10:00:00.000Z', 'session_meta', {
          cwd: workspace,
          timestamp: '2026-06-01T10:00:00.000Z'
        }),
        rawEntry('2026-06-01T10:00:02.000Z', 'event_msg', {
          type: 'token_count',
          info: {
            last_token_usage: { total_tokens: 990 },
            model_context_window: 1000
          }
        }),
        ''
      ].join('\n')
    );

    const service = new CodexSessionService(workspace, { warn: () => undefined });
    const usage = service.getUsageStatus(sessionId);

    expect(usage.context.percent).toBe(99);
    expect(usage.context.status).toBe('error');
    expect(usage.limits.status).toBe('unknown');
    expect(usage.status).toBe('ok');
  });


  it('rejects Codex sessions whose real workspace path escapes the configured root', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-codex-symlink-'));
    cleanupPaths.push(tempDir);
    const workspaceRoot = join(tempDir, 'workspace-root');
    const outside = join(tempDir, 'outside-workspace');
    const symlinked = join(workspaceRoot, 'linked-outside');
    const codexHome = join(tempDir, 'codex-home');
    const sessionDir = join(codexHome, 'sessions');
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(outside, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    symlinkSync(outside, symlinked, 'dir');
    process.env.CODEX_HOME = codexHome;

    const sessionId = '66666666-6666-4666-8666-666666666666';
    writeFileSync(
      join(sessionDir, `rollout-${sessionId}.jsonl`),
      [
        rawEntry('2026-06-01T10:00:00.000Z', 'session_meta', {
          cwd: symlinked,
          timestamp: '2026-06-01T10:00:00.000Z'
        }),
        ''
      ].join('\n')
    );

    const service = new CodexSessionService(workspaceRoot, { warn: () => undefined });

    expect(service.listSessions()).toHaveLength(0);
    expect(service.getSession(sessionId)).toBeNull();
  });

});

function entry(type: string, payload: Record<string, unknown>): string {
  return rawEntry('2026-06-01T10:00:00.000Z', type, payload);
}

function rawEntry(timestamp: string, type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp,
    type,
    payload
  });
}
