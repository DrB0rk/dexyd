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
    createScaffoldModule('tui', 'terminal dashboard and local admin workflows')
  ];
}
