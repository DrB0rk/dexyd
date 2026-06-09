import pino from 'pino';

export const MODULE_NAMES = [
  'auth',
  'pairing',
  'session',
  'stream',
  'scheduledMessages',
  'codexAdapter',
  'harness',
  'terminal',
  'file',
  'diffReview',
  'notification',
  'plugin',
  'tui'
] as const;

export type ModuleName = (typeof MODULE_NAMES)[number];

export type HealthStatus = 'ready' | 'degraded' | 'down';

export type ModuleHealth = {
  status: HealthStatus;
  checkedAt: string;
  details?: Record<string, unknown>;
};

export interface DexydModule {
  readonly name: ModuleName;
  register?(ctx: ModuleContext): Promise<void> | void;
  start?(ctx: ModuleContext): Promise<void> | void;
  stop?(ctx: ModuleContext): Promise<void> | void;
  health(ctx: ModuleContext): Promise<ModuleHealth> | ModuleHealth;
}

export type ModuleContext = {
  logger: pino.Logger;
  config: import('../config/schema.js').DexydConfig;
  runtime: import('../runtime/runtime-state.js').RuntimeState;
  db: import('../db/sqlite.js').SqliteService;
  streamHub?: import('../runtime/stream-hub.js').StreamHub;
  eventService?: import('../services/event-service.js').EventService;
  authService?: import('../services/auth-service.js').AuthService;
  pairingService?: import('../services/pairing-service.js').PairingService;
  codexChatService?: import('../services/codex-chat-service.js').CodexChatService;
  opencodeSessionService?: import('../services/opencode-session-service.js').OpenCodeSessionService;
  opencodeChatService?: import('../services/opencode-chat-service.js').OpenCodeChatService;
  fileService?: import('../services/file-service.js').FileService;
  diffService?: import('../services/diff-service.js').DiffService;
};
