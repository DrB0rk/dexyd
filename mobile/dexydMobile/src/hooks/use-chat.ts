import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import {
  getChatMessages,
  getQueuedMessages,
  removeQueuedMessage,
  sendChatMessage,
  steerQueuedMessage,
  type AuthTokens,
} from '../api/dexyd-client';
import { ChatMessage, EventEnvelope, QueuedChatMessage } from '../types/dexyd';
import { errorMessage } from '../utils/error-message';

const CHAT_POLL_INTERVAL_MS = 3500;

function eventToMessage(event: EventEnvelope): ChatMessage | null {
  if (!event.eventType.startsWith('chat.')) return null;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const turnId =
    typeof payload.turnId === 'string'
      ? payload.turnId
      : `sequence-${event.sequence}`;

  if (
    event.eventType === 'chat.message.queued' ||
    event.eventType === 'chat.message.queued.updated'
  ) {
    return {
      id: typeof payload.id === 'string' ? payload.id : `${event.sequence}`,
      turnId,
      role: 'user',
      content: typeof payload.content === 'string' ? payload.content : '',
      createdAt: event.timestamp,
      sequence: event.sequence,
      status: 'queued',
      ...(typeof payload.queueId === 'string'
        ? { queueId: payload.queueId }
        : {}),
    };
  }

  if (
    event.eventType === 'chat.message.user' ||
    event.eventType === 'chat.message.assistant'
  ) {
    return {
      id: typeof payload.id === 'string' ? payload.id : `${event.sequence}`,
      turnId,
      role: event.eventType === 'chat.message.assistant' ? 'assistant' : 'user',
      content: typeof payload.content === 'string' ? payload.content : '',
      createdAt: event.timestamp,
      sequence: event.sequence,
      status: 'sent',
      ...(typeof payload.queueId === 'string'
        ? { queueId: payload.queueId }
        : {}),
    };
  }

  if (event.eventType === 'chat.turn.started') {
    return {
      id: `running-${turnId}`,
      turnId,
      role: 'tool',
      content: 'Codex is working…',
      createdAt: event.timestamp,
      sequence: event.sequence,
      status: 'running',
    };
  }

  if (event.eventType === 'chat.turn.completed') {
    return null;
  }

  if (
    event.eventType === 'chat.turn.failed' ||
    event.eventType === 'chat.turn.cancelled'
  ) {
    const cancelled = event.eventType === 'chat.turn.cancelled';
    return {
      id: `${cancelled ? 'cancelled' : 'failed'}-${event.sequence}`,
      turnId,
      role: 'system',
      content:
        typeof payload.message === 'string'
          ? payload.message
          : cancelled
          ? 'Codex turn cancelled.'
          : 'Chat turn failed.',
      createdAt: event.timestamp,
      sequence: event.sequence,
      status: cancelled ? 'cancelled' : 'failed',
    };
  }

  return null;
}

function eventToQueuedMessage(event: EventEnvelope): QueuedChatMessage | null {
  if (
    event.eventType !== 'chat.message.queued' &&
    event.eventType !== 'chat.message.queued.updated'
  )
    return null;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const queueId =
    typeof payload.queueId === 'string'
      ? payload.queueId
      : typeof payload.id === 'string'
      ? payload.id
      : '';
  const turnId = typeof payload.turnId === 'string' ? payload.turnId : '';
  const sessionId = typeof event.sessionId === 'string' ? event.sessionId : '';
  const content = typeof payload.content === 'string' ? payload.content : '';
  if (!queueId || !turnId || !sessionId) return null;
  return {
    queueId,
    turnId,
    sessionId,
    content,
    actorDeviceId:
      typeof payload.actorDeviceId === 'string' ? payload.actorDeviceId : '',
    createdAt: event.timestamp,
    updatedAt: event.timestamp,
  };
}

function mergeMessage(
  existing: ChatMessage[],
  next: ChatMessage,
): ChatMessage[] {
  const withoutRunning =
    next.role === 'assistant' ||
    next.status === 'failed' ||
    next.status === 'cancelled'
      ? existing.filter(
          item => !(item.turnId === next.turnId && item.status === 'running'),
        )
      : existing;
  const withoutQueued =
    next.status === 'sent' && next.queueId
      ? withoutRunning.filter(
          item => item.queueId !== next.queueId || item.status !== 'queued',
        )
      : withoutRunning;
  const found = withoutQueued.some(
    item =>
      item.id === next.id ||
      item.sequence === next.sequence ||
      (next.queueId &&
        item.queueId === next.queueId &&
        item.status === next.status),
  );
  if (found) {
    return dedupeMessages(
      withoutQueued.map(item =>
        item.id === next.id ||
        item.sequence === next.sequence ||
        (next.queueId &&
          item.queueId === next.queueId &&
          item.status === next.status)
          ? next
          : item,
      ),
    );
  }
  return dedupeMessages(
    [...withoutQueued, next].sort((a, b) => a.sequence - b.sequence),
  );
}

