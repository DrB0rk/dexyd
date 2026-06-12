import { normalizeBridgeHttpUrl } from '../config/bridge';

const API_TIMEOUT_MS = 15000;
import {
  CodexAuthStatus,
  CommandsResponse,
  DeviceRecord,
  DiffSummary,
  FileListResponse,
  FileReadResponse,
  OpenCodeAgentsResponse,
  OpenCodeCommandsResponse,
  OpenCodeCreateSessionInput,
  OpenCodeCreateSessionResponse,
  OpenCodeModelsResponse,
  OpenCodePermissionReplyInput,
  OpenCodeProvidersResponse,
  OpenCodeQuestionReplyInput,
  OpenCodeSkillsResponse,
  OpenCodeStatusResponse,
  OpenCodeToolsResponse,
  PairingCompleteResponse,
  PairingStartResponse,
  ProjectBrowseResponse,
  ProjectSuggestResponse,
  UsageStatus,
} from '../types/api';
import {
  ChatMessage,
  DexydSession,
  EventEnvelope,
  HiddenDexydSession,
  QueuedChatMessage,
  ScheduledChatMessage,
} from '../types/dexyd';

export type AuthTokens = {
  accessToken: string;
  refreshToken: string;
};

export class DexydApiError extends Error {
  status: number;
  bodyText: string;
  body: unknown;
  code: string | null;
  endpoint: string;

  constructor(
    status: number,
    bodyText: string,
    body: unknown,
    endpoint: string,
  ) {
    const code =
      isRecord(body) && typeof body.error === 'string' ? body.error : null;
    const detail =
      isRecord(body) && typeof body.detail === 'string'
        ? body.detail
        : (code ?? (bodyText.trim() || 'request failed'));

    super(`Bridge returned HTTP ${status} for ${endpoint}: ${detail}`);
    this.name = 'DexydApiError';
    this.status = status;
    this.bodyText = bodyText;
    this.body = body;
    this.code = code;
    this.endpoint = endpoint;
  }
}

export class DexydBridgeConnectionError extends Error {
  bridgeUrl: string;
  endpoint: string;
  detail: string;

  constructor(bridgeUrl: string, endpoint: string, detail: string) {
    const normalized = safeNormalizeBridgeUrl(bridgeUrl);
    super(
      `Can't reach Dexyd bridge at ${normalized}${endpoint}. ` +
        'Check that the bridge service is running, this phone can reach the LAN/domain/tunnel, and the firewall allows the bridge port. ' +
        `Detail: ${detail}`,
    );
    this.name = 'DexydBridgeConnectionError';
    this.bridgeUrl = normalized;
    this.endpoint = endpoint;
    this.detail = detail;
  }
}

function safeNormalizeBridgeUrl(baseUrl: string): string {
  try {
    return normalizeBridgeHttpUrl(baseUrl);
  } catch {
    return baseUrl.trim() || '(not configured)';
  }
}

