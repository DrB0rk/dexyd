import { setTimeout as wait } from 'node:timers/promises';

type LoggerLike = {
  debug: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
};

export type OpenCodeApiClientConfig = {
  baseUrl: string;
  password?: string;
  timeoutMs: number;
  retries: number;
};

export class OpenCodeApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly endpoint: string;
  readonly body: unknown;

  constructor(input: { status: number; code: string; message: string; endpoint: string; body: unknown }) {
    super(input.message);
    this.name = 'OpenCodeApiError';
    this.status = input.status;
    this.code = input.code;
    this.endpoint = input.endpoint;
    this.body = input.body;
  }
}

export type OpenCodeSession = {
  id: string;
  slug?: string | null;
  projectID?: string | null;
  directory?: string | null;
  path?: string | null;
  parentID?: string | null;
  title?: string | null;
  version?: string | null;
  summary?: { additions: number; deletions: number; files: number };
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  agent?: string | null;
  model?: { id?: string; providerID?: string; modelID?: string } | null;
  time?: { created?: number; updated?: number; compacting?: number | null };
  permission?: unknown;
};

export type OpenCodeAgent = {
  name: string;
  description?: string;
  mode?: 'primary' | 'subagent' | 'all';
  model?: { providerID?: string; modelID?: string } | null;
  prompt?: string;
  tools?: Record<string, boolean>;
  hidden?: boolean;
};

export type OpenCodeSkill = {
  name: string;
  description?: string;
  location?: string;
  content?: string;
};

export type OpenCodeTool = {
  id: string;
  description?: string;
  category?: string;
};

export type OpenCodeCommand = {
  name: string;
  description?: string;
  template?: string;
  agent?: string;
  model?: string;
  source?: 'command' | 'mcp' | 'skill';
};

export type OpenCodeProvider = {
  id: string;
  name?: string;
  source?: string;
  models?: Record<string, unknown>;
  authMethods?: Array<{ method: string; label?: string }>;
};

export type OpenCodeModel = {
  id: string;
  name?: string;
  providerID?: string;
  family?: string;
  releaseDate?: string;
  contextLimit?: number;
  outputLimit?: number;
};

export type OpenCodeMessagePart = {
  id?: string;
  type: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?:
    | { status: 'pending' }
    | { status: 'running'; start: number; input?: unknown; metadata?: unknown }
    | { status: 'completed'; start: number; end: number; output: string | unknown[]; title?: string; metadata?: unknown }
    | { status: 'error'; start?: number; end?: number; error: string };
  metadata?: unknown;
  snapshot?: string;
  reason?: string;
  input?: unknown;
  output?: string | unknown[];
  files?: unknown[];
  url?: string;
  filename?: string;
  mime?: string;
  source?: { text?: { value: string; start: number; end: number }; file?: unknown };
  messageID?: string;
  sessionID?: string;
};

export type OpenCodeMessage = {
  id?: string;
  sessionID?: string;
  role?: 'user' | 'assistant' | 'system' | 'tool';
  parentID?: string;
  agent?: string;
  model?: { id?: string; providerID?: string; modelID?: string };
  path?: { cwd?: string; root?: string };
  tokens?: { total?: number; input?: number; output?: number };
  cost?: number;
  time?: { created?: number; completed?: number };
  summary?: { additions?: number; deletions?: number; files?: number };
  error?: unknown;
  parts?: OpenCodeMessagePart[];
};

export type OpenCodePermissionRequest = {
  id: string;
  sessionID?: string;
  tool?: { messageID?: string; callID?: string };
  permission?: string;
  patterns?: string[];
  metadata?: Record<string, unknown>;
  always?: string[];
  time?: { created?: number };
};

export type OpenCodeQuestionRequest = {
  id: string;
  sessionID?: string;
  questions?: Array<{
    question: string;
    header?: string;
    options?: Array<{ label: string; description?: string }>;
  }>;
  tool?: { messageID?: string; callID?: string };
};

export type OpenCodePendingToolState = {
  name: string;
  sessionID: string;
  messageID?: string;
  callID?: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  start?: number;
  end?: number;
  input?: unknown;
  output?: string;
  error?: string;
  title?: string;
  metadata?: Record<string, unknown>;
};

