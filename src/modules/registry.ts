import { DexydModule } from '../core/module.js';
import { createScaffoldModule } from './scaffold-module.js';

export function createCoreModules(): DexydModule[] {
  let streamHeartbeat: NodeJS.Timeout | undefined;
  let streamPrune: NodeJS.Timeout | undefined;

  const streamModule = createScaffoldModule('stream', 'websocket state, sequencing, replay, heartbeat', {
    onStart: (ctx) => {
      const heartbeatMs = ctx.config.stream.heartbeatIdleSeconds * 1000;
      streamHeartbeat = setInterval(() => {
        ctx.eventService?.emit({
          eventType: 'heartbeat',
          payload: {
            clients: ctx.streamHub?.clientCount() ?? 0
          },
          source: 'stream'
        });
      }, heartbeatMs);

      const pruneEveryMs = Math.max(30_000, Math.floor(heartbeatMs / 2));
      streamPrune = setInterval(() => {
        ctx.eventService?.pruneExpiredEvents();
      }, pruneEveryMs);
    },
    onStop: () => {
      if (streamHeartbeat) {
        clearInterval(streamHeartbeat);
        streamHeartbeat = undefined;
      }

      if (streamPrune) {
        clearInterval(streamPrune);
        streamPrune = undefined;
      }
    }
  });

  const scheduledMessagesModule = createScaffoldModule('scheduledMessages', 'persisted one-time and repeated chat prompts', {
    onStart: (ctx) => {
      ctx.codexChatService?.startScheduledMessages();
    },
    onStop: (ctx) => {
      ctx.codexChatService?.stopScheduledMessages();
    }
  });

  const opencodeAdapter = createScaffoldModule(
    'opencodeAdapter',
    'opencode serve daemon lifecycle, HTTP API client, tool/skill/agent surfaces, and SSE event bridge',
    {
      onStart: (ctx) => {
        const manager = ctx.opencodeServerManager;
        const chat = ctx.opencodeChatService;
        if (!manager || !chat) return;
        if (!manager.isEnabled()) {
          ctx.logger.info({}, 'opencode integration disabled in config; adapter running in passive mode');
          return;
        }
        manager
          .ensureReady()
          .then(async (handle) => {
            if (!handle) return;
            ctx.logger.info({ baseUrl: handle.baseUrl }, 'opencode serve daemon is ready');
            await chat.startEventStream();
          })
          .catch((error) => {
            ctx.logger.warn(
              { error: error instanceof Error ? error.message : 'unknown' },
              'opencode serve daemon failed to start; continuing in passive mode'
            );
          });
      },
      onStop: (ctx) => {
        ctx.opencodeChatService?.stopEventStream().catch(() => undefined);
        ctx.opencodeServerManager?.dispose().catch(() => undefined);
      },
      healthDetails: (ctx) => {
        const state = ctx.opencodeServerManager?.state;
        if (!state) return {};
        return {
          status: state.status,
          version: state.version,
          error: state.error,
          baseUrl: state.handle?.baseUrl ?? null,
          pid: state.handle?.pid ?? null
        };
      }
    }
  );

  return [
    createScaffoldModule('auth', 'tokens, device identity, revocation and replay protection'),
    createScaffoldModule('pairing', 'qr payload generation and device trust establishment'),
    createScaffoldModule('session', 'session lifecycle and restoration'),
    streamModule,
    scheduledMessagesModule,
    createScaffoldModule('codexAdapter', 'capability probing and execution normalization'),
    createScaffoldModule('harness', 'omx/subprocess harness management and cancellation'),
    createScaffoldModule('terminal', 'pty lifecycle, resizing, input forwarding and bounded history'),
    createScaffoldModule('file', 'workspace browsing, metadata and safe read/write operations'),
    createScaffoldModule('diffReview', 'patch review state, hunk approvals and revert controls'),
    createScaffoldModule('notification', 'notification routing and provider dispatch'),
    createScaffoldModule('plugin', 'plugin lifecycle, permission checks and isolation'),
    createScaffoldModule('tui', 'terminal dashboard and local admin workflows'),
    opencodeAdapter
  ];
}
