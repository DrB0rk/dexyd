import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { OpenCodeApiClient, OpenCodeSession, OpenCodeAgent, OpenCodeSkill, OpenCodeTool, OpenCodeCommand, OpenCodeProvider, OpenCodeModel } from '../src/services/opencode-api-client.js';
import { OpenCodeServerManager, OpenCodeServerState } from '../src/services/opencode-server-manager.js';
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


function createOpenCode117Db(tempDir: string): Database.Database {
  const db = new Database(join(tempDir, 'opencode.db'));
  db.exec(`
    CREATE TABLE project (
      id TEXT PRIMARY KEY,
      worktree TEXT NOT NULL
    );

    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      share_url TEXT,
      summary_additions INTEGER,
      summary_deletions INTEGER,
      summary_files INTEGER,
      summary_diffs TEXT,
      revert TEXT,
      permission TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_compacting INTEGER,
      time_archived INTEGER,
      workspace_id TEXT,
      path TEXT,
      agent TEXT,
      model TEXT,
      cost REAL DEFAULT 0 NOT NULL,
      tokens_input INTEGER DEFAULT 0 NOT NULL,
      tokens_output INTEGER DEFAULT 0 NOT NULL,
      tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
      metadata TEXT,
      FOREIGN KEY (project_id) REFERENCES project(id)
    );

    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES session(id)
    );

    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES message(id)
    );

    CREATE TABLE session_message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL,
      seq INTEGER NOT NULL,
      time_created TEXT NOT NULL
    );
  `);
  return db;
}

function createMockServerManager(state: Partial<OpenCodeServerState> = {}): OpenCodeServerManager {
  const handle = state.handle ?? {
    baseUrl: 'http://127.0.0.1:4243',
    host: '127.0.0.1',
    port: 4243,
    pid: 1,
    startedAt: new Date().toISOString()
  };
  const resolvedState: OpenCodeServerState = {
    status: 'stopped',
    handle: null,
    error: null,
    checkedAt: new Date().toISOString(),
    version: null,
    installHint: null,
    ...state,
    handle: state.status === 'ready' ? handle : state.handle
  };
  const manager = {
    state: resolvedState,
    isEnabled: () => true,
    ensureReady: vi.fn(async () => (resolvedState.status === 'ready' ? handle : null)),
    baseUrl: () => 'http://127.0.0.1:4243',
    resolveInstallHint: () => 'install opencode',
    stop: () => undefined,
    dispose: async () => undefined
  } as unknown as OpenCodeServerManager;
  return manager;
}

function createMockApiClient(overrides: Partial<OpenCodeApiClient> = {}): OpenCodeApiClient {
  return {
    setBaseUrl: vi.fn(),
    get baseUrl() {
      return 'http://127.0.0.1:4243';
    },
    addEventListener: vi.fn(() => () => undefined),
    listSessions: vi.fn(async () => [] as OpenCodeSession[]),
    getSession: vi.fn(async () => null),
    createSession: vi.fn(async () => ({ id: 'new' } as OpenCodeSession)),
    updateSession: vi.fn(async () => ({} as OpenCodeSession)),
    deleteSession: vi.fn(async () => true),
    abortSession: vi.fn(async () => true),
    listMessages: vi.fn(async () => []),
    getMessage: vi.fn(async () => null),
    sendMessageSync: vi.fn(async () => ({} as never)),
    sendMessageAsync: vi.fn(async () => undefined),
    listAgents: vi.fn(async () => [] as OpenCodeAgent[]),
    listSkills: vi.fn(async () => [] as OpenCodeSkill[]),
    listTools: vi.fn(async () => [] as OpenCodeTool[]),
    listCommands: vi.fn(async () => [] as OpenCodeCommand[]),
    listProviders: vi.fn(async () => [] as OpenCodeProvider[]),
    listModels: vi.fn(async () => [] as OpenCodeModel[]),
    listPermissions: vi.fn(async () => []),
    replyPermission: vi.fn(async () => ({ ok: true })),
    listQuestions: vi.fn(async () => []),
    replyQuestion: vi.fn(async () => ({ ok: true })),
    rejectQuestion: vi.fn(async () => ({ ok: true })),
    listTodos: vi.fn(async () => []),
    getSessionDiff: vi.fn(async () => ({ files: [], summary: { additions: 0, deletions: 0, files: 0 } })),
    runShell: vi.fn(async () => ({ callID: 'shell-1', output: '', exitCode: 0, durationMs: 0 })),
    sendCommand: vi.fn(async () => ({ callID: 'cmd-1', output: '' })),
    summarize: vi.fn(async () => ({ ok: true })),
    initSession: vi.fn(async () => ({ ok: true })),
    forkSession: vi.fn(async () => ({} as OpenCodeSession)),
    shareSession: vi.fn(async () => ({})),
    unshareSession: vi.fn(async () => ({ ok: true })),
    compactSession: vi.fn(async () => ({ ok: true })),
    readFile: vi.fn(async () => ''),
    listDirectory: vi.fn(async () => []),
    findFiles: vi.fn(async () => []),
    findText: vi.fn(async () => []),
    subscribeEvents: vi.fn(async function* () {}),
    getConfig: vi.fn(async () => ({})),
    health: vi.fn(async () => ({ healthy: true, version: '1.0.0' })),
    ...overrides
  } as unknown as OpenCodeApiClient;
}