export type OpenCodeEvent =
  | { type: 'server.connected'; payload: { baseUrl: string } }
  | { type: 'server.disconnected'; payload: { baseUrl: string; reason: string } }
  | { type: 'session.created'; payload: { session: OpenCodeSession } }
  | { type: 'session.updated'; payload: { session: OpenCodeSession } }
  | { type: 'session.deleted'; payload: { sessionID: string } }
  | { type: 'session.idle'; payload: { sessionID: string } }
  | { type: 'message.updated'; payload: { sessionID: string; message: OpenCodeMessage } }
  | { type: 'message.part.updated'; payload: { sessionID: string; messageID: string; part: OpenCodeMessagePart } }
  | { type: 'message.part.removed'; payload: { sessionID: string; messageID: string; partID: string } }
  | { type: 'session.next.prompted'; payload: { sessionID: string; turnID?: string | undefined } }
  | { type: 'session.next.step.started'; payload: { sessionID: string; turnID?: string | undefined; snapshot?: string | undefined } }
  | { type: 'session.next.step.ended'; payload: { sessionID: string; turnID?: string | undefined; reason?: string | undefined; snapshot?: string | undefined } }
  | { type: 'session.next.text.started'; payload: { sessionID: string; messageID: string } }
  | { type: 'session.next.text.delta'; payload: { sessionID: string; messageID: string; text: string } }
  | { type: 'session.next.text.ended'; payload: { sessionID: string; messageID: string; text: string } }
  | { type: 'session.next.reasoning.started'; payload: { sessionID: string; messageID: string } }
  | { type: 'session.next.reasoning.delta'; payload: { sessionID: string; messageID: string; text: string } }
  | { type: 'session.next.reasoning.ended'; payload: { sessionID: string; messageID: string; text: string } }
  | { type: 'session.next.tool.called'; payload: { sessionID: string; messageID: string; callID: string; tool: string; input?: unknown | undefined } }
  | { type: 'session.next.tool.progress'; payload: { sessionID: string; messageID: string; callID: string; elapsedMs?: number | undefined } }
  | { type: 'session.next.tool.success'; payload: { sessionID: string; messageID: string; callID: string; output: string | unknown[]; title?: string | undefined; metadata?: Record<string, unknown> | undefined; elapsedMs?: number | undefined } }
  | { type: 'session.next.tool.failed'; payload: { sessionID: string; messageID: string; callID: string; error: string; elapsedMs?: number | undefined } }
  | { type: 'session.next.shell.started'; payload: { sessionID: string; callID: string; command: string } }
  | { type: 'session.next.shell.ended'; payload: { sessionID: string; callID: string; output: string; exitCode: number; durationMs: number } }
  | { type: 'session.next.skill.used'; payload: { sessionID: string; messageID: string; skill: string; input?: unknown | undefined } }
  | { type: 'permission.asked'; payload: { sessionID: string; request: OpenCodePermissionRequest } }
  | { type: 'permission.replied'; payload: { sessionID: string; requestID: string; decision: 'allow' | 'deny' | 'always' } }
  | { type: 'question.asked'; payload: { sessionID: string; request: OpenCodeQuestionRequest } }
  | { type: 'question.replied'; payload: { sessionID: string; requestID: string; answers: string[] } }
  | { type: 'question.rejected'; payload: { sessionID: string; requestID: string } }
  | { type: 'todo.updated'; payload: { sessionID: string; todos: Array<{ id: string; status: string; content: string; priority: string }> } }
  | { type: 'session.error'; payload: { sessionID: string; error: { name: string; data?: { message?: string } | undefined } } }
  | { type: 'unknown'; payload: unknown };

export type OpenCodeEventListener = (event: OpenCodeEvent) => void;

export class OpenCodeApiClient {
  #baseUrl: string;
  #password: string | undefined;
  #timeoutMs: number;
  #retries: number;
  #listeners: Set<OpenCodeEventListener> = new Set();

  constructor(
    config: OpenCodeApiClientConfig,
    private readonly logger: LoggerLike = { debug: () => undefined, warn: () => undefined, info: () => undefined }
  ) {
    this.#baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.#password = config.password;
    this.#timeoutMs = config.timeoutMs;
    this.#retries = Math.max(0, config.retries);
  }

