import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEnvelope } from '../src/runtime/runtime-state.js';
import { ChatMessage } from '../src/domain/chat.js';
import { SessionRecord } from '../src/domain/session.js';
import { OpenCodeApiClient, OpenCodeEvent } from '../src/services/opencode-api-client.js';
import { OpenCodeChatService } from '../src/services/opencode-chat-service.js';

type EventServiceLike = {
  emit: (input: {
    eventType: string;
    payload: unknown;
    source: string;
    sessionId?: string | null;
  }) => EventEnvelope;
};

type OpenCodeSessionServiceLike = {
  getMessages: (sessionId: string, limit?: number) => Promise<ChatMessage[]>;
  getMessagesFromSqlite: (sessionId: string, limit?: number) => ChatMessage[];
  invalidateCache: () => void;
  getSession: (sessionId: string) => Promise<unknown>;
  ensureServer: () => Promise<{ baseUrl: string | null; error: string | null }>;
};

type LoggerLike = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  debug?: (obj: unknown, msg?: string) => void;
};

function makeMockApiClient(overrides: Partial<OpenCodeApiClient> = {}): OpenCodeApiClient & { __listeners: Array<(event: OpenCodeEvent) => void> } {
  const listeners: Array<(event: OpenCodeEvent) => void> = [];
  const eventQueue: OpenCodeEvent[] = [];
  let signalRef: AbortSignal | null = null;
  return {
    setBaseUrl: vi.fn(),
    get baseUrl() {
      return 'http://127.0.0.1:4243';
    },
    addEventListener: vi.fn((listener: (event: OpenCodeEvent) => void) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    }),
    health: vi.fn(async () => ({ healthy: true, version: '1.0.0' })),
    getConfig: vi.fn(async () => ({})),
    listSessions: vi.fn(async () => []),
    getSession: vi.fn(async () => null),
    createSession: vi.fn(async () => ({} as never)),
    updateSession: vi.fn(async () => ({} as never)),
    deleteSession: vi.fn(async () => true),
    abortSession: vi.fn(async () => true),
    listMessages: vi.fn(async () => []),
    getMessage: vi.fn(async () => null),
    sendMessageSync: vi.fn(async () => ({} as never)),
    sendMessageAsync: vi.fn(async () => undefined),
    listAgents: vi.fn(async () => []),
    listSkills: vi.fn(async () => []),
    listTools: vi.fn(async () => []),
    listCommands: vi.fn(async () => []),
    listProviders: vi.fn(async () => []),
    listModels: vi.fn(async () => []),
    listPermissions: vi.fn(async () => []),
    replyPermission: vi.fn(async () => ({ ok: true })),
    listQuestions: vi.fn(async () => []),
    replyQuestion: vi.fn(async () => ({ ok: true })),
    rejectQuestion: vi.fn(async () => ({ ok: true })),
    listTodos: vi.fn(async () => []),
    getSessionDiff: vi.fn(async () => ({ files: [], summary: { additions: 0, deletions: 0, files: 0 } })),
    runShell: vi.fn(async () => ({ callID: 'shell-1', output: '', exitCode: 0, durationMs: 0 })),
    sendCommand: vi.fn(async () => ({ callID: 'cmd-1', output: '' })),
    summarize: vi.fn(async () => ({ ok: true })),
    initSession: vi.fn(async () => ({ ok: true })),
    forkSession: vi.fn(async () => ({} as never)),
    shareSession: vi.fn(async () => ({})),
    unshareSession: vi.fn(async () => ({ ok: true })),
    compactSession: vi.fn(async () => ({ ok: true })),
    readFile: vi.fn(async () => ''),
    listDirectory: vi.fn(async () => []),
    findFiles: vi.fn(async () => []),
    findText: vi.fn(async () => []),
    subscribeEvents: vi.fn(async function* (signal?: AbortSignal) {
      signalRef = signal ?? null;
      for (const event of eventQueue) {
        if (signalRef?.aborted) return;
        yield event;
      }
      while (!signalRef?.aborted) {
        await new Promise((r) => setTimeout(r, 5));
        if (eventQueue.length > 0) {
          const next = eventQueue.shift();
          if (next) yield next;
        }
      }
    }),
    __listeners: listeners,
    __pushEvent: (event: OpenCodeEvent) => eventQueue.push(event),
    __abort: () => signalRef?.abort(),
    ...overrides
  } as unknown as OpenCodeApiClient & { __listeners: Array<(event: OpenCodeEvent) => void>; __pushEvent: (e: OpenCodeEvent) => void; __abort: () => void };
}

