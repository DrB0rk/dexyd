import pino from 'pino';
import { advertisedBridgeBaseUrl } from '../config/bridge-url.js';
import { DexydConfig } from '../config/schema.js';
import { ModuleContext } from '../core/module.js';
import { SqliteService } from '../db/sqlite.js';
import { AuthService } from '../services/auth-service.js';
import { CodexAuthService } from '../services/codex-auth-service.js';
import { CodexChatService } from '../services/codex-chat-service.js';
import { CommandService } from '../services/command-service.js';
import { CodexSessionService } from '../services/codex-session-service.js';
import { DexydChatService } from '../services/dexyd-chat-service.js';
import { DiffService } from '../services/diff-service.js';
import { EventService } from '../services/event-service.js';
import { FileService } from '../services/file-service.js';
import { OpenCodeApiClient } from '../services/opencode-api-client.js';
import { OpenCodeChatService } from '../services/opencode-chat-service.js';
import { OpenCodeServerManager } from '../services/opencode-server-manager.js';
import { OpenCodeSessionService } from '../services/opencode-session-service.js';
import { PairingService } from '../services/pairing-service.js';
import { ProjectService } from '../services/project-service.js';
import { RuntimeState } from './runtime-state.js';
import { StreamHub } from './stream-hub.js';

export type AppContext = ModuleContext & {
  logger: pino.Logger;
  streamHub: StreamHub;
  eventService: EventService;
  authService: AuthService;
  pairingService: PairingService;
  codexAuthService: CodexAuthService;
  codexChatService: CodexChatService;
  commandService: CommandService;
  codexSessionService: CodexSessionService;
  opencodeServerManager: OpenCodeServerManager;
  opencodeApiClient: OpenCodeApiClient;
  opencodeSessionService: OpenCodeSessionService;
  opencodeChatService: OpenCodeChatService;
  fileService: FileService;
  dexydChatService: DexydChatService;
  diffService: DiffService;
  projectService: ProjectService;
};

export function buildAppContext(config: DexydConfig): AppContext {
  const logger = pino({
    name: 'dexyd',
    level: config.server.logLevel,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie'],
      censor: '[redacted]'
    },
    serializers: {
      req: serializeRequest
    }
  });
  const runtime = new RuntimeState();
  const db = new SqliteService(config, logger);

  runtime.initializeSequence(db.getLatestEventSequence());

  const streamHub = new StreamHub(
    config.stream.maxQueuedEventsPerClient,
    config.stream.maxBufferedBytes,
    logger
  );

  const eventService = new EventService(
    runtime,
    db,
    streamHub,
    config.stream.replayWindowSeconds,
    config.stream.maxReplayEvents,
    logger
  );

  const authService = new AuthService(
    db,
    config.auth.signingKey,
    config.auth.accessTokenTtlSeconds,
    config.auth.refreshTokenTtlSeconds,
    logger
  );

  const pairingBridgeBaseUrl = advertisedBridgeBaseUrl({
    host: config.server.host,
    port: config.server.port,
    publicBaseUrl: config.server.publicBaseUrl
  });

  const pairingService = new PairingService(
    db,
    authService,
    pairingBridgeBaseUrl,
    logger
  );

  const codexAuthService = new CodexAuthService();
  const commandService = new CommandService();
  const codexSessionService = new CodexSessionService(config.codex.workspaceRoot, logger);
  const diffService = new DiffService();

  const codexChatService = new CodexChatService(
    db,
    eventService,
    codexSessionService,
    diffService,
    {
      runtimePath: config.codex.runtimePath,
      permissionMode: config.codex.permissionMode,
      harness: config.codex.harness
    },
    logger
  );
  const dexydChatService = new DexydChatService(config.codex.workspaceRoot);

  const opencodeServerManager = new OpenCodeServerManager(
    {
      enabled: config.opencode.enabled,
      runtimePath: config.opencode.runtimePath,
      host: config.opencode.server.host,
      port: config.opencode.server.port,
      startTimeoutMs: config.opencode.server.startTimeoutMs,
      healthTimeoutMs: config.opencode.server.healthTimeoutMs,
      ...(config.opencode.server.password ? { password: config.opencode.server.password } : {}),
      cors: config.opencode.server.cors,
      mdns: config.opencode.server.mdns,
      mdnsDomain: config.opencode.server.mdnsDomain,
      extraArgs: config.opencode.server.extraArgs
    },
    logger
  );

  const opencodeApiClient = new OpenCodeApiClient(
    {
      baseUrl: `http://${config.opencode.server.host}:${config.opencode.server.port}`,
      ...(config.opencode.server.password ? { password: config.opencode.server.password } : {}),
      timeoutMs: 30_000,
      retries: 2
    },
    logger
  );

  const opencodeSessionService = new OpenCodeSessionService({
    dataDir: config.opencode.dataDir,
    apiClient: opencodeApiClient,
    serverManager: opencodeServerManager,
    defaultAgent: config.opencode.defaultAgent,
    defaultModel: config.opencode.defaultModel,
    logger
  });

  const opencodeChatService = new OpenCodeChatService(
    eventService,
    opencodeSessionService,
    opencodeApiClient,
    {
      runtimePath: config.opencode.runtimePath,
      permissionMode: config.opencode.permissionMode,
      defaultAgent: config.opencode.defaultAgent,
      defaultModel: config.opencode.defaultModel,
      eventStreamEnabled: config.opencode.eventStreamEnabled,
      streamReconnectMs: config.opencode.streamReconnectMs,
      streamIdleTimeoutMs: config.opencode.streamIdleTimeoutMs
    },
    logger
  );

  const fileService = new FileService();
  const projectService = new ProjectService(config.codex.workspaceRoot);

  return {
    logger,
    config,
    runtime,
    db,
    streamHub,
    eventService,
    authService,
    pairingService,
    codexAuthService,
    codexChatService,
    commandService,
    codexSessionService,
    opencodeServerManager,
    opencodeApiClient,
    opencodeSessionService,
    opencodeChatService,
    dexydChatService,
    fileService,
    diffService,
    projectService
  };
}

function serializeRequest(request: {
  method?: string;
  url?: string;
  headers?: Record<string, unknown>;
  socket?: { remoteAddress?: string };
}): Record<string, unknown> {
  return {
    method: request.method,
    url: redactSensitiveUrl(request.url ?? ''),
    host: typeof request.headers?.host === 'string' ? request.headers.host : undefined,
    remoteAddress: request.socket?.remoteAddress
  };
}

function redactSensitiveUrl(input: string): string {
  if (!input.includes('access_token=')) {
    return input;
  }

  try {
    const url = new URL(input, 'http://dexyd.local');
    if (url.searchParams.has('access_token')) {
      url.searchParams.set('access_token', '[redacted]');
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return input.replace(/([?&]access_token=)[^&]*/g, '$1[redacted]');
  }
}
