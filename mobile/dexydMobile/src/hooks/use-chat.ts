import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getChatMessages, sendChatMessage, type AuthTokens } from '../api/dexyd-client';
import { ChatMessage, EventEnvelope } from '../types/dexyd';
import { errorMessage } from '../utils/error-message';

function eventToMessage(event: EventEnvelope): ChatMessage | null {
  if (!event.eventType.startsWith('chat.')) return null;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const turnId = typeof payload.turnId === 'string' ? payload.turnId : `sequence-${event.sequence}`;

  if (event.eventType === 'chat.message.user' || event.eventType === 'chat.message.assistant') {
    return {
      id: typeof payload.id === 'string' ? payload.id : `${event.sequence}`,
      turnId,
      role: event.eventType === 'chat.message.assistant' ? 'assistant' : 'user',
      content: typeof payload.content === 'string' ? payload.content : '',
      createdAt: event.timestamp,
      sequence: event.sequence,
      status: 'sent'
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
      status: 'running'
    };
  }

  if (event.eventType === 'chat.turn.failed' || event.eventType === 'chat.turn.cancelled') {
    const cancelled = event.eventType === 'chat.turn.cancelled';
    return {
      id: `${cancelled ? 'cancelled' : 'failed'}-${event.sequence}`,
      turnId,
      role: 'system',
      content: typeof payload.message === 'string' ? payload.message : cancelled ? 'Codex turn cancelled.' : 'Chat turn failed.',
      createdAt: event.timestamp,
      sequence: event.sequence,
      status: cancelled ? 'cancelled' : 'failed'
    };
  }

  return null;
}

function mergeMessage(existing: ChatMessage[], next: ChatMessage): ChatMessage[] {
  const withoutRunning = next.role === 'assistant' || next.status === 'failed' || next.status === 'cancelled' ? existing.filter((item) => !(item.turnId === next.turnId && item.status === 'running')) : existing;
  const found = withoutRunning.some((item) => item.id === next.id || item.sequence === next.sequence);
  if (found) {
    return dedupeMessages(withoutRunning.map((item) => (item.id === next.id || item.sequence === next.sequence ? next : item)));
  }
  return dedupeMessages([...withoutRunning, next].sort((a, b) => a.sequence - b.sequence));
}

function mergeDelta(existing: ChatMessage[], event: EventEnvelope): ChatMessage[] {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const turnId = typeof payload.turnId === 'string' ? payload.turnId : `sequence-${event.sequence}`;
  const text = typeof payload.text === 'string' ? payload.text : '';
  if (!text) return existing;

  const draftId = `tool-progress-${turnId}`;
  const content = summarizeProgress(text);
  const found = existing.find((item) => item.id === draftId);
  if (found) {
    return existing.map((item) =>
      item.id === draftId
        ? {
            ...item,
            content,
            sequence: event.sequence,
            createdAt: event.timestamp
          }
        : item
    );
  }

  const draft: ChatMessage = {
    id: draftId,
    turnId,
    role: 'tool',
    content,
    createdAt: event.timestamp,
    sequence: event.sequence,
    status: 'running'
  };

  return [
    ...existing.filter((item) => !(item.turnId === turnId && item.status === 'running')),
    draft
  ].sort((a, b) => a.sequence - b.sequence);
}

function summarizeProgress(text: string): string {
  const normalized = text.toLowerCase();
  if (normalized.includes('apply_patch') || normalized.includes('patch')) return 'Editing files…';
  if (normalized.includes('npm test') || normalized.includes('jest') || normalized.includes('vitest')) return 'Running tests…';
  if (normalized.includes('tsc') || normalized.includes('typecheck')) return 'Checking types…';
  if (normalized.includes('eslint') || normalized.includes('lint')) return 'Checking code style…';
  if (normalized.includes('gradle') || normalized.includes('android')) return 'Building Android app…';
  if (normalized.includes('exec_command') || normalized.includes('shell') || normalized.includes('bash')) return 'Running command…';
  if (normalized.includes('update_plan')) return 'Updating plan…';
  if (normalized.includes('search') || normalized.includes('rg ') || normalized.includes('find')) return 'Checking context…';
  if (normalized.includes('error') || normalized.includes('failed')) return 'Reviewing an error…';
  return 'Codex is working…';
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

  for (const message of messages) {
    if (
      message.role === 'tool' &&
      message.status === 'running' &&
      terminalTurns.has(message.turnId)
    ) {
      continue;
    }

    const previous = result.at(-1);
    const sameAdjacentMessage =
      previous &&
      previous.role === message.role &&
      previous.content === message.content &&
      Math.abs(new Date(previous.createdAt).getTime() - new Date(message.createdAt).getTime()) <= 1000;

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

export function useChat(bridgeUrl: string, tokens: AuthTokens | null, sessionId: string | null, lastEvent: EventEnvelope | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingUserMessagesRef = useRef<ChatMessage[]>([]);

  const refresh = useCallback(async () => {
    if (!tokens || !sessionId) {
      setMessages([]);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const items = await getChatMessages(bridgeUrl, sessionId, tokens);
      const confirmedKeys = new Set(
        items
          .filter(message => message.role === 'user')
          .map(message => `${message.turnId}:${message.content}`),
      );
      pendingUserMessagesRef.current = pendingUserMessagesRef.current.filter(
        message => !confirmedKeys.has(`${message.turnId}:${message.content}`),
      );
      setMessages(dedupeMessages([...items, ...pendingUserMessagesRef.current]));
    } catch (err) {
      setError(errorMessage(err, 'failed to load chat'));
    } finally {
      setLoading(false);
    }
  }, [bridgeUrl, sessionId, tokens]);

  const send = useCallback(
    async (message: string, sessionOverride?: string) => {
      const targetSessionId = sessionOverride ?? sessionId;
      if (!tokens || !targetSessionId || !message.trim()) return false;
      setSending(true);
      setError(null);
      try {
        const response = await sendChatMessage(bridgeUrl, targetSessionId, message.trim(), tokens);
        const sent = eventToMessage(response.userEvent);
        if (sent) {
          pendingUserMessagesRef.current = dedupeMessages([
            ...pendingUserMessagesRef.current,
            sent,
          ]).filter(item => item.role === 'user');
          setMessages((current) => mergeMessage(current, sent));
        }
        return true;
      } catch (err) {
        setError(errorMessage(err, 'failed to send message'));
        return false;
      } finally {
        setSending(false);
      }
    },
    [bridgeUrl, sessionId, tokens]
  );

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  useEffect(() => {
    pendingUserMessagesRef.current = [];
    setMessages([]);
  }, [sessionId]);

  useEffect(() => {
    if (!lastEvent || !sessionId || lastEvent.sessionId !== sessionId) return;
    if (lastEvent.eventType === 'chat.output.delta') {
      setMessages((current) => mergeDelta(current, lastEvent));
      return;
    }
    const message = eventToMessage(lastEvent);
    if (!message) return;
    if (message.role === 'user') {
      pendingUserMessagesRef.current = pendingUserMessagesRef.current.filter(
        pending => pending.turnId !== message.turnId,
      );
    }
    setMessages((current) => mergeMessage(current, message));
  }, [lastEvent, sessionId]);

  return useMemo(
    () => ({ messages, loading, sending, error, refresh, send, setError }),
    [error, loading, messages, refresh, send, sending]
  );
}