function makeService(overrides: { dataDir?: string; apiClient?: OpenCodeApiClient; serverManager?: OpenCodeServerManager; defaultAgent?: string; defaultModel?: string } = {}): OpenCodeSessionService {
  const dataDir = overrides.dataDir ?? mkdtempSync(join(tmpdir(), 'dexyd-opencode-'));
  cleanupPaths.push(dataDir);
  return new OpenCodeSessionService({
    dataDir,
    apiClient: overrides.apiClient ?? createMockApiClient(),
    serverManager: overrides.serverManager ?? createMockServerManager({ status: 'starting' }),
    defaultAgent: overrides.defaultAgent ?? 'build',
    defaultModel: overrides.defaultModel ?? '',
    logger: { warn: () => undefined, info: () => undefined, debug: () => undefined }
  });
}

describe('OpenCodeSessionService - sqlite fallback', () => {
  it('returns empty arrays when database is missing', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-opencode-missing-'));
    cleanupPaths.push(tempDir);
    const service = new OpenCodeSessionService({
      dataDir: tempDir,
      apiClient: createMockApiClient(),
      serverManager: createMockServerManager({ status: 'starting' }),
      defaultAgent: 'build',
      defaultModel: '',
      logger: { warn: () => undefined, info: () => undefined, debug: () => undefined }
    });

    expect(await service.listSessions()).toEqual([]);
    expect(await service.getSession('ses-1')).toBeNull();
    expect(service.getMessagesFromSqlite('ses-1')).toEqual([]);
  });

  it('lists sessions from the OpenCode sqlite cache as fallback', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-opencode-list-'));
    cleanupPaths.push(tempDir);
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

    const service = new OpenCodeSessionService({
      dataDir: tempDir,
      apiClient: createMockApiClient(),
      serverManager: createMockServerManager({ status: 'starting' }),
      defaultAgent: 'build',
      defaultModel: '',
      logger: { warn: () => undefined, info: () => undefined, debug: () => undefined }
    });
    const sessions = service.listSessionsFromSqlite();

    expect(sessions).toHaveLength(2);
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
    expect(sessions[1]?.tokenUsage).toBeNull();
    expect(sessions[1]?.title).toBeUndefined();
    expect(sessions[1]?.model).toBeNull();
    expect(sessions[1]?.agent).toBeNull();
  });

  it('returns session detail for sqlite fallback getSession', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-opencode-get-'));
    cleanupPaths.push(tempDir);
    const db = createDb(tempDir);

    db.prepare(`INSERT INTO project (id, worktree) VALUES (?, ?)`).run('proj-1', '/home/user/project');
    db.prepare(
      `INSERT INTO session (id, project_id, directory, title, agent, model, tokens_input, tokens_output, tokens_total, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'ses-1', 'proj-1', '/home/user/project', 'Refactor', 'oracle', 'claude-4',
      200, 80, 280, '2026-06-01T08:00:00.000Z', '2026-06-01T09:00:00.000Z'
    );
    db.close();

    const service = new OpenCodeSessionService({
      dataDir: tempDir,
      apiClient: createMockApiClient(),
      serverManager: createMockServerManager({ status: 'starting' }),
      defaultAgent: 'build',
      defaultModel: '',
      logger: { warn: () => undefined, info: () => undefined, debug: () => undefined }
    });
    const session = service.getSessionFromSqlite('ses-1');

    expect(session).not.toBeNull();
    expect(session?.id).toBe('ses-1');
    expect(session?.title).toBe('Refactor');
    expect(session?.model).toBe('claude-4');
    expect(session?.agent).toBe('oracle');
    expect(session?.source).toBe('opencode');
    expect(session?.workspacePath).toBe('/home/user/project');
    expect(session?.tokenUsage).toEqual({ input: 200, output: 80, total: 280 });
  });

  it('returns null for non-existent session via sqlite fallback', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-opencode-notfound-'));
    cleanupPaths.push(tempDir);
    const db = createDb(tempDir);
    db.prepare(`INSERT INTO project (id, worktree) VALUES (?, ?)`).run('proj-1', '/home/user/project');
    db.prepare(
      `INSERT INTO session (id, project_id, directory, title, agent, model, tokens_input, tokens_output, tokens_total, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'ses-1', 'proj-1', '/home/user/project', 'Test', 'build', 'gpt-4',
      null, null, null, '2026-06-01T10:00:00.000Z', '2026-06-01T11:00:00.000Z'
    );
    db.close();

    const service = new OpenCodeSessionService({
      dataDir: tempDir,
      apiClient: createMockApiClient(),
      serverManager: createMockServerManager({ status: 'starting' }),
      defaultAgent: 'build',
      defaultModel: '',
      logger: { warn: () => undefined, info: () => undefined, debug: () => undefined }
    });
    const session = service.getSessionFromSqlite('nonexistent');

    expect(session).toBeNull();
  });

  it('returns messages from sqlite fallback', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-opencode-msgs-'));
    cleanupPaths.push(tempDir);
    const db = createDb(tempDir);

    db.prepare(`INSERT INTO project (id, worktree) VALUES (?, ?)`).run('proj-1', '/home/user/project');
    db.prepare(
      `INSERT INTO session (id, project_id, directory, title, agent, model, tokens_input, tokens_output, tokens_total, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'ses-1', 'proj-1', '/home/user/project', 'Chat', 'build', 'gpt-4',
      100, 50, 150, '2026-06-01T10:00:00.000Z', '2026-06-01T11:00:00.000Z'
    );
    db.prepare(
      `INSERT INTO session_message (id, session_id, type, data, seq, time_created) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('msg-1', 'ses-1', 'user', JSON.stringify({ message: 'hello' }), 1, '2026-06-01T10:00:01.000Z');
    db.prepare(
      `INSERT INTO session_message (id, session_id, type, data, seq, time_created) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      'msg-2', 'ses-1', 'assistant',
      JSON.stringify({ content: [{ type: 'text', text: 'response' }] }),
      2, '2026-06-01T10:00:02.000Z'
    );
    db.prepare(
      `INSERT INTO session_message (id, session_id, type, data, seq, time_created) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('msg-3', 'ses-1', 'tool', JSON.stringify({ text: 'output' }), 3, '2026-06-01T10:00:03.000Z');
    db.close();

    const service = new OpenCodeSessionService({
      dataDir: tempDir,
      apiClient: createMockApiClient(),
      serverManager: createMockServerManager({ status: 'starting' }),
      defaultAgent: 'build',
      defaultModel: '',
      logger: { warn: () => undefined, info: () => undefined, debug: () => undefined }
    });
    const messages = service.getMessagesFromSqlite('ses-1');

    expect(messages).toHaveLength(3);
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.content).toBe('hello');
    expect(messages[0]?.id).toBe('msg-1');
    expect(messages[0]?.turnId).toBe('ses-1-1');
    expect(messages[0]?.sequence).toBe(1);
    expect(messages[0]?.status).toBe('sent');
    expect(messages[1]?.role).toBe('assistant');
    expect(messages[1]?.content).toBe('response');
    expect(messages[1]?.id).toBe('msg-2');
    expect(messages[1]?.turnId).toBe('ses-1-2');
    expect(messages[1]?.sequence).toBe(2);
    expect(messages[2]?.role).toBe('tool');
    expect(messages[2]?.content).toBe('output');
    expect(messages[2]?.id).toBe('msg-3');
    expect(messages[2]?.turnId).toBe('ses-1-3');
    expect(messages[2]?.sequence).toBe(3);
  });

  it('returns empty array when no messages exist', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-opencode-nomsgs-'));
    cleanupPaths.push(tempDir);
    const db = createDb(tempDir);
    db.prepare(`INSERT INTO project (id, worktree) VALUES (?, ?)`).run('proj-1', '/home/user/project');
    db.prepare(
      `INSERT INTO session (id, project_id, directory, title, agent, model, tokens_input, tokens_output, tokens_total, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'ses-1', 'proj-1', '/home/user/project', 'Empty', null, null,
      null, null, null, '2026-06-01T10:00:00.000Z', '2026-06-01T11:00:00.000Z'
    );
    db.close();

    const service = new OpenCodeSessionService({
      dataDir: tempDir,
      apiClient: createMockApiClient(),
      serverManager: createMockServerManager({ status: 'starting' }),
      defaultAgent: 'build',
      defaultModel: '',
      logger: { warn: () => undefined, info: () => undefined, debug: () => undefined }
    });
    expect(service.getMessagesFromSqlite('ses-1')).toEqual([]);
  });

  it('exposes usage context from sqlite token totals', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-opencode-usage-'));
    cleanupPaths.push(tempDir);
    const db = createDb(tempDir);
    db.prepare(`INSERT INTO project (id, worktree) VALUES (?, ?)`).run('proj-1', '/home/user/project');
    db.prepare(
      `INSERT INTO session (id, project_id, directory, title, agent, model, tokens_input, tokens_output, tokens_total, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'ses-1', 'proj-1', '/home/user/project', 'Token test', 'build', 'gpt-4',
      100, 50, 150, '2026-06-01T10:00:00.000Z', '2026-06-01T11:00:00.000Z'
    );
    db.close();

    const service = new OpenCodeSessionService({
      dataDir: tempDir,
      apiClient: createMockApiClient(),
      serverManager: createMockServerManager({ status: 'starting' }),
      defaultAgent: 'build',
      defaultModel: '',
      logger: { warn: () => undefined, info: () => undefined, debug: () => undefined }
    });
    const usage = service.listSessionsFromSqlite()[0]?.tokenUsage;
    expect(usage).toEqual({ input: 100, output: 50, total: 150 });
  });
});

