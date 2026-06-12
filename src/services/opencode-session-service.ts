import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { ChatMessage } from '../domain/chat.js';
import { SessionRecord } from '../domain/session.js';
import {
  OpenCodeAgent,
  OpenCodeApiClient,
  OpenCodeCommand,
  OpenCodeModel,
  OpenCodePermissionRequest,
  OpenCodeProvider,
  OpenCodeQuestionRequest,
  OpenCodeSession,
  OpenCodeSkill,
  OpenCodeTool
} from './opencode-api-client.js';
import { OpenCodeServerManager, OpenCodeServerState } from './opencode-server-manager.js';

export type OpenCodeSessionRecord = SessionRecord & {
  source: 'opencode';
  model: string | null;
  agent: string | null;
  tokenUsage: {
    input: number | null;
    output: number | null;
    total: number | null;
  } | null;
  opencodeVersion?: string | null;
};

export type OpenCodeUsageContext = {
  usedTokens: number | null;
  windowTokens: number | null;
  percent: number | null;
  status: 'ok' | 'warn' | 'error' | 'unknown';
};

export type OpenCodeSessionDetail = OpenCodeSessionRecord & {
  modelID: string | null;
  modelProviderID: string | null;
  summary: { additions: number; deletions: number; files: number } | null;
  cost: number | null;
  tokens: {
    input: number | null;
    output: number | null;
    reasoning: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
  } | null;
  slug: string | null;
  opencodePath: string | null;
  parentID: string | null;
};

type LoggerLike = {
  warn: (obj: unknown, msg?: string) => void;
  info?: (obj: unknown, msg?: string) => void;
  debug?: (obj: unknown, msg?: string) => void;
};

type SessionRow = {
  id: string;
  directory: string;
  title: string | null;
  agent: string | null;
  model: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_total: number | null;
  time_created: string;
  time_updated: string;
};

type MessageRow = {
  id: string;
  session_id: string;
  type: string;
  data: string;
  seq: number;
  time_created: string;
};

export type OpenCodeSessionServiceOptions = {
  dataDir: string;
  apiClient: OpenCodeApiClient;
  serverManager: OpenCodeServerManager;
  defaultAgent: string;
  defaultModel: string;
  logger: LoggerLike;
};

export class OpenCodeSessionService {
  private db: Database.Database | null = null;
  #cache: { loadedAt: number; sessions: OpenCodeSessionDetail[] } | null = null;
  readonly #cacheTtlMs = 5_000;
  readonly #apiClient: OpenCodeApiClient;
  readonly #serverManager: OpenCodeServerManager;
  readonly #defaultAgent: string;
  readonly #defaultModel: string;
  readonly #logger: LoggerLike;

  constructor(options: OpenCodeSessionServiceOptions) {
    this.#apiClient = options.apiClient;
    this.#serverManager = options.serverManager;
    this.#defaultAgent = options.defaultAgent;
    this.#defaultModel = options.defaultModel;
    this.#logger = options.logger;
    const dbPath = `${options.dataDir}/opencode.db`;
    if (!existsSync(dbPath)) {
      this.#logger.warn({ dbPath }, 'OpenCode sqlite cache not found; HTTP API will be primary source');
      return;
    }
    try {
      this.db = new Database(dbPath, { readonly: true });
    } catch (error) {
      this.#logger.warn({ error, dbPath }, 'Failed to open OpenCode sqlite cache');
    }
  }

  get serverState(): OpenCodeServerState {
    return this.#serverManager.state;
  }

  get apiClient(): OpenCodeApiClient {
    return this.#apiClient;
  }

  get defaultAgent(): string {
    return this.#defaultAgent;
  }

  get defaultModel(): string {
    return this.#defaultModel;
  }

  invalidateCache(): void {
    this.#cache = null;
  }

