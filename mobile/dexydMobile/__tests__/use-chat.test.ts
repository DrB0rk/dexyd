import {
  mergeFetchedChatMessages,
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
});

describe('visibleChatMessages', () => {
  it('keeps running tool state out of the visible message list', () => {
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
        id: 'assistant-1',
        role: 'assistant',
        content: 'done',
        sequence: 3,
      }),
    ]);

    expect(visible.map(item => item.id)).toEqual(['assistant-1', 'user-1']);
  });
});
