export type SessionStatus =
  | 'created'
  | 'running'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type DexydSession = {
  id: string;
  status: SessionStatus;
  profile: string;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
  source?: 'dexyd' | 'codex' | 'opencode';
  title?: string;
  omx?: boolean;
  agent?: string;
  model?: string | null;
  tokenUsage?: {
    input: number | null;
    output: number | null;
    total: number | null;
  };
  usageContext?: {
    usedTokens: number | null;
    windowTokens: number | null;
    percent: number | null;
    status: 'ok' | 'warn' | 'error' | 'unknown';
  };
};



export type HiddenDexydSession = {
  id: string;
  hiddenAt: string;
  session: DexydSession | null;
};

export type QueuedChatMessage = {
  queueId: string;
  turnId: string;
  sessionId: string;
  content: string;
  actorDeviceId: string;
  createdAt: string;
  updatedAt: string;
};

export type ScheduledChatMessage = {
  id: string;
  sessionId: string;
  content: string;
  actorDeviceId: string;
  nextRunAt: string;
  repeatIntervalMs: number | null;
  repeatMaxRuns: number | null;
  runCount: number;
  status: 'scheduled' | 'completed' | 'cancelled' | 'failed';
  lastRunAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type EventEnvelope<T = unknown> = {
  sequence: number;
  timestamp: string;
  eventType: string;
  sessionId: string | null;
  streamId: string | null;
  source: string;
  payload: T;
};

export type PairingPayload = {
  version: 1;
  bridgeBaseUrl: string;
  pairingId: string;
  challenge: string;
  expiresAt: string;
};

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool';

export type ChatMessage = {
  id: string;
  turnId: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  sequence: number;
  status: 'sent' | 'running' | 'failed' | 'cancelled' | 'queued';
  queueId?: string;
};
