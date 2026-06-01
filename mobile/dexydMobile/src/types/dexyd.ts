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
  source?: 'dexyd' | 'codex';
  title?: string;
  omx?: boolean;
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
  status: 'sent' | 'running' | 'failed' | 'cancelled';
};