async function fetchJson<T>(
  baseUrl: string,
  path: string,
  init?: RequestInit,
  tokens?: AuthTokens,
): Promise<T> {
  let normalizedBaseUrl: string;
  try {
    normalizedBaseUrl = normalizeBridgeHttpUrl(baseUrl);
  } catch (error) {
    throw new DexydBridgeConnectionError(
      baseUrl,
      path,
      error instanceof Error ? error.message : 'invalid bridge URL',
    );
  }

  const endpoint = `${normalizedBaseUrl}${path}`;
  const hasBody = init?.body !== undefined && init.body !== null;
  let response: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    response = await fetch(endpoint, {
      ...init,
      signal: init?.signal ?? controller.signal,
      headers: {
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        ...(tokens?.accessToken
          ? { Authorization: `Bearer ${tokens.accessToken}` }
          : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (error) {
    throw new DexydBridgeConnectionError(
      normalizedBaseUrl,
      path,
      error instanceof Error && error.message.trim()
        ? error.message
        : 'network request failed',
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new DexydApiError(response.status, text, parseJson(text), path);
  }

  return (await response.json()) as T;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function pairingStart(
  baseUrl: string,
): Promise<PairingStartResponse> {
  return fetchJson<PairingStartResponse>(baseUrl, '/pairing/start', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function pairingComplete(
  input: {
    pairingId?: string;
    challenge?: string;
    pairingUri?: string;
    deviceLabel: string;
  },
  baseUrl: string,
): Promise<PairingCompleteResponse> {
  return fetchJson<PairingCompleteResponse>(baseUrl, '/pairing/complete', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function refreshTokens(
  baseUrl: string,
  refreshToken: string,
): Promise<PairingCompleteResponse> {
  return fetchJson<PairingCompleteResponse>(baseUrl, '/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refreshToken }),
  });
}

export async function revoke(
  baseUrl: string,
  tokens: AuthTokens,
): Promise<void> {
  await fetchJson(
    baseUrl,
    '/auth/revoke',
    { method: 'POST', body: JSON.stringify({}) },
    tokens,
  );
}

export async function getSessions(
  baseUrl: string,
  tokens: AuthTokens,
  options: { limit?: number; workspacePath?: string } = {},
): Promise<DexydSession[]> {
  const params = new URLSearchParams();
  params.set('limit', String(options.limit ?? 2000));
  if (options.workspacePath?.trim()) {
    params.set('workspacePath', options.workspacePath.trim());
  }
  const result = await fetchJson<{ sessions: DexydSession[] }>(
    baseUrl,
    `/sessions?${params.toString()}`,
    undefined,
    tokens,
  );
  return result.sessions;
}

export async function getHiddenSessions(
  baseUrl: string,
  tokens: AuthTokens,
): Promise<HiddenDexydSession[]> {
  const result = await fetchJson<{ sessions: HiddenDexydSession[] }>(
    baseUrl,
    '/sessions/hidden',
    undefined,
    tokens,
  );
  return result.sessions;
}

export async function restoreSession(
  baseUrl: string,
  sessionId: string,
  tokens: AuthTokens,
): Promise<{ restored: boolean; session: DexydSession | null }> {
  return fetchJson<{ restored: boolean; session: DexydSession | null }>(
    baseUrl,
    sessionPath(sessionId, '/restore'),
    { method: 'POST', body: JSON.stringify({}) },
    tokens,
  );
}

export async function getProjects(
  baseUrl: string,
  tokens: AuthTokens,
  path = '',
): Promise<ProjectBrowseResponse> {
  const suffix = path ? `?path=${encodeURIComponent(path)}` : '';
  return fetchJson<ProjectBrowseResponse>(
    baseUrl,
    `/projects${suffix}`,
    undefined,
    tokens,
  );
}

export async function suggestProjects(
  baseUrl: string,
  tokens: AuthTokens,
  path = '',
): Promise<ProjectSuggestResponse> {
  const suffix = path ? `?path=${encodeURIComponent(path)}` : '';
  return fetchJson<ProjectSuggestResponse>(
    baseUrl,
    `/projects/suggest${suffix}`,
    undefined,
    tokens,
  );
}

export async function getCommands(
  baseUrl: string,
  tokens: AuthTokens,
  sessionId?: string | null,
): Promise<CommandsResponse> {
  const suffix = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
  return fetchJson<CommandsResponse>(
    baseUrl,
    `/commands${suffix}`,
    undefined,
    tokens,
  );
}

export async function getCodexAuthStatus(
  baseUrl: string,
  tokens: AuthTokens,
): Promise<CodexAuthStatus> {
  const result = await fetchJson<{ codexAuth: CodexAuthStatus }>(
    baseUrl,
    '/codex-auth/status',
    undefined,
    tokens,
  );
  return result.codexAuth;
}

export async function switchCodexAuthAccount(
  baseUrl: string,
  tokens: AuthTokens,
  query: string,
): Promise<CodexAuthStatus> {
  const result = await fetchJson<{ codexAuth: CodexAuthStatus }>(
    baseUrl,
    '/codex-auth/switch',
    {
      method: 'POST',
      body: JSON.stringify({ query }),
    },
    tokens,
  );
  return result.codexAuth;
}

export async function createSession(
  baseUrl: string,
  workspacePath: string,
  tokens: AuthTokens,
  title?: string,
): Promise<DexydSession> {
  const result = await fetchJson<{ session: DexydSession }>(
    baseUrl,
    '/sessions',
    {
      method: 'POST',
      body: JSON.stringify({
        workspacePath,
        profile: 'default',
        source: 'codex',
        ...(title?.trim() ? { title: title.trim() } : {}),
      }),
    },
    tokens,
  );

  return result.session;
}

export async function createDexydChatSession(
  baseUrl: string,
  tokens: AuthTokens,
): Promise<DexydSession> {
  const result = await fetchJson<{ session: DexydSession }>(
    baseUrl,
    '/dexyd-chat/session',
    { method: 'POST', body: JSON.stringify({}) },
    tokens,
  );
  return result.session;
}

function sessionPath(sessionId: string, suffix = ''): string {
  return `/sessions/${encodeURIComponent(sessionId)}${suffix}`;
}

export async function deleteSession(
  baseUrl: string,
  sessionId: string,
  tokens: AuthTokens,
): Promise<{ deleted: boolean; hidden: boolean }> {
  return fetchJson<{ deleted: boolean; hidden: boolean }>(
    baseUrl,
    sessionPath(sessionId),
    { method: 'DELETE' },
    tokens,
  );
}

export async function patchSessionStatus(
  baseUrl: string,
  sessionId: string,
  status: DexydSession['status'],
  tokens: AuthTokens,
): Promise<DexydSession> {
  const result = await fetchJson<{ session: DexydSession }>(
    baseUrl,
    sessionPath(sessionId),
    {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    },
    tokens,
  );

  return result.session;
}

export async function getHealth(baseUrl: string): Promise<{ status: string }> {
  return fetchJson<{ status: string }>(baseUrl, '/health/ready');
}

export async function getDevices(
  baseUrl: string,
  tokens: AuthTokens,
): Promise<DeviceRecord[]> {
  const result = await fetchJson<{ devices: DeviceRecord[] }>(
    baseUrl,
    '/devices',
    undefined,
    tokens,
  );
  return result.devices;
}

export async function getUsageStatus(
  baseUrl: string,
  tokens: AuthTokens,
  sessionId?: string | null,
): Promise<UsageStatus> {
  const suffix = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
  const result = await fetchJson<{ usage: UsageStatus }>(
    baseUrl,
    `/usage/status${suffix}`,
    undefined,
    tokens,
  );
  return result.usage;
}

export async function revokeDevice(
  baseUrl: string,
  deviceId: string,
  tokens: AuthTokens,
): Promise<{ revoked: boolean }> {
  return fetchJson<{ revoked: boolean }>(
    baseUrl,
    `/devices/${deviceId}`,
    { method: 'DELETE' },
    tokens,
  );
}

export async function getChatMessages(
  baseUrl: string,
  sessionId: string,
  tokens: AuthTokens,
): Promise<ChatMessage[]> {
  const result = await fetchJson<{ messages: ChatMessage[] }>(
    baseUrl,
    sessionPath(sessionId, '/chat?limit=200'),
    undefined,
    tokens,
  );
  return result.messages;
}

export async function sendChatMessage(
  baseUrl: string,
  sessionId: string,
  message: string,
  tokens: AuthTokens,
): Promise<{
  turnId: string;
  userEvent: EventEnvelope;
  queued?: boolean;
  queueId?: string;
}> {
  return fetchJson<{
    turnId: string;
    userEvent: EventEnvelope;
    queued?: boolean;
    queueId?: string;
  }>(
    baseUrl,
    sessionPath(sessionId, '/chat'),
    {
      method: 'POST',
      body: JSON.stringify({ message }),
    },
    tokens,
  );
}

export async function respondToInteraction(
  baseUrl: string,
  interactionId: string,
  input:
    | {
        kind: 'approval';
        decision: 'approved' | 'denied';
        note?: string;
        sessionId?: string | null;
      }
    | {
        kind: 'question';
        answer: string;
        choiceId?: string;
        sessionId?: string | null;
      },
  tokens: AuthTokens,
): Promise<{ event: EventEnvelope; response: Record<string, unknown> }> {
  return fetchJson<{ event: EventEnvelope; response: Record<string, unknown> }>(
    baseUrl,
    `/interactions/${encodeURIComponent(interactionId)}/respond`,
    {
      method: 'POST',
      body: JSON.stringify({
        ...input,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      }),
    },
    tokens,
  );
}

export async function getQueuedMessages(
  baseUrl: string,
  sessionId: string,
  tokens: AuthTokens,
): Promise<QueuedChatMessage[]> {
  const result = await fetchJson<{ queue: QueuedChatMessage[] }>(
    baseUrl,
    sessionPath(sessionId, '/queue'),
    undefined,
    tokens,
  );
  return result.queue;
}

export async function steerQueuedMessage(
  baseUrl: string,
  sessionId: string,
  queueId: string,
  message: string,
  tokens: AuthTokens,
): Promise<QueuedChatMessage> {
  const result = await fetchJson<{ queued: QueuedChatMessage }>(
    baseUrl,
    sessionPath(sessionId, `/queue/${encodeURIComponent(queueId)}/steer`),
    {
      method: 'POST',
      body: JSON.stringify({ message }),
    },
    tokens,
  );
  return result.queued;
}

export async function removeQueuedMessage(
  baseUrl: string,
  sessionId: string,
  queueId: string,
  tokens: AuthTokens,
): Promise<{ removed: boolean }> {
  return fetchJson<{ removed: boolean }>(
    baseUrl,
    sessionPath(sessionId, `/queue/${encodeURIComponent(queueId)}`),
    { method: 'DELETE' },
    tokens,
  );
}

export async function getScheduledMessages(
  baseUrl: string,
  sessionId: string,
  tokens: AuthTokens,
): Promise<ScheduledChatMessage[]> {
  const result = await fetchJson<{ scheduled: ScheduledChatMessage[] }>(
    baseUrl,
    sessionPath(sessionId, '/scheduled'),
    undefined,
    tokens,
  );
  return result.scheduled;
}

export async function scheduleChatMessage(
  baseUrl: string,
  sessionId: string,
  input: {
    message: string;
    runAt: string;
    repeat?: { intervalMs: number; maxRuns?: number };
  },
  tokens: AuthTokens,
): Promise<ScheduledChatMessage> {
  const result = await fetchJson<{ scheduled: ScheduledChatMessage }>(
    baseUrl,
    sessionPath(sessionId, '/scheduled'),
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
    tokens,
  );
  return result.scheduled;
}

export async function cancelScheduledMessage(
  baseUrl: string,
  sessionId: string,
  scheduleId: string,
  tokens: AuthTokens,
): Promise<ScheduledChatMessage> {
  const result = await fetchJson<{ scheduled: ScheduledChatMessage }>(
    baseUrl,
    sessionPath(sessionId, `/scheduled/${encodeURIComponent(scheduleId)}`),
    { method: 'DELETE' },
    tokens,
  );
  return result.scheduled;
}

export async function cancelSession(
  baseUrl: string,
  sessionId: string,
  tokens: AuthTokens,
): Promise<{ cancelled: boolean; killed: boolean }> {
  return fetchJson<{ cancelled: boolean; killed: boolean }>(
    baseUrl,
    sessionPath(sessionId, '/cancel'),
    { method: 'POST' },
    tokens,
  );
}

export async function listFiles(
  baseUrl: string,
  sessionId: string,
  path: string,
  tokens: AuthTokens,
): Promise<FileListResponse> {
  return fetchJson<FileListResponse>(
    baseUrl,
    `${sessionPath(sessionId, '/files')}?path=${encodeURIComponent(path)}`,
    undefined,
    tokens,
  );
}

export async function readFile(
  baseUrl: string,
  sessionId: string,
  path: string,
  tokens: AuthTokens,
): Promise<FileReadResponse> {
  return fetchJson<FileReadResponse>(
    baseUrl,
    `${sessionPath(sessionId, '/files/read')}?path=${encodeURIComponent(path)}`,
    undefined,
    tokens,
  );
}

export async function getDiff(
  baseUrl: string,
  sessionId: string,
  tokens: AuthTokens,
  turnId?: string | null
): Promise<DiffSummary> {
  const suffix = turnId
    ? `/diff?turnId=${encodeURIComponent(turnId)}`
    : '/diff';
  return fetchJson<DiffSummary>(
    baseUrl,
    sessionPath(sessionId, suffix),
    undefined,
    tokens
  );
}

export async function getOpenCodeStatus(
  baseUrl: string,
  tokens: AuthTokens
): Promise<OpenCodeStatusResponse> {
  return fetchJson<OpenCodeStatusResponse>(
    baseUrl,
    '/opencode/status',
    undefined,
    tokens
  );
}

export async function getOpenCodeAgents(
  baseUrl: string,
  tokens: AuthTokens
): Promise<OpenCodeAgentsResponse> {
  return fetchJson<OpenCodeAgentsResponse>(
    baseUrl,
    '/opencode/agents',
    undefined,
    tokens
  );
}

export async function getOpenCodeSkills(
  baseUrl: string,
  tokens: AuthTokens
): Promise<OpenCodeSkillsResponse> {
  return fetchJson<OpenCodeSkillsResponse>(
    baseUrl,
    '/opencode/skills',
    undefined,
    tokens
  );
}

export async function getOpenCodeTools(
  baseUrl: string,
  tokens: AuthTokens
): Promise<OpenCodeToolsResponse> {
  return fetchJson<OpenCodeToolsResponse>(
    baseUrl,
    '/opencode/tools',
    undefined,
    tokens
  );
}

export async function getOpenCodeCommands(
  baseUrl: string,
  tokens: AuthTokens
): Promise<OpenCodeCommandsResponse> {
  return fetchJson<OpenCodeCommandsResponse>(
    baseUrl,
    '/opencode/commands',
    undefined,
    tokens
  );
}

export async function getOpenCodeProviders(
  baseUrl: string,
  tokens: AuthTokens
): Promise<OpenCodeProvidersResponse> {
  return fetchJson<OpenCodeProvidersResponse>(
    baseUrl,
    '/opencode/providers',
    undefined,
    tokens
  );
}

export async function getOpenCodeModels(
  baseUrl: string,
  tokens: AuthTokens,
  provider?: string
): Promise<OpenCodeModelsResponse> {
  const suffix = provider ? `?provider=${encodeURIComponent(provider)}` : '';
  return fetchJson<OpenCodeModelsResponse>(
    baseUrl,
    `/opencode/models${suffix}`,
    undefined,
    tokens
  );
}

export async function createOpenCodeSession(
  baseUrl: string,
  tokens: AuthTokens,
  input: OpenCodeCreateSessionInput
): Promise<OpenCodeCreateSessionResponse> {
  return fetchJson<OpenCodeCreateSessionResponse>(
    baseUrl,
    '/opencode/sessions',
    {
      method: 'POST',
      body: JSON.stringify(input)
    },
    tokens
  );
}

export async function deleteOpenCodeSession(
  baseUrl: string,
  sessionId: string,
  tokens: AuthTokens
): Promise<{ deleted: boolean }> {
  return fetchJson<{ deleted: boolean }>(
    baseUrl,
    `/opencode/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' },
    tokens
  );
}

export async function abortOpenCodeSession(
  baseUrl: string,
  sessionId: string,
  tokens: AuthTokens
): Promise<{ aborted: boolean; cancelled: boolean }> {
  return fetchJson<{ aborted: boolean; cancelled: boolean }>(
    baseUrl,
    `/opencode/sessions/${encodeURIComponent(sessionId)}/abort`,
    { method: 'POST' },
    tokens
  );
}

export async function summarizeOpenCodeSession(
  baseUrl: string,
  sessionId: string,
  tokens: AuthTokens
): Promise<{ ok: boolean }> {
  return fetchJson<{ ok: boolean }>(
    baseUrl,
    `/opencode/sessions/${encodeURIComponent(sessionId)}/summarize`,
    { method: 'POST' },
    tokens
  );
}

export async function replyOpenCodePermission(
  baseUrl: string,
  requestId: string,
  tokens: AuthTokens,
  input: OpenCodePermissionReplyInput
): Promise<{ ok: boolean }> {
  return fetchJson<{ ok: boolean }>(
    baseUrl,
    `/opencode/permissions/${encodeURIComponent(requestId)}/reply`,
    {
      method: 'POST',
      body: JSON.stringify(input)
    },
    tokens
  );
}

export async function replyOpenCodeQuestion(
  baseUrl: string,
  requestId: string,
  tokens: AuthTokens,
  input: OpenCodeQuestionReplyInput
): Promise<{ ok: boolean }> {
  return fetchJson<{ ok: boolean }>(
    baseUrl,
    `/opencode/questions/${encodeURIComponent(requestId)}/reply`,
    {
      method: 'POST',
      body: JSON.stringify(input)
    },
    tokens
  );
}

export async function rejectOpenCodeQuestion(
  baseUrl: string,
  requestId: string,
  tokens: AuthTokens
): Promise<{ ok: boolean }> {
  return fetchJson<{ ok: boolean }>(
    baseUrl,
    `/opencode/questions/${encodeURIComponent(requestId)}/reject`,
    { method: 'POST' },
    tokens
  );
}

export async function runOpenCodeShell(
  baseUrl: string,
  sessionId: string,
  tokens: AuthTokens,
  command: string
): Promise<{ callID: string; output: string; exitCode: number; durationMs: number }> {
  return fetchJson<{ callID: string; output: string; exitCode: number; durationMs: number }>(
    baseUrl,
    `/opencode/sessions/${encodeURIComponent(sessionId)}/shell`,
    {
      method: 'POST',
      body: JSON.stringify({ command })
    },
    tokens
  );
}

export async function runOpenCodeCommand(
  baseUrl: string,
  sessionId: string,
  tokens: AuthTokens,
  command: string,
  args: string[] = []
): Promise<{ callID: string; output: string }> {
  return fetchJson<{ callID: string; output: string }>(
    baseUrl,
    `/opencode/sessions/${encodeURIComponent(sessionId)}/command`,
    {
      method: 'POST',
      body: JSON.stringify({ command, arguments: args })
    },
    tokens
  );
}