function mergeDelta(
  existing: ChatMessage[],
  event: EventEnvelope,
): ChatMessage[] {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const turnId =
    typeof payload.turnId === 'string'
      ? payload.turnId
      : `sequence-${event.sequence}`;
  const text = typeof payload.text === 'string' ? payload.text : '';
  if (!text) return existing;

  const draftId = `tool-progress-${turnId}`;
  const content = summarizeProgress(text);
  const found = existing.find(item => item.id === draftId);
  if (found) {
    return existing.map(item =>
      item.id === draftId
        ? {
            ...item,
            content,
            sequence: event.sequence,
            createdAt: event.timestamp,
          }
        : item,
    );
  }

  const draft: ChatMessage = {
    id: draftId,
    turnId,
    role: 'tool',
    content,
    createdAt: event.timestamp,
    sequence: event.sequence,
    status: 'running',
  };

  return [
    ...existing.filter(
      item => !(item.turnId === turnId && item.status === 'running'),
    ),
    draft,
  ].sort((a, b) => a.sequence - b.sequence);
}

function summarizeProgress(text: string): string {
  const normalized = text.toLowerCase();
  if (normalized.includes('apply_patch') || normalized.includes('patch'))
    return 'Editing files…';
  if (
    normalized.includes('npm test') ||
    normalized.includes('jest') ||
    normalized.includes('vitest')
  )
    return 'Running tests…';
  if (normalized.includes('tsc') || normalized.includes('typecheck'))
    return 'Checking types…';
  if (normalized.includes('eslint') || normalized.includes('lint'))
    return 'Checking code style…';
  if (normalized.includes('gradle') || normalized.includes('android'))
    return 'Building Android app…';
  if (
    normalized.includes('exec_command') ||
    normalized.includes('shell') ||
    normalized.includes('bash')
  )
    return 'Running command…';
  if (normalized.includes('update_plan')) return 'Updating plan…';
  if (
    normalized.includes('search') ||
    normalized.includes('rg ') ||
    normalized.includes('find')
  )
    return 'Checking context…';
  if (normalized.includes('error') || normalized.includes('failed'))
    return 'Reviewing an error…';
  return 'Codex is working…';
}

function chatMessageTime(message: ChatMessage): number {
  const time = new Date(message.createdAt).getTime();
  return Number.isFinite(time) ? time : 0;
}

function compareChatMessages(left: ChatMessage, right: ChatMessage): number {
  const timeDiff = chatMessageTime(left) - chatMessageTime(right);
  if (timeDiff !== 0) return timeDiff;
  return left.sequence - right.sequence;
}

function sameUserContent(left: ChatMessage, right: ChatMessage): boolean {
  return (
    left.role === 'user' &&
    right.role === 'user' &&
    left.content.trim() === right.content.trim()
  );
}

function pendingUserConfirmed(
  pending: ChatMessage,
  fetchedUsers: ChatMessage[],
): boolean {
  return fetchedUsers.some(fetched => {
    if (!sameUserContent(pending, fetched)) return false;
    if (pending.turnId === fetched.turnId) return true;
    return Math.abs(chatMessageTime(pending) - chatMessageTime(fetched)) <= 10 * 60 * 1000;
  });
}

