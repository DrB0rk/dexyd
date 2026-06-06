import AsyncStorage from '@react-native-async-storage/async-storage';
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
const CHAT_ACTIVE_POLL_INTERVAL_MS = 1200;
const CHAT_SEND_FOLLOWUP_REFRESH_MS = 350;
const TRANSIENT_MESSAGE_KEEP_MS = 2 * 60 * 1000;
const CHAT_CACHE_KEY = 'dexyd.chat.cache.v1';
const MAX_CACHED_MESSAGES = 260;

export function normalizeDisplayUserContent(content: string): string {
  const text = content.trim();
  if (!text) return '';

  const latest = extractLatestDexydUserMessage(text);
  if (latest !== null) return latest;

  const withoutEnvironment = stripEnvironmentContextBlocks(text).trim();
  if (!withoutEnvironment) return '';

  if (isDexydPromptEnvelope(withoutEnvironment)) return '';
  return withoutEnvironment;
}

function extractLatestDexydUserMessage(text: string): string | null {
  if (!isDexydPromptEnvelope(text)) return null;

  const marker = /(?:^|\n)Latest user message:\s*\n/gi;
  let lastEnd = -1;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(text)) !== null) {
    lastEnd = match.index + match[0].length;
  }

  if (lastEnd < 0) return null;
  return stripEnvironmentContextBlocks(text.slice(lastEnd)).trim();
}

function stripEnvironmentContextBlocks(text: string): string {
  return text
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, '')
    .trim();
}

function isRawRuntimePayload(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (/^<environment_context>[\s\S]*<\/environment_context>$/i.test(trimmed))
    return true;
  if (/^<hook_prompt\b[\s\S]*<\/hook_prompt>$/i.test(trimmed)) return true;
  if (
    /^\{[\s\S]*"(?:tool_uses|sandbox_permissions|recipient_name|function_call|call_id)"[\s\S]*\}$/.test(
      trimmed,
    )
  )
    return true;
  return false;
}

function isDexydPromptEnvelope(text: string): boolean {
  return (
    /You are running inside dexyd as the assistant for a mobile chat session\./i.test(
      text,
    ) ||
    /<environment_context>[\s\S]*?<\/environment_context>/i.test(text) ||
    /Conversation so far:\s*$/im.test(text) ||
    /(?:^|\n)Latest user message:\s*\n/i.test(text)
  );
}

