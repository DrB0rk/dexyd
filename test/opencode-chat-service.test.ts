import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEnvelope } from '../src/runtime/runtime-state.js';
import { ChatMessage } from '../src/domain/chat.js';
import { SessionRecord } from '../src/domain/session.js';
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
  getMessages: (sessionId: string, limit?: number) => ChatMessage[];
};

type LoggerLike = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

describe('OpenCodeChatService', () => {
  const emitted: EventEnvelope[] = [];
  let mockEventService: EventServiceLike;
  let mockSessionService: OpenCodeSessionServiceLike;
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
      getMessages: vi.fn()
    };

    logger = {
      info: () => undefined,
      warn: () => undefined
    };

    service = new OpenCodeChatService(
      mockEventService as Parameters<typeof OpenCodeChatService.prototype.constructor>[0],
      mockSessionService as Parameters<typeof OpenCodeChatService.prototype.constructor>[1],
      { runtimePath: 'opencode', permissionMode: 'bypass' },
      logger
    );
  });

  afterEach(() => {
    emitted.length = 0;
    vi.resetAllMocks();
  });

  describe('getMessages', () => {
    it('delegates to session service', () => {
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
      vi.mocked(mockSessionService.getMessages).mockReturnValue(expected);

      const result = service.getMessages('test-session-id', 100);

      expect(mockSessionService.getMessages).toHaveBeenCalledWith('test-session-id', 100);
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
  });
});