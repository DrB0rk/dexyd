import { normalizeBridgeHttpUrl } from '../config/bridge';
import { CodexAuthStatus, DeviceRecord, DiffSummary, FileListResponse, FileReadResponse, PairingCompleteResponse, PairingStartResponse, ProjectBrowseResponse, ProjectSuggestResponse, UsageStatus } from '../types/api';
import { ChatMessage, DexydSession, EventEnvelope } from '../types/dexyd';

export type AuthTokens = {
  accessToken: string;
  refreshToken: string;
};

async function fetchJson<T>(baseUrl: string, path: string, init?: RequestInit, tokens?: AuthTokens): Promise<T> {
  const hasBody = init?.body !== undefined && init.body !== null;
  const response = await fetch(`${normalizeBridgeHttpUrl(baseUrl)}${path}`, {
    ...init,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(tokens?.accessToken ? { Authorization: `Bearer ${tokens.accessToken}` } : {}),
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`dexyd request failed (${response.status}): ${text}`);
  }

  return (await response.json()) as T;
}

export async function pairingStart(baseUrl: string): Promise<PairingStartResponse> {
  return fetchJson<PairingStartResponse>(baseUrl, '/pairing/start', {
    method: 'POST',
    body: JSON.stringify({})
  });
}

export async function pairingComplete(input: {
  pairingId?: string;
  challenge?: string;
  pairingUri?: string;
  deviceLabel: string;
}, baseUrl: string): Promise<PairingCompleteResponse> {
  return fetchJson<PairingCompleteResponse>(baseUrl, '/pairing/complete', {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export async function refreshTokens(baseUrl: string, refreshToken: string): Promise<PairingCompleteResponse> {
  return fetchJson<PairingCompleteResponse>(baseUrl, '/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refreshToken })
  });
}

export async function revoke(baseUrl: string, tokens: AuthTokens): Promise<void> {
  await fetchJson(baseUrl, '/auth/revoke', { method: 'POST', body: JSON.stringify({}) }, tokens);
}

export async function getSessions(baseUrl: string, tokens: AuthTokens): Promise<DexydSession[]> {
  const result = await fetchJson<{ sessions: DexydSession[] }>(baseUrl, '/sessions', undefined, tokens);
  return result.sessions;
}

export async function getProjects(baseUrl: string, tokens: AuthTokens, path = ''): Promise<ProjectBrowseResponse> {
  const suffix = path ? `?path=${encodeURIComponent(path)}` : '';
  return fetchJson<ProjectBrowseResponse>(baseUrl, `/projects${suffix}`, undefined, tokens);
}

export async function suggestProjects(baseUrl: string, tokens: AuthTokens, path = ''): Promise<ProjectSuggestResponse> {
  const suffix = path ? `?path=${encodeURIComponent(path)}` : '';
  return fetchJson<ProjectSuggestResponse>(baseUrl, `/projects/suggest${suffix}`, undefined, tokens);
}

export async function getCodexAuthStatus(baseUrl: string, tokens: AuthTokens): Promise<CodexAuthStatus> {
  const result = await fetchJson<{ codexAuth: CodexAuthStatus }>(baseUrl, '/codex-auth/status', undefined, tokens);
  return result.codexAuth;
}

export async function switchCodexAuthAccount(baseUrl: string, tokens: AuthTokens, query: string): Promise<CodexAuthStatus> {
  const result = await fetchJson<{ codexAuth: CodexAuthStatus }>(
    baseUrl,
    '/codex-auth/switch',
    {
      method: 'POST',
      body: JSON.stringify({ query })
    },
    tokens
  );
  return result.codexAuth;
}

export async function createSession(baseUrl: string, workspacePath: string, tokens: AuthTokens, title?: string): Promise<DexydSession> {
  const result = await fetchJson<{ session: DexydSession }>(
    baseUrl,
    '/sessions',
    {
      method: 'POST',
      body: JSON.stringify({ workspacePath, profile: 'default', ...(title?.trim() ? { title: title.trim() } : {}) })
    },
    tokens
  );

  return result.session;
}

export async function createDexydChatSession(baseUrl: string, tokens: AuthTokens): Promise<DexydSession> {
  const result = await fetchJson<{ session: DexydSession }>(
    baseUrl,
    '/dexyd-chat/session',
    { method: 'POST', body: JSON.stringify({}) },
    tokens
  );
  return result.session;
}

function sessionPath(sessionId: string, suffix = ''): string {
  return `/sessions/${encodeURIComponent(sessionId)}${suffix}`;
}

export async function deleteSession(baseUrl: string, sessionId: string, tokens: AuthTokens): Promise<{ deleted: boolean; hidden: boolean }> {
  return fetchJson<{ deleted: boolean; hidden: boolean }>(baseUrl, sessionPath(sessionId), { method: 'DELETE' }, tokens);
}

export async function patchSessionStatus(
  baseUrl: string,
  sessionId: string,
  status: DexydSession['status'],
  tokens: AuthTokens
): Promise<DexydSession> {
  const result = await fetchJson<{ session: DexydSession }>(
    baseUrl,
    sessionPath(sessionId),
    {
      method: 'PATCH',
      body: JSON.stringify({ status })
    },
    tokens
  );

  return result.session;
}

export async function getHealth(baseUrl: string): Promise<{ status: string }> {
  return fetchJson<{ status: string }>(baseUrl, '/health/ready');
}

export async function getDevices(baseUrl: string, tokens: AuthTokens): Promise<DeviceRecord[]> {
  const result = await fetchJson<{ devices: DeviceRecord[] }>(baseUrl, '/devices', undefined, tokens);
  return result.devices;
}

export async function getUsageStatus(baseUrl: string, tokens: AuthTokens, sessionId?: string | null): Promise<UsageStatus> {
  const suffix = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
  const result = await fetchJson<{ usage: UsageStatus }>(baseUrl, `/usage/status${suffix}`, undefined, tokens);
  return result.usage;
}

export async function revokeDevice(baseUrl: string, deviceId: string, tokens: AuthTokens): Promise<{ revoked: boolean }> {
  return fetchJson<{ revoked: boolean }>(baseUrl, `/devices/${deviceId}`, { method: 'DELETE' }, tokens);
}

export async function getChatMessages(baseUrl: string, sessionId: string, tokens: AuthTokens): Promise<ChatMessage[]> {
  const result = await fetchJson<{ messages: ChatMessage[] }>(baseUrl, sessionPath(sessionId, '/chat?limit=200'), undefined, tokens);
  return result.messages;
}

export async function sendChatMessage(
  baseUrl: string,
  sessionId: string,
  message: string,
  tokens: AuthTokens
): Promise<{ turnId: string; userEvent: EventEnvelope }> {
  return fetchJson<{ turnId: string; userEvent: EventEnvelope }>(
    baseUrl,
    sessionPath(sessionId, '/chat'),
    {
      method: 'POST',
      body: JSON.stringify({ message })
    },
    tokens
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
  tokens: AuthTokens
): Promise<{ event: EventEnvelope; response: Record<string, unknown> }> {
  return fetchJson<{ event: EventEnvelope; response: Record<string, unknown> }>(
    baseUrl,
    `/interactions/${encodeURIComponent(interactionId)}/respond`,
    {
      method: 'POST',
      body: JSON.stringify({
        ...input,
        ...(input.sessionId ? { sessionId: input.sessionId } : {})
      })
    },
    tokens
  );
}

export async function cancelSession(baseUrl: string, sessionId: string, tokens: AuthTokens): Promise<{ cancelled: boolean; killed: boolean }> {
  return fetchJson<{ cancelled: boolean; killed: boolean }>(baseUrl, sessionPath(sessionId, '/cancel'), { method: 'POST' }, tokens);
}

export async function listFiles(baseUrl: string, sessionId: string, path: string, tokens: AuthTokens): Promise<FileListResponse> {
  return fetchJson<FileListResponse>(baseUrl, `${sessionPath(sessionId, '/files')}?path=${encodeURIComponent(path)}`, undefined, tokens);
}

export async function readFile(baseUrl: string, sessionId: string, path: string, tokens: AuthTokens): Promise<FileReadResponse> {
  return fetchJson<FileReadResponse>(baseUrl, `${sessionPath(sessionId, '/files/read')}?path=${encodeURIComponent(path)}`, undefined, tokens);
}

export async function getDiff(baseUrl: string, sessionId: string, tokens: AuthTokens): Promise<DiffSummary> {
  return fetchJson<DiffSummary>(baseUrl, sessionPath(sessionId, '/diff'), undefined, tokens);
}