  setBaseUrl(baseUrl: string): void {
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  addEventListener(listener: OpenCodeEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: OpenCodeEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.warn({ error }, 'opencode event listener threw');
      }
    }
  }

  #headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...extra
    };
    if (this.#password) {
      headers['Authorization'] = `Basic ${Buffer.from(`opencode:${this.#password}`).toString('base64')}`;
    }
    return headers;
  }

  async   #request<T>(input: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    path: string;
    body?: unknown;
    query?: Record<string, string | number | boolean | undefined | null>;
    signal?: AbortSignal | null;
  }): Promise<T> {
    const url = this.#buildUrl(input.path, input.query);
    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt <= this.#retries) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      if (input.signal) {
        input.signal.addEventListener('abort', () => controller.abort(), { once: true });
      }
      try {
        const init: RequestInit = {
          method: input.method,
          headers: this.#headers(input.body ? { 'Content-Type': 'application/json' } : {}),
          signal: input.signal ?? controller.signal
        };
        if (input.body !== undefined) {
          init.body = typeof input.body === 'string' ? input.body : JSON.stringify(input.body);
        }
        const response = await fetch(url, init);
        clearTimeout(timer);
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          const parsed = safeParseJson(text);
          const code = isRecord(parsed) && typeof parsed.error === 'string' ? parsed.error : `http_${response.status}`;
          throw new OpenCodeApiError({
            status: response.status,
            code,
            message: `opencode ${input.method} ${input.path} failed: ${response.status} ${text.slice(0, 200)}`,
            endpoint: input.path,
            body: parsed
          });
        }
        if (response.status === 204) return undefined as T;
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('application/json')) {
          return (await response.json()) as T;
        }
        const text = await response.text();
        return text as unknown as T;
      } catch (error) {
        clearTimeout(timer);
        if (error instanceof OpenCodeApiError) {
          if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
            throw error;
          }
          lastError = error;
        } else if (error instanceof Error && error.name === 'AbortError') {
          lastError = new OpenCodeApiError({
            status: 0,
            code: 'timeout',
            message: `opencode ${input.method} ${input.path} timed out after ${this.#timeoutMs}ms`,
            endpoint: input.path,
            body: null
          });
        } else {
          lastError = new OpenCodeApiError({
            status: 0,
            code: 'network_error',
            message: `opencode ${input.method} ${input.path} failed: ${error instanceof Error ? error.message : 'unknown'}`,
            endpoint: input.path,
            body: null
          });
        }
        attempt += 1;
        if (attempt > this.#retries) break;
        await wait(150 * attempt);
      }
    }

    throw lastError ?? new OpenCodeApiError({
      status: 0,
      code: 'unknown',
      message: `opencode ${input.method} ${input.path} failed after ${this.#retries + 1} attempts`,
      endpoint: input.path,
      body: null
    });
  }

  #buildUrl(path: string, query?: Record<string, string | number | boolean | undefined | null>): string {
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    if (!query) return `${this.#baseUrl}${cleanPath}`;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      params.set(key, String(value));
    }
    const queryString = params.toString();
    return queryString ? `${this.#baseUrl}${cleanPath}?${queryString}` : `${this.#baseUrl}${cleanPath}`;
  }

  async health(): Promise<{ healthy: boolean; version: string | null }> {
    try {
      const body = await this.#request<{ healthy?: boolean; version?: string }>({ method: 'GET', path: '/global/health' });
      return { healthy: Boolean(body?.healthy), version: body?.version ?? null };
    } catch {
      return { healthy: false, version: null };
    }
  }

  async getConfig(): Promise<unknown> {
    return this.#request<unknown>({ method: 'GET', path: '/config' });
  }

  async listSessions(): Promise<OpenCodeSession[]> {
    const data = await this.#request<OpenCodeSession[] | { sessions: OpenCodeSession[] }>({
      method: 'GET',
      path: '/session'
    });
    return Array.isArray(data) ? data : data.sessions ?? [];
  }

  async getSession(sessionId: string): Promise<OpenCodeSession | null> {
    try {
      return await this.#request<OpenCodeSession>({ method: 'GET', path: `/session/${encodeURIComponent(sessionId)}` });
    } catch (error) {
      if (error instanceof OpenCodeApiError && error.status === 404) return null;
      throw error;
    }
  }

  async createSession(input: {
    parentID?: string;
    title?: string;
    agent?: string;
    model?: { providerID: string; modelID: string };
    permission?: unknown;
  }): Promise<OpenCodeSession> {
    const body: Record<string, unknown> = {};
    if (input.parentID) body.parentID = input.parentID;
    if (input.title) body.title = input.title;
    if (input.agent) body.agent = input.agent;
    if (input.model) {
      body.providerID = input.model.providerID;
      body.modelID = input.model.modelID;
    }
    if (input.permission !== undefined) body.permission = input.permission;
    return this.#request<OpenCodeSession>({ method: 'POST', path: '/session', body });
  }

  async updateSession(
    sessionId: string,
    input: { title?: string; agent?: string; model?: { providerID: string; modelID: string }; permission?: unknown }
  ): Promise<OpenCodeSession> {
    const body: Record<string, unknown> = {};
    if (input.title) body.title = input.title;
    if (input.agent) body.agent = input.agent;
    if (input.model) {
      body.providerID = input.model.providerID;
      body.modelID = input.model.modelID;
    }
    if (input.permission !== undefined) body.permission = input.permission;
    return this.#request<OpenCodeSession>({
      method: 'PATCH',
      path: `/session/${encodeURIComponent(sessionId)}`,
      body
    });
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    try {
      await this.#request<unknown>({ method: 'DELETE', path: `/session/${encodeURIComponent(sessionId)}` });
      return true;
    } catch (error) {
      if (error instanceof OpenCodeApiError && error.status === 404) return false;
      throw error;
    }
  }

  async abortSession(sessionId: string): Promise<boolean> {
    try {
      await this.#request<unknown>({ method: 'POST', path: `/session/${encodeURIComponent(sessionId)}/abort` });
      return true;
    } catch (error) {
      if (error instanceof OpenCodeApiError && error.status === 404) return false;
      throw error;
    }
  }

  async listMessages(sessionId: string, limit = 500): Promise<OpenCodeMessage[]> {
    const data = await this.#request<OpenCodeMessage[] | { messages: OpenCodeMessage[] }>({
      method: 'GET',
      path: `/session/${encodeURIComponent(sessionId)}/message`,
      query: { limit }
    });
    return Array.isArray(data) ? data : data.messages ?? [];
  }

  async getMessage(sessionId: string, messageId: string): Promise<OpenCodeMessage | null> {
    try {
      return await this.#request<OpenCodeMessage>({
        method: 'GET',
        path: `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`
      });
    } catch (error) {
      if (error instanceof OpenCodeApiError && error.status === 404) return null;
      throw error;
    }
  }

  async sendMessageSync(
    sessionId: string,
    parts: Array<{ type: 'text' | 'file'; text?: string; url?: string; filename?: string; mime?: string }>,
    options: { agent?: string; model?: { providerID: string; modelID: string } } = {}
  ): Promise<OpenCodeMessage> {
    const body: Record<string, unknown> = { parts };
    if (options.agent) body.agent = options.agent;
    if (options.model) {
      body.providerID = options.model.providerID;
      body.modelID = options.model.modelID;
    }
    return this.#request<OpenCodeMessage>({
      method: 'POST',
      path: `/session/${encodeURIComponent(sessionId)}/message`,
      body
    });
  }

  async sendMessageAsync(
    sessionId: string,
    parts: Array<{ type: 'text' | 'file'; text?: string; url?: string; filename?: string; mime?: string }>,
    options: { agent?: string; model?: { providerID: string; modelID: string } } = {}
  ): Promise<void> {
    const body: Record<string, unknown> = { parts };
    if (options.agent) body.agent = options.agent;
    if (options.model) {
      body.providerID = options.model.providerID;
      body.modelID = options.model.modelID;
    }
    await this.#request<unknown>({
      method: 'POST',
      path: `/session/${encodeURIComponent(sessionId)}/prompt_async`,
      body
    });
  }

  async listAgents(): Promise<OpenCodeAgent[]> {
    return this.#request<OpenCodeAgent[]>({ method: 'GET', path: '/agent' });
  }

  async listSkills(): Promise<OpenCodeSkill[]> {
    return this.#request<OpenCodeSkill[]>({ method: 'GET', path: '/skill' });
  }

  async listTools(): Promise<OpenCodeTool[]> {
    const providerId = await this.#resolveDefaultProvider();
    const paths = providerId
      ? [
          { method: 'GET' as const, path: '/experimental/tool', query: { provider: providerId } },
          { method: 'GET' as const, path: '/experimental/tool/ids', query: { provider: providerId } }
        ]
      : [
          { method: 'GET' as const, path: '/experimental/tool/ids' },
          { method: 'GET' as const, path: '/experimental/tool' }
        ];
    for (const candidate of paths) {
      try {
        const data = await this.#request<OpenCodeTool[] | { ids?: string[] }>(candidate);
        if (Array.isArray(data)) return data;
        if (data && Array.isArray(data.ids)) return data.ids.map((id) => ({ id }));
      } catch (error) {
        if (error instanceof OpenCodeApiError && (error.status === 400 || error.status === 404)) {
          continue;
        }
        throw error;
      }
    }
    return [];
  }

  async #resolveDefaultProvider(): Promise<string | null> {
    try {
      const providers = await this.listProviders();
      return providers[0]?.id ?? null;
    } catch {
      return null;
    }
  }

  async listCommands(): Promise<OpenCodeCommand[]> {
    return this.#request<OpenCodeCommand[]>({ method: 'GET', path: '/command' });
  }

  async listProviders(): Promise<OpenCodeProvider[]> {
    const data = await this.#request<{ providers?: OpenCodeProvider[]; default?: OpenCodeProvider[]; connected?: OpenCodeProvider[]; all?: OpenCodeProvider[] } | OpenCodeProvider[]>({
      method: 'GET',
      path: '/config/providers'
    });
    if (Array.isArray(data)) return data;
    if (data?.providers && Array.isArray(data.providers)) return data.providers;
    return data?.connected ?? data?.default ?? data?.all ?? [];
  }

  async listModels(providerId?: string): Promise<OpenCodeModel[]> {
    type ProviderBuckets = {
      providers?: Record<string, Record<string, OpenCodeModel>>;
      default?: Record<string, Record<string, OpenCodeModel>>;
      connected?: Record<string, Record<string, OpenCodeModel>>;
    };
    let data: ProviderBuckets | OpenCodeModel[] = {};
    try {
      data = await this.#request<ProviderBuckets | OpenCodeModel[]>({
        method: 'GET',
        path: '/config/providers',
        query: { ...(providerId ? { provider: providerId } : {}) }
      });
    } catch (error) {
      if (error instanceof OpenCodeApiError && (error.status === 400 || error.status === 404)) {
        return [];
      }
      throw error;
    }
    if (Array.isArray(data)) return data;
    const models: OpenCodeModel[] = [];
    const buckets: Array<Record<string, Record<string, OpenCodeModel>> | undefined> = [
      data.default,
      data.connected,
      data.providers
    ];
    for (const bucket of buckets) {
      if (!bucket) continue;
      for (const [pid, list] of Object.entries(bucket)) {
        if (list && typeof list === 'object' && !Array.isArray(list)) {
          for (const model of Object.values(list)) {
            if (model && typeof model === 'object' && 'id' in model) {
              models.push({ ...(model as OpenCodeModel), providerID: (model as OpenCodeModel).providerID ?? pid });
            }
          }
        }
      }
    }
    return models;
  }

  async listPermissions(): Promise<OpenCodePermissionRequest[]> {
    const data = await this.#request<OpenCodePermissionRequest[]>({
      method: 'GET',
      path: '/permission'
    });
    return Array.isArray(data) ? data : [];
  }

  async replyPermission(
    requestId: string,
    decision: 'allow' | 'deny' | 'always'
  ): Promise<{ ok: boolean }> {
    return this.#request<{ ok: boolean }>({
      method: 'POST',
      path: `/permission/${encodeURIComponent(requestId)}/reply`,
      body: { decision }
    });
  }

  async listQuestions(): Promise<OpenCodeQuestionRequest[]> {
    const data = await this.#request<OpenCodeQuestionRequest[]>({ method: 'GET', path: '/question' });
    return Array.isArray(data) ? data : [];
  }

  async replyQuestion(
    requestId: string,
    answers: Array<string | { label: string }>
  ): Promise<{ ok: boolean }> {
    return this.#request<{ ok: boolean }>({
      method: 'POST',
      path: `/question/${encodeURIComponent(requestId)}/reply`,
      body: { answers }
    });
  }

  async rejectQuestion(requestId: string): Promise<{ ok: boolean }> {
    return this.#request<{ ok: boolean }>({
      method: 'POST',
      path: `/question/${encodeURIComponent(requestId)}/reject`
    });
  }

  async listTodos(sessionId: string): Promise<Array<{ id: string; status: string; content: string; priority: string }>> {
    try {
      const data = await this.#request<unknown>({
        method: 'GET',
        path: `/session/${encodeURIComponent(sessionId)}/todo`
      });
      return Array.isArray(data) ? (data as Array<{ id: string; status: string; content: string; priority: string }>) : [];
    } catch {
      return [];
    }
  }

  async getSessionDiff(sessionId: string): Promise<{ files: Array<{ path: string; additions: number; deletions: number; status: string }>; summary: { additions: number; deletions: number; files: number } }> {
    try {
      const data = await this.#request<{ diff?: string; summary?: { additions: number; deletions: number; files: number } }>({
        method: 'GET',
        path: `/session/${encodeURIComponent(sessionId)}/diff`
      });
      const summary = data?.summary ?? { additions: 0, deletions: 0, files: 0 };
      return { files: parseDiffFiles(data?.diff ?? ''), summary };
    } catch {
      return { files: [], summary: { additions: 0, deletions: 0, files: 0 } };
    }
  }

  async runShell(
    sessionId: string,
    input: { command: string; agent?: string }
  ): Promise<{ callID: string; output: string; exitCode: number; durationMs: number }> {
    return this.#request<{ callID: string; output: string; exitCode: number; durationMs: number }>({
      method: 'POST',
      path: `/session/${encodeURIComponent(sessionId)}/shell`,
      body: input
    });
  }

  async sendCommand(
    sessionId: string,
    input: { command: string; arguments?: string[] }
  ): Promise<{ callID: string; output: string }> {
    return this.#request<{ callID: string; output: string }>({
      method: 'POST',
      path: `/session/${encodeURIComponent(sessionId)}/command`,
      body: input
    });
  }

  async summarize(sessionId: string): Promise<{ ok: boolean }> {
    return this.#request<{ ok: boolean }>({
      method: 'POST',
      path: `/session/${encodeURIComponent(sessionId)}/summarize`
    });
  }

  async initSession(sessionId: string): Promise<{ ok: boolean }> {
    return this.#request<{ ok: boolean }>({
      method: 'POST',
      path: `/session/${encodeURIComponent(sessionId)}/init`
    });
  }

  async forkSession(sessionId: string): Promise<OpenCodeSession> {
    return this.#request<OpenCodeSession>({
      method: 'POST',
      path: `/session/${encodeURIComponent(sessionId)}/fork`
    });
  }

  async shareSession(sessionId: string): Promise<{ shareURL?: string }> {
    return this.#request<{ shareURL?: string }>({
      method: 'POST',
      path: `/session/${encodeURIComponent(sessionId)}/share`
    });
  }

  async unshareSession(sessionId: string): Promise<{ ok: boolean }> {
    return this.#request<{ ok: boolean }>({
      method: 'DELETE',
      path: `/session/${encodeURIComponent(sessionId)}/share`
    });
  }

  async compactSession(sessionId: string): Promise<{ ok: boolean }> {
    try {
      await this.#request<unknown>({
        method: 'POST',
        path: `/v2/session/${encodeURIComponent(sessionId)}/compact`
      });
      return { ok: true };
    } catch (error) {
      if (error instanceof OpenCodeApiError) {
        return { ok: false };
      }
      throw error;
    }
  }

  async readFile(input: { path: string; startLine?: number; endLine?: number }): Promise<string> {
    return this.#request<string>({
      method: 'GET',
      path: '/file/content',
      query: {
        path: input.path,
        ...(typeof input.startLine === 'number' ? { start: input.startLine } : {}),
        ...(typeof input.endLine === 'number' ? { end: input.endLine } : {})
      }
    });
  }

  async listDirectory(path: string): Promise<Array<{ name: string; type: 'file' | 'directory'; size?: number }>> {
    return this.#request<Array<{ name: string; type: 'file' | 'directory'; size?: number }>>({
      method: 'GET',
      path: '/file',
      query: { path }
    });
  }

  async findFiles(query: { query: string; type?: 'file' | 'directory'; limit?: number }): Promise<string[]> {
    return this.#request<string[]>({
      method: 'GET',
      path: '/find/file',
      query
    });
  }

  async findText(query: { pattern: string; path?: string; include?: string; limit?: number }): Promise<string[]> {
    return this.#request<string[]>({
      method: 'GET',
      path: '/find',
      query
    });
  }

  /**
   * Subscribe to OpenCode SSE events. Returns an async iterator that yields
   * parsed events. The iterator terminates when the connection drops or the
   * signal is aborted.
   */
  async *subscribeEvents(signal?: AbortSignal): AsyncGenerator<OpenCodeEvent, void, void> {
    const url = `${this.#baseUrl}/event`;
    const headers = this.#headers({ Accept: 'text/event-stream' });
    const response = await fetch(url, { method: 'GET', headers, ...(signal ? { signal } : {}) });
    if (!response.ok || !response.body) {
      throw new OpenCodeApiError({
        status: response.status,
        code: `http_${response.status}`,
        message: `opencode event stream failed: ${response.status}`,
        endpoint: '/event',
        body: null
      });
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    try {
      while (true) {
        if (signal?.aborted) break;
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let separatorIndex = buffer.indexOf('\n\n');
        while (separatorIndex >= 0) {
          const raw = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);
          const event = parseSseBlock(raw);
          if (event) {
            this.#emit(event);
            yield event;
          }
          separatorIndex = buffer.indexOf('\n\n');
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
    }
  }
}

function safeParseJson(value: string): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseDiffFiles(diff: string): Array<{ path: string; additions: number; deletions: number; status: string }> {
  if (!diff) return [];
  const files: Array<{ path: string; additions: number; deletions: number; status: string }> = [];
  const lines = diff.split('\n');
  let current: { path: string; additions: number; deletions: number; status: string } | null = null;
  for (const line of lines) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (header && header[2]) {
      if (current) files.push(current);
      current = { path: header[2], additions: 0, deletions: 0, status: 'modified' };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('new file')) current.status = 'added';
    else if (line.startsWith('deleted file')) current.status = 'deleted';
    else if (line.startsWith('+') && !line.startsWith('+++')) current.additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) current.deletions += 1;
  }
  if (current) files.push(current);
  return files;
}

