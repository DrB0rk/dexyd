import { mergeFetchedChatMessages } from '../src/hooks/use-chat';
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
    const merged = mergeFetchedChatMessages([
      message({ id: 'user-1', role: 'user', content: 'question', sequence: 1 }),
      message({ id: 'assistant-1', role: 'assistant', content: 'answer', sequence: 2 }),
    ], []);

    expect(merged.map(item => item.content)).toEqual(['question', 'answer']);
  });

  it('filters only stale queued placeholders when queue state is available', () => {
    const merged = mergeFetchedChatMessages([
      message({ id: 'queued-1', status: 'queued', queueId: 'gone', content: 'old queued', sequence: 1 }),
      message({ id: 'assistant-1', role: 'assistant', content: 'answer', sequence: 2 }),
    ], [], new Set());

    expect(merged.map(item => item.content)).toEqual(['answer']);
  });
});