function dedupeMessages(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  const terminalTurns = new Set(
    messages
      .filter(
        message =>
          message.role === 'assistant' ||
          message.status === 'failed' ||
          message.status === 'cancelled',
      )
      .map(message => message.turnId),
  );
  const sentQueued = new Set(
    messages
      .filter(message => message.role === 'user' && message.status === 'sent')
      .map(message => message.queueId ?? message.turnId),
  );

  for (const message of messages) {
    if (
      message.role === 'tool' &&
      message.status === 'running' &&
      terminalTurns.has(message.turnId)
    ) {
      continue;
    }

    if (
      message.status === 'queued' &&
      sentQueued.has(message.queueId ?? message.turnId)
    ) {
      continue;
    }

    const duplicate = result.find(existing => {
      if (
        existing.role !== message.role ||
        existing.status !== message.status ||
        existing.content.trim() !== message.content.trim()
      ) {
        return false;
      }
      if (existing.turnId === message.turnId) return true;
      return (
        existing.role === 'user' &&
        message.role === 'user' &&
        Math.abs(chatMessageTime(existing) - chatMessageTime(message)) <=
          10 * 60 * 1000
      );
    });
    if (duplicate) continue;

    const previous = result.at(-1);
    const sameAdjacentMessage =
      previous &&
      previous.role === message.role &&
      previous.content === message.content &&
      Math.abs(
        new Date(previous.createdAt).getTime() -
          new Date(message.createdAt).getTime(),
      ) <= 1000;

    if (sameAdjacentMessage) {
      continue;
    }

    if (
      message.role === 'tool' &&
      message.status === 'sent' &&
      previous?.role === 'tool' &&
      previous.status === 'sent'
    ) {
      result.pop();
    }

    result.push(message);
  }

  return result;
}

export function mergeFetchedChatMessages(
  items: ChatMessage[],
  pendingUserMessages: ChatMessage[],
  activeQueueIds?: Set<string>,
): ChatMessage[] {
  const merged = dedupeMessages(
    [...items, ...pendingUserMessages].sort(compareChatMessages),
  );
  if (!activeQueueIds) return merged;
  return merged.filter(
    message =>
      message.status !== 'queued' || activeQueueIds.has(message.queueId ?? ''),
  );
}

export function visibleChatMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .filter(
      message =>
        message.status !== 'queued' &&
        !(message.role === 'tool' && message.status === 'running'),
    )
    .slice()
    .reverse();
}

function mergeQueuedMessages(
  current: QueuedChatMessage[],
  next: QueuedChatMessage,
): QueuedChatMessage[] {
  const found = current.some(item => item.queueId === next.queueId);
  const items = found
    ? current.map(item => (item.queueId === next.queueId ? next : item))
    : [...current, next];
  return items.sort(
    (left, right) =>
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
  );
}

