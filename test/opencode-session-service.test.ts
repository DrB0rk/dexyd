import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { OpenCodeSessionService } from '../src/services/opencode-session-service.js';

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const path of cleanupPaths.splice(0, cleanupPaths.length)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function createDb(tempDir: string): Database.Database {
  const db = new Database(join(tempDir, 'opencode.db'));
  db.exec(`
    CREATE TABLE project (
      id TEXT PRIMARY KEY,
      worktree TEXT NOT NULL
    );

    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      directory TEXT NOT NULL,
      title TEXT,
      agent TEXT,
      model TEXT,
      tokens_input INTEGER,
      tokens_output INTEGER,
      tokens_total INTEGER,
      time_created TEXT NOT NULL,
      time_updated TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES project(id)
    );

    CREATE TABLE session_message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL,
      seq INTEGER NOT NULL,
      time_created TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES session(id)
    );
  `);
  return db;
}

describe('OpenCodeSessionService', () => {
  it('returns empty arrays when database is missing', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-opencode-missing-'));
    cleanupPaths.push(tempDir);
    const logger = { warn: () => undefined };

    const service = new OpenCodeSessionService(tempDir, logger);

    expect(service.listSessions()).toEqual([]);
    expect(service.getSession('ses-1')).toBeNull();
    expect(service.getMessages('ses-1')).toEqual([]);
    expect(service.getUsageContext('ses-1')).toBeUndefined();
  });

  it('lists sessions from the OpenCode database', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-opencode-list-'));
    cleanupPaths.push(tempDir);
    const logger = { warn: () => undefined };
    const db = createDb(tempDir);

    db.prepare(`INSERT INTO project (id, worktree) VALUES (?, ?)`).run('proj-1', '/home/user/project');

    db.prepare(
      `INSERT INTO session (id, project_id, directory, title, agent, model, tokens_input, tokens_output, tokens_total, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'ses-1', 'proj-1', '/home/user/project', 'Fix bug', 'build', 'gpt-4',
      100, 50, 150, '2026-06-01T10:00:00.000Z', '2026-06-01T11:00:00.000Z'
    );

    db.prepare(
      `INSERT INTO session (id, project_id, directory, title, agent, model, tokens_input, tokens_output, tokens_total, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'ses-2', 'proj-1', '/home/user/project', null, null, null,
      null, null, null, '2026-06-01T09:00:00.000Z', '2026-06-01T10:00:00.000Z'
    );

    db.close();

    const service = new OpenCodeSessionService(tempDir, logger);
    const sessions = service.listSessions();

    expect(sessions).toHaveLength(2);
    // Sorted by time_updated DESC
    expect(sessions[0]?.id).toBe('ses-1');
    expect(sessions[1]?.id).toBe('ses-2');

    expect(sessions[0]?.source).toBe('opencode');
    expect(sessions[0]?.title).toBe('Fix bug');
    expect(sessions[0]?.model).toBe('gpt-4');
    expect(sessions[0]?.agent).toBe('build');
    expect(sessions[0]?.tokenUsage).toEqual({ input: 100, output: 50, total: 150 });
    expect(sessions[0]?.workspacePath).toBe('/home/user/project');
    expect(sessions[0]?.createdAt).toBe('2026-06-01T10:00:00.000Z');
    expect(sessions[0]?.updatedAt).toBe('2026-06-01T11:00:00.000Z');

    // Second session has null tokens
    expect(sessions[1]?.tokenUsage).toBeNull();
    expect(sessions[1]?.title).toBeUndefined();
    expect(sessions[1]?.model).toBeNull();
    expect(sessions[1]?.agent).toBeNull();
  });

  it('gets a single session by ID', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-opencode-get-'));
    cleanupPaths.push(tempDir);
    const logger = { warn: () => undefined };
    const db = createDb(tempDir);

    db.prepare(`INSERT INTO project (id, worktree) VALUES (?, ?)`).run('proj-1', '/home/user/project');

    db.prepare(
      `INSERT INTO session (id, project_id, directory, title, agent, model, tokens_input, tokens_output, tokens_total, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'ses-1', 'proj-1', '/home/user/project', 'Refactor', 'oracle', 'claude-4',
      200, 80, 280, '2026-06-01T08:00:00.000Z', '2026-06-01T09:00:00.000Z'
    );

    db.prepare(
      `INSERT INTO session (id, project_id, directory, title, agent, model, tokens_input, tokens_output, tokens_total, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'ses-2', 'proj-1', '/home/user/other', 'Explore', 'explore', 'gpt-4o',
      50, 10, 60, '2026-06-01T10:00:00.000Z', '2026-06-01T10:30:00.000Z'
    );

    db.close();

    const service = new OpenCodeSessionService(tempDir, logger);
    const session = service.getSession('ses-1');

    expect(session).not.toBeNull();
    expect(session?.id).toBe('ses-1');
    expect(session?.title).toBe('Refactor');
    expect(session?.model).toBe('claude-4');
    expect(session?.agent).toBe('oracle');
    expect(session?.source).toBe('opencode');
    expect(session?.workspacePath).toBe('/home/user/project');
    expect(session?.tokenUsage).toEqual({ input: 200, output: 80, total: 280 });
  });

  it('returns null for non-existent session', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-opencode-notfound-'));
    cleanupPaths.push(tempDir);
    const logger = { warn: () => undefined };
    const db = createDb(tempDir);

    db.prepare(`INSERT INTO project (id, worktree) VALUES (?, ?)`).run('proj-1', '/home/user/project');
    db.prepare(
      `INSERT INTO session (id, project_id, directory, title, agent, model, tokens_input, tokens_output, tokens_total, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'ses-1', 'proj-1', '/home/user/project', 'Test', 'build', 'gpt-4',
      null, null, null, '2026-06-01T10:00:00.000Z', '2026-06-01T11:00:00.000Z'
    );

    db.close();

    const service = new OpenCodeSessionService(tempDir, logger);
    const session = service.getSession('nonexistent');

    expect(session).toBeNull();
  });

  it('gets messages for a session', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-opencode-msgs-'));
    cleanupPaths.push(tempDir);
    const logger = { warn: () => undefined };
    const db = createDb(tempDir);

    db.prepare(`INSERT INTO project (id, worktree) VALUES (?, ?)`).run('proj-1', '/home/user/project');

    db.prepare(
      `INSERT INTO session (id, project_id, directory, title, agent, model, tokens_input, tokens_output, tokens_total, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'ses-1', 'proj-1', '/home/user/project', 'Chat', 'build', 'gpt-4',
      100, 50, 150, '2026-06-01T10:00:00.000Z', '2026-06-01T11:00:00.000Z'
    );

    // User message
    db.prepare(
      `INSERT INTO session_message (id, session_id, type, data, seq, time_created) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('msg-1', 'ses-1', 'user', JSON.stringify({ message: 'hello' }), 1, '2026-06-01T10:00:01.000Z');

    // Assistant message with content array
    db.prepare(
      `INSERT INTO session_message (id, session_id, type, data, seq, time_created) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      'msg-2', 'ses-1', 'assistant',
      JSON.stringify({ content: [{ type: 'text', text: 'response' }] }),
      2, '2026-06-01T10:00:02.000Z'
    );

    // Tool message
    db.prepare(
      `INSERT INTO session_message (id, session_id, type, data, seq, time_created) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('msg-3', 'ses-1', 'tool', JSON.stringify({ text: 'output' }), 3, '2026-06-01T10:00:03.000Z');

    db.close();

    const service = new OpenCodeSessionService(tempDir, logger);
    const messages = service.getMessages('ses-1');

    expect(messages).toHaveLength(3);

    // User message
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.content).toBe('hello');
    expect(messages[0]?.id).toBe('msg-1');
    expect(messages[0]?.turnId).toBe('ses-1-1');
    expect(messages[0]?.sequence).toBe(1);
    expect(messages[0]?.status).toBe('sent');

    // Assistant message
    expect(messages[1]?.role).toBe('assistant');
    expect(messages[1]?.content).toBe('response');
    expect(messages[1]?.id).toBe('msg-2');
    expect(messages[1]?.turnId).toBe('ses-1-2');
    expect(messages[1]?.sequence).toBe(2);

    // Tool message
    expect(messages[2]?.role).toBe('tool');
    expect(messages[2]?.content).toBe('output');
    expect(messages[2]?.id).toBe('msg-3');
    expect(messages[2]?.turnId).toBe('ses-1-3');
    expect(messages[2]?.sequence).toBe(3);
  });

  it('returns empty array when no messages exist', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-opencode-nomsgs-'));
    cleanupPaths.push(tempDir);
    const logger = { warn: () => undefined };
    const db = createDb(tempDir);

    db.prepare(`INSERT INTO project (id, worktree) VALUES (?, ?)`).run('proj-1', '/home/user/project');
    db.prepare(
      `INSERT INTO session (id, project_id, directory, title, agent, model, tokens_input, tokens_output, tokens_total, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'ses-1', 'proj-1', '/home/user/project', 'Empty', null, null,
      null, null, null, '2026-06-01T10:00:00.000Z', '2026-06-01T11:00:00.000Z'
    );

    db.close();

    const service = new OpenCodeSessionService(tempDir, logger);
    const messages = service.getMessages('ses-1');

    expect(messages).toEqual([]);
  });

  it('gets usage context from token totals', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-opencode-usage-'));
    cleanupPaths.push(tempDir);
    const logger = { warn: () => undefined };
    const db = createDb(tempDir);

    db.prepare(`INSERT INTO project (id, worktree) VALUES (?, ?)`).run('proj-1', '/home/user/project');
    db.prepare(
      `INSERT INTO session (id, project_id, directory, title, agent, model, tokens_input, tokens_output, tokens_total, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'ses-1', 'proj-1', '/home/user/project', 'Token test', 'build', 'gpt-4',
      100, 50, 150, '2026-06-01T10:00:00.000Z', '2026-06-01T11:00:00.000Z'
    );

    db.close();

    const service = new OpenCodeSessionService(tempDir, logger);
    const usage = service.getUsageContext('ses-1');

    expect(usage).toBeDefined();
    expect(usage?.usedTokens).toBe(150);
    expect(usage?.windowTokens).toBeNull();
    expect(usage?.percent).toBeNull();
    expect(usage?.status).toBe('unknown');
  });

  it('returns undefined when no token data', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-opencode-notokens-'));
    cleanupPaths.push(tempDir);
    const logger = { warn: () => undefined };
    const db = createDb(tempDir);

    db.prepare(`INSERT INTO project (id, worktree) VALUES (?, ?)`).run('proj-1', '/home/user/project');
    db.prepare(
      `INSERT INTO session (id, project_id, directory, title, agent, model, tokens_input, tokens_output, tokens_total, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'ses-1', 'proj-1', '/home/user/project', 'No tokens', null, null,
      null, null, null, '2026-06-01T10:00:00.000Z', '2026-06-01T11:00:00.000Z'
    );

    db.close();

    const service = new OpenCodeSessionService(tempDir, logger);
    const usage = service.getUsageContext('ses-1');

    expect(usage).toBeUndefined();
  });
});