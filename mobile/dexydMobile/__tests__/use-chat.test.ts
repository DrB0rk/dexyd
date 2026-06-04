import {
  chatMessageKey,
  mergeFetchedChatMessages,
  normalizeDisplayUserContent,
  visibleChatMessages,
} from '../src/hooks/use-chat';
import { ChatMessage } from '../src/types/dexyd';

const message = (overrides: Partial<ChatMessage>): ChatMessage => ({
  id: overrides.id ?? 'message-1',
  turnId: overrides.turnId ?? 'turn-1',
  role: overrides.role ?? 'assistant',
  content: overrides.content ?? 'hello',
  createdAt: overrides.createdAt ?? '2026-06-04T08:00:00.000Z',
  sequence: overrides.sequence ?? 1,
  status: overrides.status ?? 'sent',
  ...(overrides.queueId ? { queueId: overrides.queueId } : {}),
});

describe('mergeFetchedChatMessages', () => {
  it('keeps fetched chat messages when queue state is unavailable', () => {
    const merged = mergeFetchedChatMessages(
      [
        message({
          id: 'user-1',
          role: 'user',
          content: 'question',
          sequence: 1,
        }),
        message({
          id: 'assistant-1',
          role: 'assistant',
          content: 'answer',
          sequence: 2,
        }),
      ],
      [],
    );

    expect(merged.map(item => item.content)).toEqual(['question', 'answer']);
  });

  it('filters only stale queued placeholders when queue state is available', () => {
    const merged = mergeFetchedChatMessages(
      [
        message({
          id: 'queued-1',
          status: 'queued',
          queueId: 'gone',
          content: 'old queued',
          sequence: 1,
        }),
        message({
          id: 'assistant-1',
          role: 'assistant',
          content: 'answer',
          sequence: 2,
        }),
      ],
      [],
      new Set(),
    );

    expect(merged.map(item => item.content)).toEqual(['answer']);
  });


  it('preserves existing row identity when fetched transcript sequence changes', () => {
    const existing = message({
      id: 'existing-user-row',
      role: 'user',
      turnId: 'turn-stable',
      content: 'keep this stable',
      createdAt: '2026-06-04T08:00:00.000Z',
      sequence: 5,
    });
    const fetched = message({
      id: 'transcript-user-row-renumbered',
      role: 'user',
      turnId: 'turn-stable',
      content: 'keep this stable',
      createdAt: '2026-06-04T08:00:03.000Z',
      sequence: 99,
    });

    const merged = mergeFetchedChatMessages([fetched], [], undefined, [existing]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe('existing-user-row');
    expect(merged[0]?.sequence).toBe(5);
    expect(chatMessageKey(merged[0]!)).toBe(chatMessageKey(existing));
  });

  it('keeps recent realtime assistant messages while transcript refresh lags', () => {
    const user = message({
      id: 'user-1',
      role: 'user',
      turnId: 'turn-realtime',
      content: 'start work',
      createdAt: new Date(Date.now() - 10_000).toISOString(),
      sequence: 1,
    });
    const realtimeAssistant = message({
      id: 'assistant-realtime',
      role: 'assistant',
      turnId: 'turn-realtime',
      content: 'I am working on it.',
      createdAt: new Date(Date.now() - 5_000).toISOString(),
      sequence: 20,
    });

    const merged = mergeFetchedChatMessages([user], [], undefined, [
      user,
      realtimeAssistant,
    ]);

    expect(merged.map(item => `${item.role}:${item.content}`)).toEqual([
      'user:start work',
      'assistant:I am working on it.',
    ]);
  });

  it('removes pending user echoes confirmed by transcript content with a different turn id', () => {
    const merged = mergeFetchedChatMessages(
      [
        message({
          id: 'codex-user-1',
          role: 'user',
          turnId: 'codex-turn',
          content: 'fix the queue panel',
          createdAt: '2026-06-04T08:00:00.000Z',
          sequence: 1,
        }),
        message({
          id: 'assistant-1',
          role: 'assistant',
          turnId: 'codex-turn',
          content: 'Fixed.',
          createdAt: '2026-06-04T08:00:05.000Z',
          sequence: 2,
        }),
      ],
      [
        message({
          id: 'pending-user-1',
          role: 'user',
          turnId: 'local-turn',
          content: 'fix the queue panel',
          createdAt: '2026-06-04T08:00:02.000Z',
          sequence: 99,
        }),
      ],
    );

    expect(merged.map(item => `${item.role}:${item.content}`)).toEqual([
      'user:fix the queue panel',
      'assistant:Fixed.',
    ]);
  });

  it('drops environment-context-only transcript rows', () => {
    const environmentOnly = [
      '<environment_context>',
      '  <current_date>2026-06-04</current_date>',
      '  <timezone>Europe/Amsterdam</timezone>',
      '</environment_context>',
    ].join('\n');

    const merged = mergeFetchedChatMessages(
      [
        message({
          id: 'environment-row',
          role: 'user',
          content: environmentOnly,
          sequence: 1,
        }),
        message({
          id: 'real-user',
          role: 'user',
          content: 'Only this should show.',
          sequence: 2,
        }),
      ],
      [],
    );

    expect(merged.map(item => item.content)).toEqual([
      'Only this should show.',
    ]);
    expect(visibleChatMessages(merged).map(item => item.content)).toEqual([
      'Only this should show.',
    ]);
  });
});


describe('normalizeDisplayUserContent', () => {
  it('extracts the real prompt from nested Dexyd environment wrappers', () => {
    const content = [
      '<environment_context>',
      '  <current_date>2026-06-04</current_date>',
      '</environment_context>',
      '',
      'USER: You are running inside dexyd as the assistant for a mobile chat session.',
      '',
      'Conversation so far:',
      'ASSISTANT: an older answer that should not become user text',
      '',
      'Latest user message:',
      'Make chat text copyable.',
    ].join('\n');

    expect(normalizeDisplayUserContent(content)).toBe(
      'Make chat text copyable.',
    );
  });
});

describe('visibleChatMessages', () => {
  it('keeps tool progress rows out of the visible message list', () => {
    const visible = visibleChatMessages([
      message({ id: 'user-1', role: 'user', content: 'go', sequence: 1 }),
      message({
        id: 'running-1',
        role: 'tool',
        status: 'running',
        content: 'Codex is working…',
        sequence: 2,
      }),
      message({
        id: 'tool-done-1',
        role: 'tool',
        status: 'sent',
        content: 'Command finished.',
        sequence: 3,
      }),
      message({
        id: 'assistant-1',
        role: 'assistant',
        content: 'done',
        sequence: 4,
      }),
    ]);

    expect(visible.map(item => item.id)).toEqual(['assistant-1', 'user-1']);
  });
});