describe('OpenCodeSessionService - api primary path', () => {
  it('lists sessions via the HTTP API when ready', async () => {
    const apiClient = createMockApiClient({
      listSessions: vi.fn(async () => [
        {
          id: 'ses-api-1',
          slug: 'api-1',
          projectID: 'p1',
          directory: '/home/user/api',
          title: 'API session',
          agent: 'build',
          model: { id: 'anthropic/claude-4', providerID: 'anthropic', modelID: 'claude-4' },
          version: '1.17.3',
          summary: { additions: 10, deletions: 2, files: 1 },
          cost: 0.42,
          tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.parse('2026-06-01T10:00:00.000Z'), updated: Date.parse('2026-06-01T11:00:00.000Z') }
        }
      ] as OpenCodeSession[])
    });
    const serverManager = createMockServerManager({ status: 'ready', handle: { baseUrl: 'http://127.0.0.1:4243', host: '127.0.0.1', port: 4243, pid: 1, startedAt: '2026-06-01T00:00:00.000Z' } });
    const service = makeService({ apiClient, serverManager });

    const sessions = await service.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('ses-api-1');
    expect(sessions[0]?.title).toBe('API session');
    expect(sessions[0]?.model).toBe('anthropic/claude-4');
    expect(sessions[0]?.modelID).toBe('claude-4');
    expect(sessions[0]?.modelProviderID).toBe('anthropic');
    expect(sessions[0]?.tokenUsage).toEqual({ input: 100, output: 50, total: 150 });
    expect(sessions[0]?.opencodeVersion).toBe('1.17.3');
    expect(sessions[0]?.summary).toEqual({ additions: 10, deletions: 2, files: 1 });
    expect(sessions[0]?.cost).toBe(0.42);
    expect(apiClient.listSessions).toHaveBeenCalled();
  });

  it('caches API results and serves cached entries when fresh', async () => {
    const apiClient = createMockApiClient({
      listSessions: vi.fn(async () => [
        { id: 'ses-cached', directory: '/home/user/cached', title: 'Cached', time: { created: 1, updated: 1 } } as OpenCodeSession
      ] as OpenCodeSession[]),
      getSession: vi.fn(async (id: string) => {
        if (id === 'ses-cached') {
          return { id: 'ses-cached', directory: '/home/user/cached', title: 'Cached', time: { created: 1, updated: 2 } } as OpenCodeSession;
        }
        return null;
      })
    });
    const serverManager = createMockServerManager({ status: 'ready', handle: { baseUrl: 'http://127.0.0.1:4243', host: '127.0.0.1', port: 4243, pid: 1, startedAt: '2026-06-01T00:00:00.000Z' } });
    const service = makeService({ apiClient, serverManager });

    await service.listSessions();
    const cached = await service.getSession('ses-cached');
    expect(cached?.title).toBe('Cached');
    expect(apiClient.getSession).not.toHaveBeenCalled();
  });

  it('serves agents, skills, tools, commands, providers, models through API', async () => {
    const apiClient = createMockApiClient({
      listAgents: vi.fn(async () => [{ name: 'build', mode: 'primary' }] as OpenCodeAgent[]),
      listSkills: vi.fn(async () => [{ name: 'plan', description: 'planner' }] as OpenCodeSkill[]),
      listTools: vi.fn(async () => [{ id: 'bash' }] as OpenCodeTool[]),
      listCommands: vi.fn(async () => [{ name: 'commit' }] as OpenCodeCommand[]),
      listProviders: vi.fn(async () => [{ id: 'anthropic' }] as OpenCodeProvider[]),
      listModels: vi.fn(async () => [{ id: 'claude-4', providerID: 'anthropic' }] as OpenCodeModel[])
    });
    const serverManager = createMockServerManager({ status: 'ready', handle: { baseUrl: 'http://127.0.0.1:4243', host: '127.0.0.1', port: 4243, pid: 1, startedAt: '2026-06-01T00:00:00.000Z' } });
    const service = makeService({ apiClient, serverManager });

    expect(await service.listAgents()).toEqual([{ name: 'build', mode: 'primary' }]);
    expect(await service.listSkills()).toEqual([{ name: 'plan', description: 'planner' }]);
    expect(await service.listTools()).toEqual([{ id: 'bash' }]);
    expect(await service.listCommands()).toEqual([{ name: 'commit' }]);
    expect(await service.listProviders()).toEqual([{ id: 'anthropic' }]);
    expect(await service.listModels()).toEqual([{ id: 'claude-4', providerID: 'anthropic' }]);
  });

  it('creates a session via the API with default agent and resolved model', async () => {
    const apiClient = createMockApiClient({
      createSession: vi.fn(async (input) => ({
        id: 'ses-new',
        title: input.title ?? 'New session',
        agent: input.agent,
        directory: '/home/user/new',
        time: { created: 0, updated: 0 }
      } as OpenCodeSession))
    });
    const serverManager = createMockServerManager({ status: 'ready', handle: { baseUrl: 'http://127.0.0.1:4243', host: '127.0.0.1', port: 4243, pid: 1, startedAt: '2026-06-01T00:00:00.000Z' } });
    const service = makeService({ apiClient, serverManager, defaultAgent: 'build', defaultModel: 'anthropic/claude-4' });

    const session = await service.createSession({ workspacePath: '/home/user/new', title: 'My new' });
    expect(session.id).toBe('ses-new');
    expect(session.title).toBe('My new');
    const callArg = (apiClient.createSession as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArg.agent).toBe('build');
    expect(callArg.model).toEqual({ providerID: 'anthropic', modelID: 'claude-4' });
  });

  it('returns empty agent/skill lists when server is disabled', async () => {
    const serverManager = createMockServerManager({ status: 'disabled' });
    serverManager.isEnabled = () => false;
    const service = makeService({ serverManager });

    expect(await service.listAgents()).toEqual([]);
    expect(await service.listSkills()).toEqual([]);
    expect(await service.listTools()).toEqual([]);
  });

  it('replyPermission and replyQuestion delegate to the API client', async () => {
    const apiClient = createMockApiClient();
    const serverManager = createMockServerManager({ status: 'ready', handle: { baseUrl: 'http://127.0.0.1:4243', host: '127.0.0.1', port: 4243, pid: 1, startedAt: '2026-06-01T00:00:00.000Z' } });
    const service = makeService({ apiClient, serverManager });

    await service.replyPermission('req-1', 'allow');
    expect(apiClient.replyPermission).toHaveBeenCalledWith('req-1', 'allow');

    await service.replyQuestion('q-1', ['yes']);
    expect(apiClient.replyQuestion).toHaveBeenCalledWith('q-1', ['yes']);

    await service.rejectQuestion('q-2');
    expect(apiClient.rejectQuestion).toHaveBeenCalledWith('q-2');
  });

  it('listMessages returns messages mapped from API', async () => {
    const apiClient = createMockApiClient({
      listMessages: vi.fn(async () => [
        {
          id: 'msg-1',
          role: 'user',
          parts: [{ type: 'text', text: 'hello' }],
          time: { created: 1780000000000 }
        }
      ] as never)
    });
    const serverManager = createMockServerManager({ status: 'ready', handle: { baseUrl: 'http://127.0.0.1:4243', host: '127.0.0.1', port: 4243, pid: 1, startedAt: '2026-06-01T00:00:00.000Z' } });
    const service = makeService({ apiClient, serverManager });

    const messages = await service.getMessages('ses-1');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.content).toBe('hello');
  });

  it('falls back to sqlite when API errors', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dexyd-opencode-fallback-'));
    cleanupPaths.push(tempDir);
    const db = createDb(tempDir);
    db.prepare(`INSERT INTO project (id, worktree) VALUES (?, ?)`).run('proj-1', '/home/user/project');
    db.prepare(
      `INSERT INTO session (id, project_id, directory, title, agent, model, tokens_input, tokens_output, tokens_total, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'ses-fallback', 'proj-1', '/home/user/project', 'Fallback', 'build', 'gpt-4',
      10, 20, 30, '2026-06-01T10:00:00.000Z', '2026-06-01T11:00:00.000Z'
    );
    db.close();

    const apiClient = createMockApiClient({
      listSessions: vi.fn(async () => {
        throw new Error('network down');
      })
    });
    const serverManager = createMockServerManager({ status: 'ready', handle: { baseUrl: 'http://127.0.0.1:4243', host: '127.0.0.1', port: 4243, pid: 1, startedAt: '2026-06-01T00:00:00.000Z' } });
    const service = makeService({ dataDir: tempDir, apiClient, serverManager });

    const sessions = await service.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('ses-fallback');
  });
});