function normalizeChatMessageForDisplay(
  message: ChatMessage,
): ChatMessage | null {
  if (isRawRuntimePayload(message.content)) return null;
  const content =
    message.role === 'user'
      ? normalizeDisplayUserContent(message.content)
      : stripEnvironmentContextBlocks(message.content);
  if (isRawRuntimePayload(content)) return null;
  if (!content) return null;
  return content === message.content ? message : { ...message, content };
}

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
    const content = normalizeDisplayUserContent(
      typeof payload.content === 'string' ? payload.content : '',
    );
    if (!content) return null;
    return {
      id: typeof payload.id === 'string' ? payload.id : `${event.sequence}`,
      turnId,
      role: 'user',
      content,
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
    const role =
      event.eventType === 'chat.message.assistant' ? 'assistant' : 'user';
    const rawContent =
      role === 'user'
        ? normalizeDisplayUserContent(
            typeof payload.content === 'string' ? payload.content : '',
          )
        : typeof payload.content === 'string'
          ? payload.content
          : '';
    const content = stripEnvironmentContextBlocks(rawContent);
    if (isRawRuntimePayload(content)) return null;
    if (!content) return null;
    return {
      id: typeof payload.id === 'string' ? payload.id : `${event.sequence}`,
      turnId,
      role,
      content,
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
  const content = normalizeDisplayUserContent(
    typeof payload.content === 'string' ? payload.content : '',
  );
  if (!queueId || !turnId || !sessionId || !content) return null;
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
      sameMessageIdentity(item, next) ||
      sameOptimisticUserMessage(item, next) ||
      (next.queueId &&
        item.queueId === next.queueId &&
        item.status === next.status),
  );
  if (found) {
    return dedupeMessages(
      withoutQueued.map(item =>
        item.id === next.id ||
        sameMessageIdentity(item, next) ||
        sameOptimisticUserMessage(item, next) ||
        (next.queueId &&
          item.queueId === next.queueId &&
          item.status === next.status)
          ? preserveStableMessageFields(next, [item])
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
    if (found.content === content) return existing;
    return existing.map(item =>
      item.id === draftId
        ? {
            ...item,
            content,
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

export function chatMessageKey(message: ChatMessage): string {
  const contentHash = hashStableText(message.content.trim());
  const turnId = stableTurnId(message.turnId);
  if (message.queueId) return `queue:${message.queueId}:${message.status}`;
  if (message.role === 'user' && message.status === 'sent') {
    return `user:sent:${contentHash}:${timeBucket(message.createdAt)}`;
  }
  if (turnId) {
    return `${message.role}:${message.status}:${turnId}:${contentHash}`;
  }
  return `${message.role}:${message.status}:${contentHash}:${timeBucket(
    message.createdAt,
  )}`;
}

function sameMessageIdentity(left: ChatMessage, right: ChatMessage): boolean {
  return chatMessageKey(left) === chatMessageKey(right);
}

function sameOptimisticUserMessage(
  left: ChatMessage,
  right: ChatMessage,
): boolean {
  return (
    left.id.startsWith('local-user-') &&
    left.role === 'user' &&
    right.role === 'user' &&
    left.status === 'sent' &&
    right.status === 'sent' &&
    left.content.trim() === right.content.trim() &&
    Math.abs(chatMessageTime(left) - chatMessageTime(right)) <= 10 * 60 * 1000
  );
}

function preserveStableMessageFields(
  next: ChatMessage,
  existingMessages: ChatMessage[],
): ChatMessage {
  const existing = existingMessages.find(
    message =>
      sameMessageIdentity(message, next) ||
      sameOptimisticUserMessage(message, next),
  );
  if (!existing) return next;

  return {
    ...next,
    id: existing.id,
    createdAt: existing.createdAt,
    sequence: existing.sequence,
  };
}

function stableTurnId(turnId: string): string | null {
  if (!turnId || /^sequence-/.test(turnId)) return null;
  return turnId;
}

function timeBucket(value: string): string {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return 'unknown';
  return `${Math.floor(time / 60_000)}`;
}

function hashStableText(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % 2_147_483_647;
  }
  return hash.toString(36);
}

function isRecentTransientMessage(message: ChatMessage): boolean {
  if (message.role === 'tool') return message.status === 'running';
  if (message.status !== 'sent') return false;
  const age = Date.now() - chatMessageTime(message);
  return Number.isFinite(age) && age >= 0 && age <= TRANSIENT_MESSAGE_KEEP_MS;
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
    return (
      Math.abs(chatMessageTime(pending) - chatMessageTime(fetched)) <=
      10 * 60 * 1000
    );
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
      if (sameMessageIdentity(existing, message)) return true;
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
  existingMessages: ChatMessage[] = [],
): ChatMessage[] {
  const incoming = [...items, ...pendingUserMessages]
    .map(normalizeChatMessageForDisplay)
    .filter((message): message is ChatMessage => message !== null)
    .map(message => preserveStableMessageFields(message, existingMessages));
  const incomingKeys = new Set(incoming.map(chatMessageKey));
  const transientExisting = existingMessages.filter(
    message =>
      !incomingKeys.has(chatMessageKey(message)) &&
      isRecentTransientMessage(message),
  );
  const merged = dedupeMessages(
    [...incoming, ...transientExisting].sort(compareChatMessages),
  );
  if (!activeQueueIds) return merged;
  return merged.filter(
    message =>
      message.status !== 'queued' || activeQueueIds.has(message.queueId ?? ''),
  );
}

export function visibleChatMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .map(normalizeChatMessageForDisplay)
    .filter((message): message is ChatMessage => message !== null)
    .filter(message => message.status !== 'queued' && message.role !== 'tool')
    .slice()
    .reverse();
}

function sameChatMessages(left: ChatMessage[], right: ChatMessage[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((message, index) => sameChatMessage(message, right[index]));
}

function sameChatMessage(
  left: ChatMessage,
  right: ChatMessage | undefined,
): boolean {
  if (!right) return false;
  return (
    left.id === right.id &&
    left.turnId === right.turnId &&
    left.role === right.role &&
    left.content === right.content &&
    left.status === right.status &&
    left.queueId === right.queueId &&
    left.createdAt === right.createdAt &&
    left.sequence === right.sequence
  );
}

function nextChatMessages(
  current: ChatMessage[],
  next: ChatMessage[],
): ChatMessage[] {
  return sameChatMessages(current, next) ? current : next;
}

function sameQueuedMessages(
  left: QueuedChatMessage[],
  right: QueuedChatMessage[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((item, index) => sameQueuedMessage(item, right[index]));
}

function sameQueuedMessage(
  left: QueuedChatMessage,
  right: QueuedChatMessage | undefined,
): boolean {
  if (!right) return false;
  return (
    left.queueId === right.queueId &&
    left.turnId === right.turnId &&
    left.sessionId === right.sessionId &&
    left.content === right.content &&
    left.actorDeviceId === right.actorDeviceId &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt
  );
}

function nextQueuedMessages(
  current: QueuedChatMessage[],
  next: QueuedChatMessage[],
): QueuedChatMessage[] {
  return sameQueuedMessages(current, next) ? current : next;
}

function mergeQueuedMessages(
  current: QueuedChatMessage[],
  next: QueuedChatMessage,
): QueuedChatMessage[] {
  const found = current.some(item => item.queueId === next.queueId);
  const items = found
    ? current.map(item =>
        item.queueId === next.queueId && !sameQueuedMessage(item, next)
          ? next
          : item,
      )
    : [...current, next];
  const sorted = items.sort(
    (left, right) =>
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
  );
  return nextQueuedMessages(current, sorted);
}

type CachedChatState = {
  messages: ChatMessage[];
  queuedMessages: QueuedChatMessage[];
  updatedAt: string;
};

function cacheKeyForChat(bridgeUrl: string, sessionId: string): string {
  return `${CHAT_CACHE_KEY}:${bridgeUrl || 'unconfigured'}:${sessionId}`;
}

function parseCachedChatState(raw: string | null): CachedChatState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CachedChatState>;
    const messages = Array.isArray(parsed.messages)
      ? parsed.messages.filter(isChatMessage)
      : [];
    const queuedMessages = Array.isArray(parsed.queuedMessages)
      ? parsed.queuedMessages.filter(isQueuedChatMessage)
      : [];
    return {
      messages: messages
        .map(normalizeChatMessageForDisplay)
        .filter((message): message is ChatMessage => message !== null),
      queuedMessages,
      updatedAt:
        typeof parsed.updatedAt === 'string'
          ? parsed.updatedAt
          : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.turnId === 'string' &&
    typeof record.role === 'string' &&
    typeof record.content === 'string' &&
    typeof record.createdAt === 'string' &&
    typeof record.sequence === 'number' &&
    typeof record.status === 'string'
  );
}

function isQueuedChatMessage(value: unknown): value is QueuedChatMessage {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.queueId === 'string' &&
    typeof record.turnId === 'string' &&
    typeof record.sessionId === 'string' &&
    typeof record.content === 'string' &&
    typeof record.actorDeviceId === 'string' &&
    typeof record.createdAt === 'string' &&
    typeof record.updatedAt === 'string'
  );
}

function cacheableMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .map(normalizeChatMessageForDisplay)
    .filter((message): message is ChatMessage => message !== null)
    .filter(message => message.role !== 'tool' || message.status !== 'running')
    .sort(compareChatMessages)
    .slice(-MAX_CACHED_MESSAGES);
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
  const refreshRequestRef = useRef(0);
  const refreshInFlightRef = useRef(false);
  const queuedRefreshRef = useRef<{ silent: boolean } | null>(null);
  const cacheReadyRef = useRef(false);
  const activeChatKeyRef = useRef<string | null>(null);
  const [cacheReadyVersion, setCacheReadyVersion] = useState(0);
  const hasRunningMessages = useMemo(
    () => messages.some(message => message.status === 'running'),
    [messages],
  );

  const refreshQueue = useCallback(async () => {
    if (!tokens || !sessionId) {
      setQueuedMessages(current => nextQueuedMessages(current, []));
      return;
    }
    const queue = await getQueuedMessages(bridgeUrl, sessionId, tokens);
    setQueuedMessages(current => nextQueuedMessages(current, queue));
  }, [bridgeUrl, sessionId, tokens]);

  const refresh = useCallback(
    async (silent = false) => {
      if (refreshInFlightRef.current) {
        queuedRefreshRef.current = {
          silent: (queuedRefreshRef.current?.silent ?? true) && silent,
        };
        return;
      }

      if (!tokens || !sessionId) {
        refreshRequestRef.current += 1;
        setMessages(current => nextChatMessages(current, []));
        setQueuedMessages(current => nextQueuedMessages(current, []));
        setError(null);
        return;
      }

      const requestId = refreshRequestRef.current;
      refreshInFlightRef.current = true;
      if (!silent) setLoading(true);
      setError(null);
      try {
        const items = await getChatMessages(bridgeUrl, sessionId, tokens);
        if (requestId !== refreshRequestRef.current) return;
        const fetchedUsers = items.filter(message => message.role === 'user');
        pendingUserMessagesRef.current = pendingUserMessagesRef.current.filter(
          message => !pendingUserConfirmed(message, fetchedUsers),
        );

        let activeQueueIds: Set<string> | undefined;
        try {
          const queue = await getQueuedMessages(bridgeUrl, sessionId, tokens);
          if (requestId !== refreshRequestRef.current) return;
          activeQueueIds = new Set(queue.map(item => item.queueId));
          setQueuedMessages(current => nextQueuedMessages(current, queue));
        } catch (queueErr) {
          activeQueueIds = undefined;
          if (!silent) {
            setError(errorMessage(queueErr, 'failed to load queued messages'));
          }
        }

        if (requestId !== refreshRequestRef.current) return;
        setMessages(current =>
          nextChatMessages(
            current,
            mergeFetchedChatMessages(
              items,
              pendingUserMessagesRef.current,
              activeQueueIds,
              current,
            ),
          ),
        );
      } catch (err) {
        if (requestId !== refreshRequestRef.current) return;
        if (silent) return;
        setError(errorMessage(err, 'failed to load chat'));
      } finally {
        if (requestId !== refreshRequestRef.current) {
          return;
        }
        if (!silent) {
          setLoading(false);
        }
        refreshInFlightRef.current = false;
        const queued = queuedRefreshRef.current;
        queuedRefreshRef.current = null;
        if (queued) {
          setTimeout(() => {
            refresh(queued.silent).catch(() => undefined);
          }, 0);
        }
      }
    },
    [bridgeUrl, sessionId, tokens],
  );

  const send = useCallback(
    async (message: string, sessionOverride?: string) => {
      const targetSessionId = sessionOverride ?? sessionId;
      const content = normalizeDisplayUserContent(message);
      if (!tokens || !targetSessionId || !content) return false;
      const optimistic: ChatMessage = {
        id: `local-user-${Date.now()}`,
        turnId: `local-${Date.now()}`,
        role: 'user',
        content,
        createdAt: new Date().toISOString(),
        sequence: Date.now(),
        status: 'sent',
      };
      pendingUserMessagesRef.current = dedupeMessages([
        ...pendingUserMessagesRef.current,
        optimistic,
      ]).filter(item => item.role === 'user');
      setMessages(current =>
        nextChatMessages(current, mergeMessage(current, optimistic)),
      );
      setSending(true);
      setError(null);
      try {
        const response = await sendChatMessage(
          bridgeUrl,
          targetSessionId,
          content,
          tokens,
        );
        const sent = eventToMessage(response.userEvent);
        if (sent) {
          pendingUserMessagesRef.current =
            pendingUserMessagesRef.current.filter(
              item => item.id !== optimistic.id,
            );
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
          setMessages(current =>
            nextChatMessages(current, mergeMessage(current, sent)),
          );
        }
        setTimeout(() => {
          refresh(true).catch(() => undefined);
        }, CHAT_SEND_FOLLOWUP_REFRESH_MS);
        return true;
      } catch (err) {
        pendingUserMessagesRef.current = pendingUserMessagesRef.current.filter(
          item => item.id !== optimistic.id,
        );
        setMessages(current =>
          nextChatMessages(
            current,
            current.filter(item => item.id !== optimistic.id),
          ),
        );
        setError(errorMessage(err, 'failed to send message'));
        return false;
      } finally {
        setSending(false);
      }
    },
    [bridgeUrl, refresh, sessionId, tokens],
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
        setMessages(current => {
          const next = current.map(message =>
            message.queueId === queueId &&
            message.status === 'queued' &&
            message.content !== queued.content
              ? { ...message, content: queued.content }
              : message,
          );
          return nextChatMessages(current, next);
        });
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
            nextQueuedMessages(
              current,
              current.filter(item => item.queueId !== queueId),
            ),
          );
          setMessages(current =>
            nextChatMessages(
              current,
              current.filter(message => message.queueId !== queueId),
            ),
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
    refreshRequestRef.current += 1;
    refreshInFlightRef.current = false;
    queuedRefreshRef.current = null;
    cacheReadyRef.current = false;
    const nextCacheKey =
      tokens && sessionId ? cacheKeyForChat(bridgeUrl, sessionId) : null;
    const sessionChanged = activeChatKeyRef.current !== nextCacheKey;
    activeChatKeyRef.current = nextCacheKey;
    if (sessionChanged) {
      pendingUserMessagesRef.current = [];
      setMessages(current => nextChatMessages(current, []));
      setQueuedMessages(current => nextQueuedMessages(current, []));
    }
    setError(null);

    if (!tokens || !sessionId) {
      cacheReadyRef.current = true;
      setCacheReadyVersion(version => version + 1);
      return undefined;
    }

    let cancelled = false;
    AsyncStorage.getItem(cacheKeyForChat(bridgeUrl, sessionId))
      .then(raw => {
        if (cancelled) return;
        const cached = parseCachedChatState(raw);
        if (!cached) return;
        setMessages(current =>
          nextChatMessages(
            current,
            mergeFetchedChatMessages(cached.messages, [], undefined, current),
          ),
        );
        setQueuedMessages(current =>
          nextQueuedMessages(current, cached.queuedMessages),
        );
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) {
          cacheReadyRef.current = true;
          setCacheReadyVersion(version => version + 1);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [bridgeUrl, sessionId, tokens]);

  useEffect(() => {
    if (!tokens || !sessionId || !cacheReadyRef.current) return;
    const timer = setTimeout(() => {
      const cached: CachedChatState = {
        messages: cacheableMessages(messages),
        queuedMessages,
        updatedAt: new Date().toISOString(),
      };
      AsyncStorage.setItem(
        cacheKeyForChat(bridgeUrl, sessionId),
        JSON.stringify(cached),
      ).catch(() => undefined);
    }, 250);
    return () => clearTimeout(timer);
  }, [
    bridgeUrl,
    cacheReadyVersion,
    messages,
    queuedMessages,
    sessionId,
    tokens,
  ]);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  useEffect(() => {
    if (!tokens || !sessionId) return undefined;
    const delay = hasRunningMessages
      ? CHAT_ACTIVE_POLL_INTERVAL_MS
      : CHAT_POLL_INTERVAL_MS;
    const timer = setInterval(() => {
      refresh(true).catch(() => undefined);
    }, delay);
    return () => clearInterval(timer);
  }, [hasRunningMessages, refresh, sessionId, tokens]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') {
        refresh(true).catch(() => undefined);
      }
    });
    return () => subscription.remove();
  }, [refresh]);

  useEffect(() => {
    if (!lastEvent || !sessionId) return;
    if (lastEvent.eventType === 'replay.expired') {
      refresh(true).catch(() => undefined);
      refreshQueue().catch(() => undefined);
      return;
    }
    if (lastEvent.sessionId !== sessionId) return;
    if (lastEvent.eventType === 'chat.turn.completed') {
      refresh(true).catch(() => undefined);
      refreshQueue().catch(() => undefined);
      return;
    }
    if (lastEvent.eventType === 'chat.output.delta') {
      setMessages(current =>
        nextChatMessages(current, mergeDelta(current, lastEvent)),
      );
      return;
    }
    if (lastEvent.eventType === 'chat.message.queued.removed') {
      const payload = (lastEvent.payload ?? {}) as Record<string, unknown>;
      const queueId =
        typeof payload.queueId === 'string' ? payload.queueId : '';
      if (queueId) {
        setQueuedMessages(current =>
          nextQueuedMessages(
            current,
            current.filter(item => item.queueId !== queueId),
          ),
        );
        setMessages(current =>
          nextChatMessages(
            current,
            current.filter(
              message =>
                message.queueId !== queueId || message.status !== 'queued',
            ),
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
          nextQueuedMessages(
            current,
            current.filter(item => item.queueId !== message.queueId),
          ),
        );
      }
    } else if (message.role === 'assistant' && message.status === 'sent') {
      pendingUserMessagesRef.current = pendingUserMessagesRef.current.filter(
        pending => pending.turnId !== message.turnId,
      );
    }
    setMessages(current =>
      nextChatMessages(current, mergeMessage(current, message)),
    );
  }, [lastEvent, refresh, refreshQueue, sessionId]);

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