describe('OpenCodeChatService', () => {
  const emitted: EventEnvelope[] = [];
  let mockEventService: EventServiceLike;
  let mockSessionService: OpenCodeSessionServiceLike;
  let mockApiClient: OpenCodeApiClient;
  let logger: LoggerLike;
  let service: OpenCodeChatService;

  const sampleSession: SessionRecord = {
    id: 'test-session-id',
    status: 'idle',
    profile: 'default',
    workspacePath: '/tmp/test-workspace',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    source: 'opencode'
  };

  beforeEach(() => {
    emitted.length = 0;
    mockEventService = {
      emit: vi.fn(
        (input: {
          eventType: string;
          payload: unknown;
          source: string;
          sessionId?: string | null;
        }): EventEnvelope => {
          const envelope: EventEnvelope = {
            sequence: emitted.length + 1,
            timestamp: new Date().toISOString(),
            eventType: input.eventType,
            sessionId: input.sessionId ?? null,
            streamId: null,
            source: input.source as EventEnvelope['source'],
            payload: input.payload
          };
          emitted.push(envelope);
          return envelope;
        }
      )
    };

    mockSessionService = {
      getMessages: vi.fn(async () => []),
      getMessagesFromSqlite: vi.fn(),
      invalidateCache: vi.fn(),
      getSession: vi.fn(async () => null),
      ensureServer: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:4243', error: null }))
    };

    mockApiClient = makeMockApiClient();

    logger = {
      info: () => undefined,
      warn: () => undefined,
      debug: () => undefined
    };

    service = new OpenCodeChatService(
      mockEventService as unknown as ConstructorParameters<typeof OpenCodeChatService>[0],
      mockSessionService as unknown as ConstructorParameters<typeof OpenCodeChatService>[1],
      mockApiClient,
      {
        runtimePath: 'opencode',
        permissionMode: 'bypass',
        defaultAgent: 'build',
        defaultModel: '',
        eventStreamEnabled: false,
        streamReconnectMs: 1000,
        streamIdleTimeoutMs: 0
      },
      logger
    );
  });

  afterEach(() => {
    emitted.length = 0;
    vi.resetAllMocks();
  });

  describe('getMessages', () => {
    it('delegates to session service sqlite fallback', async () => {
      const expected: ChatMessage[] = [
        {
          id: 'msg-1',
          turnId: 'turn-1',
          role: 'user',
          content: 'hello',
          createdAt: '2026-01-01T00:00:00.000Z',
          sequence: 1,
          status: 'sent'
        }
      ];
      vi.mocked(mockSessionService.getMessagesFromSqlite).mockReturnValue(expected);
      vi.mocked(mockSessionService.getMessages as never).mockResolvedValue(expected as never);

      const result = await service.getMessages('test-session-id', 100);

      expect(result).toEqual(expected);
    });

    it('falls back to sqlite when API returns no messages', async () => {
      const expected: ChatMessage[] = [
        {
          id: 'msg-1',
          turnId: 'turn-1',
          role: 'user',
          content: 'hi',
          createdAt: '2026-01-01T00:00:00.000Z',
          sequence: 1,
          status: 'sent'
        }
      ];
      vi.mocked(mockSessionService.getMessages as never).mockResolvedValue([] as never);
      vi.mocked(mockSessionService.getMessagesFromSqlite).mockReturnValue(expected);

      const result = await service.getMessages('test-session-id', 100);
      expect(result).toBe(expected);
    });
  });

  describe('applyRuntimeStatus', () => {
    it('returns session unchanged when idle', () => {
      const result = service.applyRuntimeStatus(sampleSession);

      expect(result).toBe(sampleSession);
      expect(result.status).toBe('idle');
      expect(result.updatedAt).toBe(sampleSession.updatedAt);
    });

    it('returns running status after sendMessage', () => {
      service.sendMessage({
        session: sampleSession,
        message: 'hello world',
        actorDeviceId: 'device-1'
      });

      const result = service.applyRuntimeStatus(sampleSession);

      expect(result).not.toBe(sampleSession);
      expect(result.status).toBe('running');
    });
  });

  describe('cancelSession', () => {
    it('returns false when no active turns', () => {
      const result = service.cancelSession('non-existent-session');

      expect(result).toBe(false);
    });
  });

  describe('sendMessage', () => {
    it('returns turn metadata', () => {
      const result = service.sendMessage({
        session: sampleSession,
        message: 'test message',
        actorDeviceId: 'device-1'
      });

      expect(result).toHaveProperty('turnId');
      expect(typeof result.turnId).toBe('string');
      expect(result.turnId.length).toBeGreaterThan(0);
      expect(result).toHaveProperty('userEvent');
      expect(result.userEvent.eventType).toBe('chat.message.user');
      expect(result.userEvent.sessionId).toBe('test-session-id');
      expect(result.userEvent.source).toBe('session');
      expect(result.queued).toBe(false);
    });

    it('emits chat.message.user event', () => {
      service.sendMessage({
        session: sampleSession,
        message: 'test message',
        actorDeviceId: 'device-1'
      });

      const userEvents = emitted.filter((e) => e.eventType === 'chat.message.user');
      expect(userEvents).toHaveLength(1);
      expect(userEvents[0]?.source).toBe('session');
      expect(userEvents[0]?.sessionId).toBe('test-session-id');
      expect(userEvents[0]?.payload).toMatchObject({
        role: 'user',
        content: 'test message',
        actorDeviceId: 'device-1'
      });
    });

    it('throws when session is not opencode', () => {
      expect(() =>
        service.sendMessage({
          session: { ...sampleSession, source: 'codex' },
          message: 'hi',
          actorDeviceId: 'd1'
        })
      ).toThrow();
    });

    it('rejects empty message', () => {
      expect(() =>
        service.sendMessage({
          session: sampleSession,
          message: '   ',
          actorDeviceId: 'd1'
        })
      ).toThrow('empty_message');
    });
  });

  describe('pending tracking', () => {
    it('starts with no pending tools, permissions, or questions', () => {
      expect(service.pendingTools).toEqual([]);
      expect(service.pendingPermissions).toEqual([]);
      expect(service.pendingQuestions).toEqual([]);
    });
  });
});

