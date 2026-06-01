import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(messages[1]?.content).toBe('Command finished.');
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