function parseSseBlock(block: string): OpenCodeEvent | null {
  if (!block.trim()) return null;
  let dataPayload = '';
  let eventName: string | null = null;
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataPayload += line.slice(5).trim();
    } else if (line.startsWith(':')) {
      // SSE comment, ignore
    }
  }
  if (!dataPayload) return null;
  const payload = safeParseJson(dataPayload);
  if (!payload) return null;
  if (eventName) {
    return mapEventByName(eventName, payload);
  }
  return mapEventFromObject(payload);
}

function mapEventByName(name: string, payload: unknown): OpenCodeEvent {
  const data = isRecord(payload) ? payload : {};
  switch (name) {
    case 'server.connected':
      return { type: 'server.connected', payload: { baseUrl: String(data.baseUrl ?? '') } };
    case 'session.created':
      return { type: 'session.created', payload: { session: (data.session as OpenCodeSession) ?? (data as unknown as OpenCodeSession) } };
    case 'session.updated':
      return { type: 'session.updated', payload: { session: (data.session as OpenCodeSession) ?? (data as unknown as OpenCodeSession) } };
    case 'session.deleted':
      return { type: 'session.deleted', payload: { sessionID: String(data.sessionID ?? data.id ?? '') } };
    case 'session.idle':
      return { type: 'session.idle', payload: { sessionID: String(data.sessionID ?? data.id ?? '') } };
    case 'message.updated':
      return {
        type: 'message.updated',
        payload: { sessionID: String(data.sessionID ?? ''), message: (data.message as OpenCodeMessage) ?? (data as unknown as OpenCodeMessage) }
      };
    case 'message.part.updated': {
      const innerMessage = isRecord(data.message) ? data.message : null;
      return {
        type: 'message.part.updated',
        payload: {
          sessionID: String(data.sessionID ?? ''),
          messageID: String(data.messageID ?? innerMessage?.id ?? ''),
          part: (data.part as OpenCodeMessagePart) ?? (data as unknown as OpenCodeMessagePart)
        }
      };
    }
    case 'message.part.removed':
      return {
        type: 'message.part.removed',
        payload: {
          sessionID: String(data.sessionID ?? ''),
          messageID: String(data.messageID ?? ''),
          partID: String(data.partID ?? data.id ?? '')
        }
      };
    case 'session.next.prompted':
      return { type: 'session.next.prompted', payload: { sessionID: String(data.sessionID ?? ''), turnID: data.turnID ? String(data.turnID) : undefined } };
    case 'session.next.step.started':
      return {
        type: 'session.next.step.started',
        payload: { sessionID: String(data.sessionID ?? ''), turnID: data.turnID ? String(data.turnID) : undefined, snapshot: data.snapshot ? String(data.snapshot) : undefined }
      };
    case 'session.next.step.ended':
      return {
        type: 'session.next.step.ended',
        payload: { sessionID: String(data.sessionID ?? ''), turnID: data.turnID ? String(data.turnID) : undefined, reason: data.reason ? String(data.reason) : undefined, snapshot: data.snapshot ? String(data.snapshot) : undefined }
      };
    case 'session.next.text.started':
      return { type: 'session.next.text.started', payload: { sessionID: String(data.sessionID ?? ''), messageID: String(data.messageID ?? '') } };
    case 'session.next.text.delta':
      return { type: 'session.next.text.delta', payload: { sessionID: String(data.sessionID ?? ''), messageID: String(data.messageID ?? ''), text: String(data.text ?? data.delta ?? '') } };
    case 'session.next.text.ended':
      return { type: 'session.next.text.ended', payload: { sessionID: String(data.sessionID ?? ''), messageID: String(data.messageID ?? ''), text: String(data.text ?? '') } };
    case 'session.next.reasoning.started':
      return { type: 'session.next.reasoning.started', payload: { sessionID: String(data.sessionID ?? ''), messageID: String(data.messageID ?? '') } };
    case 'session.next.reasoning.delta':
      return { type: 'session.next.reasoning.delta', payload: { sessionID: String(data.sessionID ?? ''), messageID: String(data.messageID ?? ''), text: String(data.text ?? data.delta ?? '') } };
    case 'session.next.reasoning.ended':
      return { type: 'session.next.reasoning.ended', payload: { sessionID: String(data.sessionID ?? ''), messageID: String(data.messageID ?? ''), text: String(data.text ?? '') } };
    case 'session.next.tool.called':
      return {
        type: 'session.next.tool.called',
        payload: {
          sessionID: String(data.sessionID ?? ''),
          messageID: String(data.messageID ?? ''),
          callID: String(data.callID ?? ''),
          tool: String(data.tool ?? ''),
          input: data.input
        }
      };
    case 'session.next.tool.progress':
      return {
        type: 'session.next.tool.progress',
        payload: { sessionID: String(data.sessionID ?? ''), messageID: String(data.messageID ?? ''), callID: String(data.callID ?? ''), elapsedMs: data.elapsedMs ? Number(data.elapsedMs) : undefined }
      };
    case 'session.next.tool.success':
      return {
        type: 'session.next.tool.success',
        payload: {
          sessionID: String(data.sessionID ?? ''),
          messageID: String(data.messageID ?? ''),
          callID: String(data.callID ?? ''),
          output: (data.output as string | unknown[]) ?? '',
          title: data.title ? String(data.title) : undefined,
          metadata: (data.metadata as Record<string, unknown>) ?? undefined,
          elapsedMs: data.elapsedMs ? Number(data.elapsedMs) : undefined
        }
      };
    case 'session.next.tool.failed':
      return {
        type: 'session.next.tool.failed',
        payload: { sessionID: String(data.sessionID ?? ''), messageID: String(data.messageID ?? ''), callID: String(data.callID ?? ''), error: String(data.error ?? 'tool failed'), elapsedMs: data.elapsedMs ? Number(data.elapsedMs) : undefined }
      };
    case 'session.next.shell.started':
      return { type: 'session.next.shell.started', payload: { sessionID: String(data.sessionID ?? ''), callID: String(data.callID ?? ''), command: String(data.command ?? '') } };
    case 'session.next.shell.ended':
      return {
        type: 'session.next.shell.ended',
        payload: {
          sessionID: String(data.sessionID ?? ''),
          callID: String(data.callID ?? ''),
          output: String(data.output ?? ''),
          exitCode: Number(data.exitCode ?? 0),
          durationMs: Number(data.durationMs ?? 0)
        }
      };
    case 'session.next.skill.used':
      return { type: 'session.next.skill.used', payload: { sessionID: String(data.sessionID ?? ''), messageID: String(data.messageID ?? ''), skill: String(data.skill ?? ''), input: data.input } };
    case 'permission.asked':
      return { type: 'permission.asked', payload: { sessionID: String(data.sessionID ?? ''), request: (data.request as OpenCodePermissionRequest) ?? (data as unknown as OpenCodePermissionRequest) } };
    case 'permission.replied':
      return {
        type: 'permission.replied',
        payload: {
          sessionID: String(data.sessionID ?? ''),
          requestID: String(data.requestID ?? data.id ?? ''),
          decision: (data.decision as 'allow' | 'deny' | 'always') ?? 'allow'
        }
      };
    case 'question.asked':
      return { type: 'question.asked', payload: { sessionID: String(data.sessionID ?? ''), request: (data.request as OpenCodeQuestionRequest) ?? (data as unknown as OpenCodeQuestionRequest) } };
    case 'question.replied':
      return { type: 'question.replied', payload: { sessionID: String(data.sessionID ?? ''), requestID: String(data.requestID ?? data.id ?? ''), answers: (data.answers as string[]) ?? [] } };
    case 'question.rejected':
      return { type: 'question.rejected', payload: { sessionID: String(data.sessionID ?? ''), requestID: String(data.requestID ?? data.id ?? '') } };
    case 'todo.updated':
      return { type: 'todo.updated', payload: { sessionID: String(data.sessionID ?? ''), todos: (data.todos as Array<{ id: string; status: string; content: string; priority: string }>) ?? [] } };
    case 'session.error':
      return {
        type: 'session.error',
        payload: {
          sessionID: String(data.sessionID ?? ''),
          error: isRecord(data.error) ? { name: String(data.error.name ?? 'Error'), data: data.error.data as { message?: string } | undefined } : { name: 'Error' }
        }
      };
    default:
      return { type: 'unknown', payload: data };
  }
}

function mapEventFromObject(payload: unknown): OpenCodeEvent {
  if (!isRecord(payload)) return { type: 'unknown', payload };
  const type = typeof payload.type === 'string' ? payload.type : null;
  if (!type) return { type: 'unknown', payload };
  return mapEventByName(type, payload.payload ?? payload.properties ?? payload);
}