describe('OpenCodeChatService - SSE event handling', () => {
  let service: OpenCodeChatService;
  let emitted: EventEnvelope[];
  let mockApiClient: OpenCodeApiClient;

  beforeEach(() => {
    emitted = [];
    const eventService = {
      emit: (input: { eventType: string; payload: unknown; source: string; sessionId?: string | null }): EventEnvelope => {
        const envelope: EventEnvelope = {
          sequence: emitted.length + 1,
          timestamp: new Date().toISOString(),
          eventType: input.eventType,
          sessionId: input.sessionId ?? null,
          streamId: null,
          source: input.source as EventEnvelope['source'],
          payload: input.payload
        };
        emitted.push(envelope);
        return envelope;
      }
    };

    mockApiClient = makeMockApiClient();

    service = new OpenCodeChatService(
      eventService as never,
      {
        getMessages: vi.fn(async () => []),
        getMessagesFromSqlite: vi.fn(() => []),
        invalidateCache: vi.fn(),
        getSession: vi.fn(async () => ({ id: 'ses-1', agent: 'build' })),
        ensureServer: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:4243', error: null }))
      } as never,
      mockApiClient,
      {
        runtimePath: 'opencode',
        permissionMode: 'bypass',
        defaultAgent: 'build',
        defaultModel: '',
        eventStreamEnabled: true,
        streamReconnectMs: 50,
        streamIdleTimeoutMs: 0
      },
      { info: () => undefined, warn: () => undefined, debug: () => undefined }
    );

    // Start the event stream so listeners get registered. The mock
    // subscribeEvents generator never yields so the loop blocks on the
    // first iteration, which is fine for the test.
    void service.startEventStream();
  });

  function emitEvents(events: OpenCodeEvent[]): Promise<void> {
    const apiClient = mockApiClient as unknown as { __pushEvent: (e: OpenCodeEvent) => void };
    for (const event of events) {
      apiClient.__pushEvent(event);
    }
    return new Promise((resolve) => setTimeout(resolve, 30 + events.length * 20));
  }

  it('emits text delta events during assistant turn', async () => {
    service.sendMessage({
      session: { id: 'ses-1', status: 'idle', profile: 'opencode', workspacePath: '/tmp', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', source: 'opencode' },
      message: 'hi',
      actorDeviceId: 'd1'
    });

    const eventTypes = emitted.map((e) => e.eventType);
    expect(eventTypes).toContain('chat.message.user');
    expect(eventTypes).toContain('chat.turn.started');

    await emitEvents([
      { type: 'session.next.text.started', payload: { sessionID: 'ses-1', messageID: 'msg-1' } },
      { type: 'session.next.text.delta', payload: { sessionID: 'ses-1', messageID: 'msg-1', text: 'Hello' } },
      { type: 'session.next.text.delta', payload: { sessionID: 'ses-1', messageID: 'msg-1', text: ' world' } },
      { type: 'session.next.text.ended', payload: { sessionID: 'ses-1', messageID: 'msg-1', text: 'Hello world' } }
    ]);

    const deltaEvents = emitted.filter((e) => e.eventType === 'chat.output.delta');
    expect(deltaEvents).toHaveLength(2);
    const assistantMessage = emitted.find((e) => e.eventType === 'chat.message.assistant');
    expect(assistantMessage?.payload).toMatchObject({ content: 'Hello world' });
  });

  it('tracks tool calls and emits opencode.turn.tool.called events', async () => {
    service.sendMessage({
      session: { id: 'ses-1', status: 'idle', profile: 'opencode', workspacePath: '/tmp', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', source: 'opencode' },
      message: 'hi',
      actorDeviceId: 'd1'
    });
    await new Promise((r) => setTimeout(r, 30));

    await emitEvents([
      { type: 'session.next.tool.called', payload: { sessionID: 'ses-1', messageID: 'msg-1', callID: 'call-1', tool: 'bash', input: { cmd: 'ls' } } },
      { type: 'session.next.tool.success', payload: { sessionID: 'ses-1', messageID: 'msg-1', callID: 'call-1', output: 'file.txt', title: 'Ran bash' } }
    ]);
    expect(service.pendingTools).toEqual([]);
    const toolEvents = emitted.filter((e) => e.eventType === 'opencode.turn.tool.called');
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]?.payload).toMatchObject({ tool: 'bash', callID: 'call-1' });
    const completedEvents = emitted.filter((e) => e.eventType === 'opencode.turn.tool.completed');
    expect(completedEvents).toHaveLength(1);
  });

  it('tracks permission and question requests', async () => {
    await emitEvents([
      {
        type: 'permission.asked',
        payload: { sessionID: 'ses-1', request: { id: 'perm-1', permission: 'bash', patterns: ['rm -rf /'] } }
      }
    ]);
    expect(service.pendingPermissions).toHaveLength(1);
    expect(service.pendingPermissions[0]?.requestID).toBe('perm-1');

    await emitEvents([
      {
        type: 'question.asked',
        payload: {
          sessionID: 'ses-1',
          request: {
            id: 'q-1',
            questions: [{ question: 'continue?', options: [{ label: 'Yes' }] }]
          }
        }
      }
    ]);
    expect(service.pendingQuestions).toHaveLength(1);
    expect(service.pendingQuestions[0]?.requestID).toBe('q-1');
  });

  it('clears pending permissions/questions when replied', async () => {
    await emitEvents([
      { type: 'permission.asked', payload: { sessionID: 'ses-1', request: { id: 'perm-1', permission: 'bash' } } }
    ]);
    expect(service.pendingPermissions).toHaveLength(1);
    await emitEvents([
      { type: 'permission.replied', payload: { sessionID: 'ses-1', requestID: 'perm-1', decision: 'allow' } }
    ]);
    expect(service.pendingPermissions).toEqual([]);

    await emitEvents([
      { type: 'question.asked', payload: { sessionID: 'ses-1', request: { id: 'q-1', questions: [{ question: 'continue?' }] } } }
    ]);
    expect(service.pendingQuestions).toHaveLength(1);
    await emitEvents([
      { type: 'question.replied', payload: { sessionID: 'ses-1', requestID: 'q-1', answers: ['yes'] } }
    ]);
    expect(service.pendingQuestions).toEqual([]);
  });

  it('emits skill use events', async () => {
    service.sendMessage({
      session: { id: 'ses-1', status: 'idle', profile: 'opencode', workspacePath: '/tmp', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', source: 'opencode' },
      message: 'hi',
      actorDeviceId: 'd1'
    });
    await new Promise((r) => setTimeout(r, 30));

    await emitEvents([
      { type: 'session.next.skill.used', payload: { sessionID: 'ses-1', messageID: 'msg-1', skill: 'plan' } }
    ]);
    const skillEvents = emitted.filter((e) => e.eventType === 'opencode.turn.skill.used');
    expect(skillEvents).toHaveLength(1);
    expect(skillEvents[0]?.payload).toMatchObject({ skill: 'plan' });
  });

  it('emits shell lifecycle events', async () => {
    await emitEvents([
      { type: 'session.next.shell.started', payload: { sessionID: 'ses-1', callID: 'shell-1', command: 'npm test' } },
      { type: 'session.next.shell.ended', payload: { sessionID: 'ses-1', callID: 'shell-1', output: 'all pass', exitCode: 0, durationMs: 1200 } }
    ]);
    expect(emitted.some((e) => e.eventType === 'opencode.turn.shell.started')).toBe(true);
    expect(emitted.some((e) => e.eventType === 'opencode.turn.shell.ended')).toBe(true);
  });

  it('emits session.error events for upstream failures', async () => {
    await emitEvents([
      { type: 'session.error', payload: { sessionID: 'ses-1', error: { name: 'ProviderAuthError', data: { message: 'token expired' } } } }
    ]);
    const errorEvents = emitted.filter((e) => e.eventType === 'opencode.session.error');
    expect(errorEvents).toHaveLength(1);
  });

  it('emits lifecycle events on session.created and session.updated', async () => {
    await emitEvents([
      { type: 'session.created', payload: { session: { id: 'ses-new' } as never } },
      { type: 'session.updated', payload: { session: { id: 'ses-new', title: 'renamed' } as never } }
    ]);
    const lifecycle = emitted.filter((e) => e.eventType === 'opencode.session.lifecycle');
    expect(lifecycle).toHaveLength(2);
  });
});