  async ensureServer(): Promise<{ baseUrl: string | null; error: string | null }> {
    if (!this.#serverManager.isEnabled()) {
      return { baseUrl: null, error: 'opencode integration is disabled' };
    }
    try {
      const handle = await this.#serverManager.ensureReady();
      if (handle) {
        this.#apiClient.setBaseUrl(handle.baseUrl);
        return { baseUrl: handle.baseUrl, error: null };
      }
      return { baseUrl: null, error: 'opencode server is not enabled' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'failed to start opencode server';
      return { baseUrl: this.#serverManager.baseUrl(), error: message };
    }
  }

  async listSessions(limit = 100): Promise<OpenCodeSessionDetail[]> {
    const ready = await this.ensureServer();
    if (ready.baseUrl) {
      try {
        const sessions = await this.#apiClient.listSessions();
        const details = sessions
          .map((session) => this.#mapApiSession(session))
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
          .slice(0, limit);
        this.#cache = { loadedAt: Date.now(), sessions: details };
        return details;
      } catch (error) {
        this.#logger.warn?.({ error }, 'OpenCode API listSessions failed; falling back to sqlite');
      }
    }
    return this.listSessionsFromSqlite(limit);
  }

  listSessionsFromSqlite(limit = 100): OpenCodeSessionDetail[] {
    if (!this.db) return [];
    try {
      const rows = this.db
        .prepare(
          `SELECT s.id, s.directory, s.title, s.agent, s.model,
                  s.tokens_input, s.tokens_output, s.tokens_total,
                  s.time_created, s.time_updated
           FROM session s
           LEFT JOIN project p ON s.project_id = p.id
           ORDER BY s.time_updated DESC
           LIMIT ?`
        )
        .all(limit) as SessionRow[];

      return rows.map((row) => this.#mapSqliteSessionRow(row));
    } catch (error) {
      this.#logger.warn({ error }, 'Failed to list OpenCode sessions from sqlite');
      return [];
    }
  }

  async getSession(sessionId: string): Promise<OpenCodeSessionDetail | null> {
    if (this.#cache && Date.now() - this.#cache.loadedAt < this.#cacheTtlMs) {
      const cached = this.#cache.sessions.find((entry) => entry.id === sessionId);
      if (cached) return cached;
    }
    // Only consult the opencode HTTP API for ids that look like opencode
    // session ids (e.g. `ses_…`). Other ids (UUIDs from codex) cause the opencode
    // server to return 500, which would be wasteful and noisy in logs.
    if (isOpenCodeSessionId(sessionId)) {
      const ready = await this.ensureServer();
      if (ready.baseUrl) {
        try {
          const session = await this.#apiClient.getSession(sessionId);
          if (session) {
            const mapped = this.#mapApiSession(session);
            this.#mergeIntoCache(mapped);
            return mapped;
          }
          return null;
        } catch (error) {
          this.#logger.warn?.({ error, sessionId }, 'OpenCode API getSession failed; falling back to sqlite');
        }
      }
    }
    return this.getSessionFromSqlite(sessionId);
  }

  getSessionFromSqlite(sessionId: string): OpenCodeSessionDetail | null {
    if (!this.db) return null;
    try {
      const row = this.db
        .prepare(
          `SELECT s.id, s.directory, s.title, s.agent, s.model,
                  s.tokens_input, s.tokens_output, s.tokens_total,
                  s.time_created, s.time_updated
           FROM session s
           LEFT JOIN project p ON s.project_id = p.id
           WHERE s.id = ?`
        )
        .get(sessionId) as SessionRow | undefined;
      if (!row) return null;
      return this.#mapSqliteSessionRow(row);
    } catch (error) {
      this.#logger.warn({ error, sessionId }, 'Failed to get OpenCode session from sqlite');
      return null;
    }
  }

  async getMessages(sessionId: string, limit = 200): Promise<ChatMessage[]> {
    const ready = await this.ensureServer();
    if (ready.baseUrl) {
      try {
        const messages = await this.#apiClient.listMessages(sessionId, limit);
        if (messages.length > 0) {
          return messages
            .map((message, index) => this.#mapApiMessageRow(sessionId, message, index))
            .filter((message): message is ChatMessage => message !== null);
        }
      } catch (error) {
        this.#logger.warn?.({ error, sessionId }, 'OpenCode API listMessages failed; falling back to sqlite');
      }
    }
    return this.getMessagesFromSqlite(sessionId, limit);
  }

  getMessagesFromSqlite(sessionId: string, limit = 200): ChatMessage[] {
    if (!this.db) return [];
    try {
      const rows = this.db
        .prepare(
          `SELECT id, session_id, type, data, seq, time_created
           FROM session_message
           WHERE session_id = ?
           ORDER BY seq ASC
           LIMIT ?`
        )
        .all(sessionId, limit) as MessageRow[];

      return rows.map((row) => this.#mapSqliteMessageRow(row));
    } catch (error) {
      this.#logger.warn({ error, sessionId }, 'Failed to get OpenCode session messages from sqlite');
      return [];
    }
  }

  async getUsageContext(sessionId: string): Promise<OpenCodeUsageContext | undefined> {
    const session = await this.getSession(sessionId);
    if (!session?.tokenUsage) return undefined;
    const total = session.tokenUsage.total;
    if (total === null) return undefined;
    return {
      usedTokens: total,
      windowTokens: null,
      percent: null,
      status: 'unknown'
    };
  }

  async listAgents(): Promise<OpenCodeAgent[]> {
    return this.#apiList(() => this.#apiClient.listAgents(), 'listAgents');
  }

  async listSkills(): Promise<OpenCodeSkill[]> {
    return this.#apiList(() => this.#apiClient.listSkills(), 'listSkills');
  }

  async listTools(): Promise<OpenCodeTool[]> {
    return this.#apiList(() => this.#apiClient.listTools(), 'listTools');
  }

  async listCommands(): Promise<OpenCodeCommand[]> {
    return this.#apiList(() => this.#apiClient.listCommands(), 'listCommands');
  }

  async listProviders(): Promise<OpenCodeProvider[]> {
    return this.#apiList(() => this.#apiClient.listProviders(), 'listProviders');
  }

  async listModels(providerId?: string): Promise<OpenCodeModel[]> {
    return this.#apiList(() => this.#apiClient.listModels(providerId), 'listModels');
  }

  async listPermissions(): Promise<OpenCodePermissionRequest[]> {
    return this.#apiList(() => this.#apiClient.listPermissions(), 'listPermissions');
  }

  async replyPermission(requestId: string, decision: 'allow' | 'deny' | 'always'): Promise<{ ok: boolean }> {
    return this.#apiClient.replyPermission(requestId, decision);
  }

  async listQuestions(): Promise<OpenCodeQuestionRequest[]> {
    return this.#apiList(() => this.#apiClient.listQuestions(), 'listQuestions');
  }

  async replyQuestion(requestId: string, answers: Array<string | { label: string }>): Promise<{ ok: boolean }> {
    return this.#apiClient.replyQuestion(requestId, answers);
  }

  async rejectQuestion(requestId: string): Promise<{ ok: boolean }> {
    return this.#apiClient.rejectQuestion(requestId);
  }

  async createSession(input: {
    workspacePath: string;
    title?: string;
    agent?: string;
    modelProviderID?: string;
    modelID?: string;
  }): Promise<OpenCodeSessionDetail> {
    const ready = await this.ensureServer();
    if (!ready.baseUrl) {
      throw new Error(ready.error ?? 'opencode server is not available');
    }
    const agent = input.agent ?? this.#defaultAgent;
    const model = input.modelProviderID && input.modelID
      ? { providerID: input.modelProviderID, modelID: input.modelID }
      : this.#defaultModel && this.#defaultModel.includes('/')
        ? { providerID: this.#defaultModel.split('/')[0] ?? '', modelID: this.#defaultModel.split('/').slice(1).join('/') }
        : undefined;
    const createPayload: { title?: string; agent: string; model?: { providerID: string; modelID: string } } = { agent };
    if (input.title) createPayload.title = input.title;
    if (model) createPayload.model = model;
    const session = await this.#apiClient.createSession(createPayload);
    const detail = this.#mapApiSession(session, { workspacePath: input.workspacePath });
    this.#mergeIntoCache(detail);
    return detail;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const ready = await this.ensureServer();
    if (ready.baseUrl) {
      try {
        return await this.#apiClient.deleteSession(sessionId);
      } catch (error) {
        this.#logger.warn?.({ error, sessionId }, 'OpenCode API deleteSession failed');
      }
    }
    return false;
  }

  async abortSession(sessionId: string): Promise<boolean> {
    const ready = await this.ensureServer();
    if (!ready.baseUrl) return false;
    return this.#apiClient.abortSession(sessionId);
  }

  async resolveDefaultModel(): Promise<{ providerID: string; modelID: string } | null> {
    if (!this.#defaultModel) return null;
    if (!this.#defaultModel.includes('/')) return null;
    const [providerID, ...rest] = this.#defaultModel.split('/');
    if (!providerID) return null;
    return { providerID, modelID: rest.join('/') };
  }

  #mergeIntoCache(detail: OpenCodeSessionDetail): void {
    if (!this.#cache) {
      this.#cache = { loadedAt: Date.now(), sessions: [detail] };
      return;
    }
    const existing = this.#cache.sessions.findIndex((entry) => entry.id === detail.id);
    if (existing >= 0) {
      this.#cache.sessions[existing] = detail;
    } else {
      this.#cache.sessions.unshift(detail);
    }
  }

  async #apiList<T>(load: () => Promise<T>, label: string): Promise<T extends Array<infer U> ? U[] : T> {
    const ready = await this.ensureServer();
    if (!ready.baseUrl) {
      return [] as unknown as T extends Array<infer U> ? U[] : T;
    }
    try {
      return (await load()) as T extends Array<infer U> ? U[] : T;
    } catch (error) {
      this.#logger.warn?.({ error, label }, `OpenCode API ${label} failed`);
      return [] as unknown as T extends Array<infer U> ? U[] : T;
    }
  }

  #mapApiSession(session: OpenCodeSession, overrides: { workspacePath?: string } = {}): OpenCodeSessionDetail {
    const updatedAt = session.time?.updated
      ? new Date(session.time.updated).toISOString()
      : new Date(0).toISOString();
    const createdAt = session.time?.created
      ? new Date(session.time.created).toISOString()
      : updatedAt;
    const tokens = session.tokens ?? null;
    const inputTokens = tokens?.input ?? null;
    const outputTokens = tokens?.output ?? null;
    const reasoningTokens = tokens?.reasoning ?? null;
    const cacheRead = tokens?.cache?.read ?? null;
    const cacheWrite = tokens?.cache?.write ?? null;
    const totalTokens =
      inputTokens !== null || outputTokens !== null || reasoningTokens !== null
        ? (inputTokens ?? 0) + (outputTokens ?? 0) + (reasoningTokens ?? 0)
        : null;
    const hasTokens = totalTokens !== null;

    const workspacePath = overrides.workspacePath ?? session.directory ?? '';

    return {
      id: session.id,
      status: 'idle',
      profile: 'opencode',
      workspacePath,
      createdAt,
      updatedAt,
      source: 'opencode',
      title: cleanTitle(session.title) || undefined,
      model: session.model?.id ?? null,
      agent: session.agent ?? null,
      tokenUsage: hasTokens
        ? { input: inputTokens, output: outputTokens, total: totalTokens }
        : null,
      opencodeVersion: session.version ?? null,
      modelID: session.model?.modelID ?? null,
      modelProviderID: session.model?.providerID ?? null,
      summary: session.summary ?? null,
      cost: typeof session.cost === 'number' ? session.cost : null,
      tokens:
        tokens || reasoningTokens !== null
          ? {
              input: inputTokens,
              output: outputTokens,
              reasoning: reasoningTokens,
              cacheRead,
              cacheWrite
            }
          : null,
      slug: session.slug ?? null,
      opencodePath: session.path ?? null,
      parentID: session.parentID ?? null
    };
  }

  #mapSqliteSessionRow(row: SessionRow): OpenCodeSessionDetail {
    const tokenInput = row.tokens_input ?? null;
    const tokenOutput = row.tokens_output ?? null;
    const tokenTotal = row.tokens_total ?? null;
    const hasTokens = tokenInput !== null || tokenOutput !== null || tokenTotal !== null;
    let model: string | null = null;
    let modelID: string | null = null;
    let modelProviderID: string | null = null;
    if (row.model) {
      try {
        const parsed = JSON.parse(row.model);
        model = parsed.id ?? row.model;
        modelID = parsed.modelID ?? null;
        modelProviderID = parsed.providerID ?? null;
      } catch {
        model = row.model;
      }
    }
    return {
      id: row.id,
      status: 'idle',
      profile: 'opencode',
      workspacePath: row.directory,
      createdAt: row.time_created,
      updatedAt: row.time_updated,
      source: 'opencode',
      title: cleanTitle(row.title) || undefined,
      model,
      agent: row.agent,
      tokenUsage: hasTokens ? { input: tokenInput, output: tokenOutput, total: tokenTotal } : null,
      modelID,
      modelProviderID,
      summary: null,
      cost: null,
      tokens: hasTokens
        ? {
            input: tokenInput,
            output: tokenOutput,
            reasoning: null,
            cacheRead: null,
            cacheWrite: null
          }
        : null,
      slug: null,
      opencodePath: null,
      parentID: null
    };
  }

  #mapApiMessageRow(sessionId: string, rawMessage: NonNullable<Awaited<ReturnType<OpenCodeApiClient['listMessages']>>[number]>, index: number): ChatMessage | null {
    // OpenCode 1.17 wraps each message in `{info, parts}`. Older API shapes
    // expose the fields directly. Normalize so downstream code sees a
    // consistent view.
    const info = (rawMessage as { info?: Record<string, unknown> }).info ?? (rawMessage as unknown as Record<string, unknown>);
    const parts = (rawMessage as { parts?: unknown[] }).parts ?? [];
    const message = { ...(info as Record<string, unknown>), parts } as {
      id?: string;
      sessionID?: string;
      role?: string;
      parentID?: string;
      time?: { created?: number; completed?: number };
      parts?: Array<{ type?: string; text?: string; content?: string | unknown[] }>;
      text?: string;
      content?: string;
    };
    const createdAt = message.time?.created
      ? new Date(message.time.created).toISOString()
      : new Date(0).toISOString();
    const role = message.role ?? 'system';
    const content = extractTextContent(message);
    if (!content && role !== 'tool') return null;
    return {
      id: message.id ?? `${sessionId}-${index}`,
      turnId: message.parentID ?? message.id ?? `${sessionId}-${index}`,
      role: role === 'user' || role === 'assistant' || role === 'system' || role === 'tool' ? role : 'system',
      content,
      createdAt,
      sequence: index,
      status: 'sent'
    };
  }

  #mapSqliteMessageRow(row: MessageRow): ChatMessage {
    const data = parseDataField(row.data);
    const content = extractTextContentFromSqlite(row.type, data);

    return {
      id: row.id,
      turnId: `${row.session_id}-${row.seq}`,
      role: mapRole(row.type),
      content,
      createdAt: row.time_created,
      sequence: row.seq,
      status: 'sent'
    };
  }
}

function parseDataField(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function extractTextContent(message: { parts?: Array<{ type?: string; text?: string; content?: string | unknown[] }>; content?: string; text?: string }): string {
  if (typeof message.text === 'string' && message.text.trim()) {
    return message.text.trim();
  }
  if (typeof message.content === 'string' && message.content.trim()) {
    return message.content.trim();
  }
  if (Array.isArray(message.parts)) {
    const text = message.parts
      .filter((part) => part.type === 'text' || part.type === 'reasoning' || part.type === undefined)
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
    if (text) return text;
    const toolSummary = message.parts
      .filter((part) => part.type === 'tool')
      .map((part) => {
        if (typeof part.content === 'string') return part.content;
        if (Array.isArray(part.content)) {
          return part.content
            .map((item) => (typeof item === 'string' ? item : ''))
            .filter(Boolean)
            .join('\n');
        }
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
    if (toolSummary) return toolSummary;
  }
  return '';
}

function extractTextContentFromSqlite(type: string, data: unknown): string {
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (trimmed) return trimmed;
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    if (typeof obj.message === 'string' && obj.message.trim()) {
      return obj.message.trim();
    }
    if (typeof obj.text === 'string' && obj.text.trim()) {
      return obj.text.trim();
    }
    if (typeof obj.content === 'string') {
      const trimmed = obj.content.trim();
      if (trimmed) return trimmed;
    }
    if (Array.isArray(obj.content)) {
      return obj.content
        .map((item: unknown) => {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            const block = item as Record<string, unknown>;
            if (typeof block.text === 'string') return block.text;
          }
          return '';
        })
        .filter(Boolean)
        .join('\n')
        .trim();
    }
  }
  return '';
}

function mapRole(type: string): ChatMessage['role'] {
  if (type === 'user' || type === 'assistant' || type === 'system' || type === 'tool') {
    return type;
  }
  return 'system';
}

function isOpenCodeSessionId(sessionId: string): boolean {
  return typeof sessionId === 'string' && (sessionId.startsWith('ses_') || sessionId.startsWith('prt_'));
}

function cleanTitle(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}