export function useChat(
  bridgeUrl: string,
  tokens: AuthTokens | null,
  sessionId: string | null,
  lastEvent: EventEnvelope | null,
) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingUserMessagesRef = useRef<ChatMessage[]>([]);

  const refreshQueue = useCallback(async () => {
    if (!tokens || !sessionId) {
      setQueuedMessages([]);
      return;
    }
    setQueuedMessages(await getQueuedMessages(bridgeUrl, sessionId, tokens));
  }, [bridgeUrl, sessionId, tokens]);

  const refresh = useCallback(
    async (silent = false) => {
      if (!tokens || !sessionId) {
        setMessages([]);
        setQueuedMessages([]);
        setError(null);
        return;
      }

      if (!silent) setLoading(true);
      setError(null);
      try {
        const items = await getChatMessages(bridgeUrl, sessionId, tokens);
        const fetchedUsers = items.filter(message => message.role === 'user');
        pendingUserMessagesRef.current = pendingUserMessagesRef.current.filter(
          message => !pendingUserConfirmed(message, fetchedUsers),
        );

        let activeQueueIds: Set<string> | undefined;
        try {
          const queue = await getQueuedMessages(bridgeUrl, sessionId, tokens);
          activeQueueIds = new Set(queue.map(item => item.queueId));
          setQueuedMessages(queue);
        } catch {
          activeQueueIds = undefined;
        }

        setMessages(
          mergeFetchedChatMessages(
            items,
            pendingUserMessagesRef.current,
            activeQueueIds,
          ),
        );
      } catch (err) {
        setError(errorMessage(err, 'failed to load chat'));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [bridgeUrl, sessionId, tokens],
  );

  const send = useCallback(
    async (message: string, sessionOverride?: string) => {
      const targetSessionId = sessionOverride ?? sessionId;
      if (!tokens || !targetSessionId || !message.trim()) return false;
      setSending(true);
      setError(null);
      try {
        const response = await sendChatMessage(
          bridgeUrl,
          targetSessionId,
          message.trim(),
          tokens,
        );
        const sent = eventToMessage(response.userEvent);
        if (sent) {
          if (sent.status === 'queued') {
            const queued = eventToQueuedMessage(response.userEvent);
            if (queued)
              setQueuedMessages(current =>
                mergeQueuedMessages(current, queued),
              );
          } else {
            pendingUserMessagesRef.current = dedupeMessages([
              ...pendingUserMessagesRef.current,
              sent,
            ]).filter(item => item.role === 'user');
          }
          setMessages(current => mergeMessage(current, sent));
        }
        return true;
      } catch (err) {
        setError(errorMessage(err, 'failed to send message'));
        return false;
      } finally {
        setSending(false);
      }
    },
    [bridgeUrl, sessionId, tokens],
  );

  const steerQueued = useCallback(
    async (queueId: string, steering: string) => {
      if (!tokens || !sessionId || !steering.trim()) return false;
      setSending(true);
      setError(null);
      try {
        const queued = await steerQueuedMessage(
          bridgeUrl,
          sessionId,
          queueId,
          steering.trim(),
          tokens,
        );
        setQueuedMessages(current => mergeQueuedMessages(current, queued));
        setMessages(current =>
          current.map(message =>
            message.queueId === queueId && message.status === 'queued'
              ? { ...message, content: queued.content }
              : message,
          ),
        );
        return true;
      } catch (err) {
        setError(errorMessage(err, 'failed to steer queued message'));
        return false;
      } finally {
        setSending(false);
      }
    },
    [bridgeUrl, sessionId, tokens],
  );

  const removeQueued = useCallback(
    async (queueId: string) => {
      if (!tokens || !sessionId) return false;
      setError(null);
      try {
        const result = await removeQueuedMessage(
          bridgeUrl,
          sessionId,
          queueId,
          tokens,
        );
        if (result.removed) {
          setQueuedMessages(current =>
            current.filter(item => item.queueId !== queueId),
          );
          setMessages(current =>
            current.filter(message => message.queueId !== queueId),
          );
        }
        return result.removed;
      } catch (err) {
        setError(errorMessage(err, 'failed to remove queued message'));
        return false;
      }
    },
    [bridgeUrl, sessionId, tokens],
  );

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  useEffect(() => {
    pendingUserMessagesRef.current = [];
    setMessages([]);
    setQueuedMessages([]);
    setError(null);
  }, [sessionId]);

  useEffect(() => {
    if (!tokens || !sessionId) return undefined;
    const timer = setInterval(() => {
      refresh(true).catch(() => undefined);
    }, CHAT_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh, sessionId, tokens]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') {
        refresh(true).catch(() => undefined);
      }
    });
    return () => subscription.remove();
  }, [refresh]);

  useEffect(() => {
    if (!lastEvent || !sessionId || lastEvent.sessionId !== sessionId) return;
    if (lastEvent.eventType === 'chat.output.delta') {
      setMessages(current => mergeDelta(current, lastEvent));
      return;
    }
    if (lastEvent.eventType === 'chat.message.queued.removed') {
      const payload = (lastEvent.payload ?? {}) as Record<string, unknown>;
      const queueId =
        typeof payload.queueId === 'string' ? payload.queueId : '';
      if (queueId) {
        setQueuedMessages(current =>
          current.filter(item => item.queueId !== queueId),
        );
        setMessages(current =>
          current.filter(
            message =>
              message.queueId !== queueId || message.status !== 'queued',
          ),
        );
      }
      refreshQueue().catch(() => undefined);
      return;
    }
    const queued = eventToQueuedMessage(lastEvent);
    if (queued) {
      setQueuedMessages(current => mergeQueuedMessages(current, queued));
    }
    const message = eventToMessage(lastEvent);
    if (!message) return;
    if (message.role === 'user' && message.status === 'sent') {
      pendingUserMessagesRef.current = pendingUserMessagesRef.current.filter(
        pending => pending.turnId !== message.turnId,
      );
      if (message.queueId) {
        setQueuedMessages(current =>
          current.filter(item => item.queueId !== message.queueId),
        );
      }
    }
    setMessages(current => mergeMessage(current, message));
  }, [lastEvent, refreshQueue, sessionId]);

  return useMemo(
    () => ({
      messages,
      queuedMessages,
      loading,
      sending,
      error,
      refresh,
      send,
      steerQueued,
      removeQueued,
      setError,
    }),
    [
      error,
      loading,
      messages,
      queuedMessages,
      refresh,
      removeQueued,
      send,
      sending,
      steerQueued,
    ],
  );
}
