import { randomUUID } from 'node:crypto';
import { EventEnvelope } from '../runtime/runtime-state.js';
import { ChatMessage } from '../domain/chat.js';
import { SessionRecord } from '../domain/session.js';
import { EventService } from './event-service.js';
import { OpenCodeApiClient, OpenCodeEvent } from './opencode-api-client.js';
import { OpenCodeSessionService } from './opencode-session-service.js';

type LoggerLike = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  debug?: (obj: unknown, msg?: string) => void;
};

type OpenCodeChatConfig = {
  runtimePath: string;
  permissionMode: 'inherit' | 'read-only' | 'workspace-write' | 'danger-full-access' | 'bypass';
  defaultAgent: string;
  defaultModel: string;
  eventStreamEnabled: boolean;
  streamReconnectMs: number;
  streamIdleTimeoutMs: number;
};

type OpenCodeSessionLike = SessionRecord & { source: 'opencode' };

type ActiveTurn = {
  turnId: string;
  sessionId: string;
  agent: string | null;
  model: { providerID: string; modelID: string } | null;
  startedAt: number;
  unsubscribe: () => void;
  messageId: string | null;
  textBuffer: string;
  reasoningBuffer: string;
  toolCalls: Map<string, { tool: string; input: unknown; output?: string; error?: string; status: 'pending' | 'running' | 'completed' | 'error' }>;
  shellCalls: Map<string, { command: string; output?: string; exitCode?: number; durationMs?: number }>;
  skills: Array<{ skill: string; input?: unknown; at: number }>;
  permissions: Array<{ id: string; tool: string | null; message: string; payload: unknown; emittedAt: number }>;
  questions: Array<{ id: string; question: string; options: Array<{ label: string; description?: string }>; emittedAt: number }>;
};

export type OpenCodePendingTool = {
  sessionId: string;
  callID: string;
  tool: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  input?: unknown;
  output?: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
  title?: string;
  metadata?: Record<string, unknown>;
};

export type OpenCodePendingPermission = {
  sessionId: string;
  requestID: string;
  tool: string | null;
  message: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  receivedAt: number;
};

export type OpenCodePendingQuestion = {
  sessionId: string;
  requestID: string;
  questions: Array<{ question: string; header?: string; options: Array<{ label: string; description?: string }> }>;
  receivedAt: number;
};

export class OpenCodeChatService {
  readonly #activeTurns = new Map<string, Set<ActiveTurn>>();
  readonly #turnBySessionMessage = new Map<string, ActiveTurn>();
  readonly #pendingTools = new Map<string, OpenCodePendingTool>();
  readonly #pendingPermissions = new Map<string, OpenCodePendingPermission>();
  readonly #pendingQuestions = new Map<string, OpenCodePendingQuestion>();
  readonly #runtimeStatuses = new Map<string, { status: SessionRecord['status']; updatedAt: string }>();
  readonly #apiClient: OpenCodeApiClient;
  readonly #sessionService: OpenCodeSessionService;
  readonly #eventService: EventService;
  readonly #config: OpenCodeChatConfig;
  readonly #logger: LoggerLike;
  #streamAbort: AbortController | null = null;
  #streamPromise: Promise<void> | null = null;
  #streamLoopRunning = false;

  constructor(
    eventService: EventService,
    sessionService: OpenCodeSessionService,
    apiClient: OpenCodeApiClient,
    config: OpenCodeChatConfig,
    logger: LoggerLike
  ) {
    this.#eventService = eventService;
    this.#sessionService = sessionService;
    this.#apiClient = apiClient;
    this.#config = config;
    this.#logger = logger;
  }

  get pendingTools(): OpenCodePendingTool[] {
    return [...this.#pendingTools.values()];
  }

  get pendingPermissions(): OpenCodePendingPermission[] {
    return [...this.#pendingPermissions.values()];
  }

  get pendingQuestions(): OpenCodePendingQuestion[] {
    return [...this.#pendingQuestions.values()];
  }

  async getMessages(sessionId: string, limit = 200): Promise<ChatMessage[]> {
    const messages = await this.#sessionService.getMessages(sessionId, limit);
    if (messages.length > 0) return messages;
    return this.#sessionService.getMessagesFromSqlite(sessionId, limit);
  }

  applyRuntimeStatus<T extends SessionRecord>(session: T): T {
    if (this.isSessionBusy(session.id)) {
      return {
        ...session,
        status: 'running',
        updatedAt: new Date().toISOString()
      };
    }
    const status = this.#runtimeStatuses.get(session.id);
    if (!status) return session;
    return {
      ...session,
      status: status.status,
      updatedAt: status.updatedAt
    };
  }

  async startEventStream(): Promise<void> {
    if (this.#streamLoopRunning || !this.#config.eventStreamEnabled) return;
    this.#streamLoopRunning = true;
    await this.#runStreamLoop();
  }

  async stopEventStream(): Promise<void> {
    this.#streamLoopRunning = false;
    if (this.#streamAbort) {
      this.#streamAbort.abort();
      this.#streamAbort = null;
    }
    if (this.#streamPromise) {
      try {
        await this.#streamPromise;
      } catch (error) {
        this.#logger.warn({ error }, 'opencode event stream loop ended with error');
      }
      this.#streamPromise = null;
    }
  }

  sendMessage(input: { session: SessionRecord; message: string; actorDeviceId: string }): {
    turnId: string;
    userEvent: EventEnvelope;
    queued: boolean;
  } {
    const content = input.message.trim();
    if (!content) {
      throw new Error('empty_message');
    }
    if (input.session.source !== 'opencode') {
      throw new Error('not_opencode_session');
    }
    if (this.isSessionBusy(input.session.id)) {
      throw new Error('session_busy');
    }

    const turnId = randomUUID();
    const userEvent = this.#emitUserMessage({
      sessionId: input.session.id,
      turnId,
      content,
      actorDeviceId: input.actorDeviceId
    });

    this.setSessionStatus(input.session.id, 'running');
    this.#eventService.emit({
      eventType: 'chat.turn.started',
      source: 'session',
      sessionId: input.session.id,
      payload: { turnId }
    });

    setImmediate(() => {
      this.runTurn({ session: input.session, turnId, content }).catch((error) => {
        const message = error instanceof Error ? error.message : 'chat turn failed';
        this.#emitFailure(input.session.id, turnId, message);
      });
    });

    return { turnId, userEvent, queued: false };
  }

  async sendMessageAsync(input: { session: SessionRecord; message: string; actorDeviceId: string }): Promise<{
    turnId: string;
    userEvent: EventEnvelope;
  }> {
    const result = this.sendMessage(input);
    return { turnId: result.turnId, userEvent: result.userEvent };
  }

  async runTurn(input: { session: SessionRecord; turnId: string; content: string }): Promise<void> {
    const session = input.session as OpenCodeSessionLike;
    if (session.source !== 'opencode') {
      this.#emitFailure(session.id, input.turnId, 'session is not an opencode session');
      return;
    }
    const ready = await this.#sessionService.ensureServer();
    if (!ready.baseUrl) {
      this.#emitFailure(session.id, input.turnId, ready.error ?? 'opencode server unavailable');
      return;
    }
    let sessionDetail;
    try {
      sessionDetail = await this.#sessionService.getSession(session.id);
    } catch (error) {
      this.#logger.warn({ sessionId: session.id, error }, 'opencode session lookup failed');
      this.#emitFailure(session.id, input.turnId, error instanceof Error ? error.message : 'session lookup failed');
      return;
    }

    const turn: ActiveTurn = this.#startTurn(
      session.id,
      input.turnId,
      sessionDetail?.agent ?? this.#config.defaultAgent,
      sessionDetail?.modelProviderID && sessionDetail?.modelID
        ? { providerID: sessionDetail.modelProviderID, modelID: sessionDetail.modelID }
        : null
    );

    // If the session detail didn't have a model assigned yet (freshly created
    // sessions get the model only after their first message), fall back to the
    // bridge's configured defaults so the prompt can be dispatched.
    const agent = turn.agent ?? this.#config.defaultAgent;
    const defaultModel = !turn.model ? await this.#sessionService.resolveDefaultModel() : null;

    try {
      await this.#apiClient.sendMessageAsync(
        session.id,
        [{ type: 'text', text: input.content }],
        {
          agent,
          ...(turn.model
            ? { model: turn.model }
            : defaultModel
              ? { model: defaultModel }
              : {})
        }
      );
    } catch (error) {
      this.#logger.warn(
        { sessionId: session.id, turnId: input.turnId, error: error instanceof Error ? error.message : 'unknown' },
        'opencode prompt_async failed'
      );
      this.#endTurn(turn, 'failed', error instanceof Error ? error.message : 'failed to dispatch prompt');
    }
  }

  cancelSession(sessionId: string): boolean {
    const turns = this.#activeTurns.get(sessionId);
    if (!turns?.size) {
      this.setSessionStatus(sessionId, 'cancelled');
      return false;
    }
    this.#apiClient.abortSession(sessionId).catch((error) => {
      this.#logger.warn({ error, sessionId }, 'opencode abortSession failed');
    });
    for (const turn of turns) {
      this.#endTurn(turn, 'cancelled', 'cancelled by user');
    }
    this.setSessionStatus(sessionId, 'cancelled');
    return true;
  }

  async cancelSessionAsync(sessionId: string): Promise<boolean> {
    return this.cancelSession(sessionId);
  }

  isSessionBusy(sessionId: string): boolean {
    return Boolean(
      this.#activeTurns.get(sessionId)?.size ||
        this.#runtimeStatuses.get(sessionId)?.status === 'running'
    );
  }

  setSessionStatus(sessionId: string, status: SessionRecord['status']): void {
    const updatedAt = new Date().toISOString();
    if (status === 'idle') {
      this.#runtimeStatuses.delete(sessionId);
    } else {
      this.#runtimeStatuses.set(sessionId, { status, updatedAt });
    }
    this.#eventService.emit({
      eventType: 'session.updated',
      source: 'session',
      sessionId,
      payload: { id: sessionId, status, updatedAt }
    });
  }

  #emitUserMessage(input: { sessionId: string; turnId: string; content: string; actorDeviceId: string }): EventEnvelope {
    return this.#eventService.emit({
      eventType: 'chat.message.user',
      source: 'session',
      sessionId: input.sessionId,
      payload: {
        id: randomUUID(),
        turnId: input.turnId,
        role: 'user',
        content: input.content,
        actorDeviceId: input.actorDeviceId
      }
    });
  }

  #startTurn(sessionId: string, turnId: string, agent: string | null, model: { providerID: string; modelID: string } | null): ActiveTurn {
    const turn: ActiveTurn = {
      turnId,
      sessionId,
      agent,
      model,
      startedAt: Date.now(),
      unsubscribe: () => undefined,
      messageId: null,
      textBuffer: '',
      reasoningBuffer: '',
      toolCalls: new Map(),
      shellCalls: new Map(),
      skills: [],
      permissions: [],
      questions: []
    };
    const activeSet = this.#activeTurns.get(sessionId) ?? new Set<ActiveTurn>();
    activeSet.add(turn);
    this.#activeTurns.set(sessionId, activeSet);
    return turn;
  }

  #endTurn(turn: ActiveTurn, outcome: 'completed' | 'failed' | 'cancelled', message?: string): void {
    const active = this.#activeTurns.get(turn.sessionId);
    if (active) {
      active.delete(turn);
      if (active.size === 0) this.#activeTurns.delete(turn.sessionId);
    }
    turn.unsubscribe();
    this.#sessionService.invalidateCache();
    if (outcome === 'completed') {
      this.setSessionStatus(turn.sessionId, 'idle');
      this.#eventService.emit({
        eventType: 'chat.turn.completed',
        source: 'session',
        sessionId: turn.sessionId,
        payload: { turnId: turn.turnId, exitCode: 0, hasOutput: turn.textBuffer.trim().length > 0 }
      });
    } else if (outcome === 'cancelled') {
      this.setSessionStatus(turn.sessionId, 'cancelled');
      this.#eventService.emit({
        eventType: 'chat.turn.cancelled',
        source: 'session',
        sessionId: turn.sessionId,
        payload: { turnId: turn.turnId, message: message ?? 'OpenCode turn cancelled.' }
      });
    } else {
      this.setSessionStatus(turn.sessionId, 'failed');
      this.#logger.warn({ sessionId: turn.sessionId, turnId: turn.turnId, message }, 'opencode chat turn failed');
      this.#eventService.emit({
        eventType: 'chat.turn.failed',
        source: 'session',
        sessionId: turn.sessionId,
        payload: { turnId: turn.turnId, message: message ?? 'opencode turn failed' }
      });
    }
  }

  #emitFailure(sessionId: string, turnId: string, message: string): void {
    this.setSessionStatus(sessionId, 'failed');
    this.#logger.warn({ sessionId, turnId, message }, 'opencode chat turn failed');
    this.#eventService.emit({
      eventType: 'chat.turn.failed',
      source: 'session',
      sessionId,
      payload: { turnId, message }
    });
  }

  async #runStreamLoop(): Promise<void> {
    if (!this.#config.eventStreamEnabled) return;
    while (this.#streamLoopRunning) {
      this.#streamAbort = new AbortController();
      this.#streamPromise = this.#consumeStream(this.#streamAbort.signal).catch((error) => {
        this.#logger.warn({ error }, 'opencode event stream disconnected');
      });
      try {
        await this.#streamPromise;
      } catch (error) {
        this.#logger.debug?.({ error }, 'opencode stream loop iteration failed');
      }
      if (!this.#streamLoopRunning) break;
      await new Promise((resolve) => setTimeout(resolve, this.#config.streamReconnectMs));
    }
  }

  async #consumeStream(signal: AbortSignal): Promise<void> {
    const ready = await this.#sessionService.ensureServer();
    if (!ready.baseUrl) {
      this.#logger.debug?.({ error: ready.error }, 'opencode stream not available');
      return;
    }
    try {
      for await (const event of this.#apiClient.subscribeEvents(signal)) {
        this.#handleEvent(event);
      }
    } catch (error) {
      this.#logger.debug?.({ error }, 'opencode stream terminated');
    }
  }

  #handleEvent(event: OpenCodeEvent): void {
    if (event.type === 'unknown') return;
    switch (event.type) {
      case 'server.connected':
      case 'server.disconnected':
        this.#eventService.emit({
          eventType: 'opencode.server.event',
          source: 'session',
          sessionId: null,
          payload: event.payload
        });
        return;
      case 'session.created':
        this.#handleSessionEvent(event.type, event.payload.session);
        return;
      case 'session.updated':
        this.#handleSessionEvent(event.type, event.payload.session);
        return;
      case 'session.deleted':
      case 'session.idle':
        this.#eventService.emit({
          eventType: 'opencode.session.lifecycle',
          source: 'session',
          sessionId: event.payload.sessionID,
          payload: { type: event.type, sessionID: event.payload.sessionID }
        });
        if (event.type === 'session.idle') {
          const turns = this.#activeTurns.get(event.payload.sessionID);
          if (turns) {
            for (const turn of [...turns]) {
              this.#endTurn(turn, 'completed');
            }
          } else {
            this.setSessionStatus(event.payload.sessionID, 'idle');
          }
        }
        return;
      case 'message.updated':
        this.#handleMessageUpdated(event.payload.sessionID, event.payload.message);
        return;
      case 'message.part.updated':
        this.#handleMessagePartUpdated(event.payload);
        return;
      case 'message.part.removed':
        this.#eventService.emit({
          eventType: 'opencode.message.part.removed',
          source: 'session',
          sessionId: event.payload.sessionID,
          payload: event.payload
        });
        return;
      case 'session.next.prompted':
        this.#eventService.emit({
          eventType: 'opencode.turn.prompted',
          source: 'session',
          sessionId: event.payload.sessionID,
          payload: { turnID: event.payload.turnID }
        });
        return;
      case 'session.next.step.started':
      case 'session.next.step.ended':
        this.#eventService.emit({
          eventType: 'opencode.turn.step',
          source: 'session',
          sessionId: event.payload.sessionID,
          payload: event.payload
        });
        return;
      case 'session.next.text.started':
      case 'session.next.text.delta':
      case 'session.next.text.ended':
        this.#handleTextEvent(event);
        return;
      case 'session.next.reasoning.started':
      case 'session.next.reasoning.delta':
      case 'session.next.reasoning.ended':
        this.#handleReasoningEvent(event);
        return;
      case 'session.next.tool.called':
      case 'session.next.tool.progress':
      case 'session.next.tool.success':
      case 'session.next.tool.failed':
        this.#handleToolEvent(event);
        return;
      case 'session.next.shell.started':
      case 'session.next.shell.ended':
        this.#handleShellEvent(event);
        return;
      case 'session.next.skill.used':
        this.#handleSkillEvent(event);
        return;
      case 'permission.asked':
        this.#handlePermissionAsked(event.payload.sessionID, event.payload.request);
        return;
      case 'permission.replied':
        this.#handlePermissionReplied(event.payload);
        return;
      case 'question.asked':
        this.#handleQuestionAsked(event.payload.sessionID, event.payload.request);
        return;
      case 'question.replied':
      case 'question.rejected':
        this.#handleQuestionResolved(event);
        return;
      case 'todo.updated':
        this.#eventService.emit({
          eventType: 'opencode.todo.updated',
          source: 'session',
          sessionId: event.payload.sessionID,
          payload: event.payload
        });
        return;
      case 'session.error':
        this.#eventService.emit({
          eventType: 'opencode.session.error',
          source: 'session',
          sessionId: event.payload.sessionID,
          payload: event.payload
        });
        return;
    }
  }

  #handleSessionEvent(eventType: string, session: { id?: string; title?: string | null; agent?: string | null; model?: { id?: string } | null } | null | undefined): void {
    if (!session?.id) return;
    this.#sessionService.invalidateCache();
    const lifecyclePayload: { id: string; title?: string; agent?: string; model?: { id?: string } } = { id: session.id };
    if (session.title != null) lifecyclePayload.title = session.title;
    if (session.agent != null) lifecyclePayload.agent = session.agent;
    if (session.model != null) lifecyclePayload.model = session.model;
    this.#eventService.emit({
      eventType: 'opencode.session.lifecycle',
      source: 'session',
      sessionId: session.id,
      payload: { type: eventType, session: lifecyclePayload }
    });
  }

  #handleMessageUpdated(sessionId: string, message: { id?: string; role?: string; time?: { completed?: number } }): void {
    if (!message.id) return;
    this.#eventService.emit({
      eventType: 'opencode.message.updated',
      source: 'session',
      sessionId,
      payload: { message }
    });
    if (message.role === 'assistant' && message.time?.completed) {
      const turns = this.#activeTurns.get(sessionId);
      if (turns) {
        for (const turn of [...turns]) {
          if (turn.messageId === message.id || !turn.messageId) {
            this.#endTurn(turn, 'completed');
          }
        }
      }
    }
  }

  #handleMessagePartUpdated(payload: { sessionID: string; messageID: string; part: { type?: string; id?: string; text?: string; tool?: string; callID?: string; state?: unknown } }): void {
    this.#eventService.emit({
      eventType: 'opencode.message.part.updated',
      source: 'session',
      sessionId: payload.sessionID,
      payload
    });
  }

  #handleTextEvent(event: Extract<OpenCodeEvent, { type: 'session.next.text.started' | 'session.next.text.delta' | 'session.next.text.ended' }>): void {
    const turn = this.#trackTurn(event.payload.sessionID, event.payload.messageID);
    if (!turn) return;
    if (event.type === 'session.next.text.started') {
      turn.textBuffer = '';
      this.#eventService.emit({
        eventType: 'opencode.turn.text.started',
        source: 'session',
        sessionId: event.payload.sessionID,
        payload: { turnId: turn.turnId, messageId: event.payload.messageID }
      });
      return;
    }
    if (event.type === 'session.next.text.delta') {
      const text = event.payload.text ?? '';
      turn.textBuffer += text;
      this.#eventService.emit({
        eventType: 'chat.output.delta',
        source: 'session',
        sessionId: event.payload.sessionID,
        payload: { turnId: turn.turnId, stream: 'stdout', text }
      });
      return;
    }
    this.#eventService.emit({
      eventType: 'opencode.turn.text.ended',
      source: 'session',
      sessionId: event.payload.sessionID,
      payload: { turnId: turn.turnId, messageId: event.payload.messageID, text: turn.textBuffer }
    });
    if (turn.textBuffer.trim().length > 0) {
      this.#eventService.emit({
        eventType: 'chat.message.assistant',
        source: 'session',
        sessionId: event.payload.sessionID,
        payload: {
          id: randomUUID(),
          turnId: turn.turnId,
          role: 'assistant',
          content: turn.textBuffer.trim()
        }
      });
    }
  }

  #handleReasoningEvent(event: Extract<OpenCodeEvent, { type: 'session.next.reasoning.started' | 'session.next.reasoning.delta' | 'session.next.reasoning.ended' }>): void {
    const turn = this.#trackTurn(event.payload.sessionID, event.payload.messageID);
    if (!turn) return;
    if (event.type === 'session.next.reasoning.started') {
      turn.reasoningBuffer = '';
      this.#eventService.emit({
        eventType: 'opencode.turn.reasoning.started',
        source: 'session',
        sessionId: event.payload.sessionID,
        payload: { turnId: turn.turnId, messageId: event.payload.messageID }
      });
      return;
    }
    if (event.type === 'session.next.reasoning.delta') {
      const text = event.payload.text ?? '';
      turn.reasoningBuffer += text;
      this.#eventService.emit({
        eventType: 'opencode.turn.reasoning.delta',
        source: 'session',
        sessionId: event.payload.sessionID,
        payload: { turnId: turn.turnId, messageId: event.payload.messageID, text }
      });
      return;
    }
    this.#eventService.emit({
      eventType: 'opencode.turn.reasoning.ended',
      source: 'session',
      sessionId: event.payload.sessionID,
      payload: { turnId: turn.turnId, messageId: event.payload.messageID, text: turn.reasoningBuffer }
    });
  }

  #handleToolEvent(event: Extract<OpenCodeEvent, { type: 'session.next.tool.called' | 'session.next.tool.progress' | 'session.next.tool.success' | 'session.next.tool.failed' }>): void {
    const turn = this.#trackTurn(event.payload.sessionID, event.payload.messageID);
    if (!turn) return;
    const callID = event.payload.callID;
    if (event.type === 'session.next.tool.called') {
      turn.toolCalls.set(callID, { tool: event.payload.tool, input: event.payload.input, status: 'pending' });
      this.#pendingTools.set(callID, {
        sessionId: event.payload.sessionID,
        callID,
        tool: event.payload.tool,
        status: 'pending',
        input: event.payload.input,
        startedAt: Date.now()
      });
      this.#eventService.emit({
        eventType: 'opencode.turn.tool.called',
        source: 'session',
        sessionId: event.payload.sessionID,
        payload: { turnId: turn.turnId, callID, tool: event.payload.tool, input: event.payload.input }
      });
      return;
    }
    if (event.type === 'session.next.tool.progress') {
      this.#eventService.emit({
        eventType: 'opencode.turn.tool.progress',
        source: 'session',
        sessionId: event.payload.sessionID,
        payload: { turnId: turn.turnId, callID, elapsedMs: event.payload.elapsedMs }
      });
      return;
    }
    if (event.type === 'session.next.tool.success') {
      const call = turn.toolCalls.get(callID);
      if (call) {
        call.status = 'completed';
        call.output = typeof event.payload.output === 'string' ? event.payload.output : JSON.stringify(event.payload.output);
      }
      const existing = this.#pendingTools.get(callID);
      if (existing) {
        existing.status = 'completed';
        existing.output = typeof event.payload.output === 'string' ? event.payload.output : JSON.stringify(event.payload.output);
        existing.endedAt = Date.now();
        if (event.payload.title !== undefined) existing.title = event.payload.title;
        if (event.payload.metadata !== undefined) existing.metadata = event.payload.metadata;
      }
      const completedPayload: { turnId: string; callID: string; tool?: string; output?: string; title?: string; metadata?: Record<string, unknown>; elapsedMs?: number } = { turnId: turn.turnId, callID };
      if (call?.tool) completedPayload.tool = call.tool;
      if (call?.output) completedPayload.output = call.output;
      if (event.payload.title !== undefined) completedPayload.title = event.payload.title;
      if (event.payload.metadata !== undefined) completedPayload.metadata = event.payload.metadata;
      if (event.payload.elapsedMs !== undefined) completedPayload.elapsedMs = event.payload.elapsedMs;
      this.#eventService.emit({
        eventType: 'opencode.turn.tool.completed',
        source: 'session',
        sessionId: event.payload.sessionID,
        payload: completedPayload
      });
      this.#pendingTools.delete(callID);
      return;
    }
    const call = turn.toolCalls.get(callID);
    if (call) {
      call.status = 'error';
      call.error = event.payload.error;
    }
    const existing = this.#pendingTools.get(callID);
    if (existing) {
      existing.status = 'error';
      existing.error = event.payload.error;
      existing.endedAt = Date.now();
    }
    this.#eventService.emit({
      eventType: 'opencode.turn.tool.failed',
      source: 'session',
      sessionId: event.payload.sessionID,
      payload: { turnId: turn.turnId, callID, tool: call?.tool, error: event.payload.error }
    });
    this.#pendingTools.delete(callID);
  }

  #handleShellEvent(event: Extract<OpenCodeEvent, { type: 'session.next.shell.started' | 'session.next.shell.ended' }>): void {
    const sessionId = event.payload.sessionID;
    const callID = event.payload.callID;
    if (event.type === 'session.next.shell.started') {
      this.#eventService.emit({
        eventType: 'opencode.turn.shell.started',
        source: 'session',
        sessionId,
        payload: { callID, command: event.payload.command }
      });
      return;
    }
    this.#eventService.emit({
      eventType: 'opencode.turn.shell.ended',
      source: 'session',
      sessionId,
      payload: { callID, output: event.payload.output, exitCode: event.payload.exitCode, durationMs: event.payload.durationMs }
    });
  }

  #handleSkillEvent(event: Extract<OpenCodeEvent, { type: 'session.next.skill.used' }>): void {
    const turn = this.#trackTurn(event.payload.sessionID, event.payload.messageID);
    if (!turn) return;
    turn.skills.push({ skill: event.payload.skill, input: event.payload.input, at: Date.now() });
    this.#eventService.emit({
      eventType: 'opencode.turn.skill.used',
      source: 'session',
      sessionId: event.payload.sessionID,
      payload: { turnId: turn.turnId, skill: event.payload.skill, input: event.payload.input }
    });
  }

  #handlePermissionAsked(sessionId: string, request: { id: string; permission?: string; patterns?: string[]; metadata?: Record<string, unknown>; tool?: { messageID?: string; callID?: string } }): void {
    const entry: OpenCodePendingPermission = {
      sessionId,
      requestID: request.id,
      tool: request.permission ?? request.tool?.callID ?? null,
      message: request.permission ?? 'Permission required',
      patterns: Array.isArray(request.patterns) ? request.patterns : [],
      metadata: request.metadata ?? {},
      receivedAt: Date.now()
    };
    this.#pendingPermissions.set(request.id, entry);
    this.#eventService.emit({
      eventType: 'interaction.permission.requested',
      source: 'plugin',
      sessionId,
      payload: {
        id: request.id,
        kind: 'approval',
        sessionId,
        tool: entry.tool,
        message: entry.message,
        patterns: entry.patterns,
        metadata: entry.metadata,
        createdAt: new Date(entry.receivedAt).toISOString()
      }
    });
  }

  #handlePermissionReplied(payload: { sessionID: string; requestID: string; decision: 'allow' | 'deny' | 'always' }): void {
    this.#pendingPermissions.delete(payload.requestID);
    this.#eventService.emit({
      eventType: 'interaction.permission.responded',
      source: 'plugin',
      sessionId: payload.sessionID,
      payload
    });
  }

  #handleQuestionAsked(sessionId: string, request: { id: string; questions?: Array<{ question: string; header?: string; options?: Array<{ label: string; description?: string }> }> }): void {
    const questions = Array.isArray(request.questions) && request.questions.length > 0
      ? request.questions
      : [{ question: 'OpenCode needs input' }];
    const entry: OpenCodePendingQuestion = {
      sessionId,
      requestID: request.id,
      questions: questions.map((question) => ({
        question: question.question,
        ...(question.header ? { header: question.header } : {}),
        options: Array.isArray(question.options) ? question.options : []
      })),
      receivedAt: Date.now()
    };
    this.#pendingQuestions.set(request.id, entry);
    this.#eventService.emit({
      eventType: 'interaction.question.requested',
      source: 'plugin',
      sessionId,
      payload: {
        id: request.id,
        kind: 'question',
        sessionId,
        questions: entry.questions,
        createdAt: new Date(entry.receivedAt).toISOString()
      }
    });
  }

  #handleQuestionResolved(event: Extract<OpenCodeEvent, { type: 'question.replied' | 'question.rejected' }>): void {
    this.#pendingQuestions.delete(event.payload.requestID);
    this.#eventService.emit({
      eventType: event.type === 'question.replied' ? 'interaction.question.responded' : 'interaction.question.rejected',
      source: 'plugin',
      sessionId: event.payload.sessionID,
      payload: { requestID: event.payload.requestID, ...(event.type === 'question.replied' ? { answers: event.payload.answers } : {}) }
    });
  }

  #trackTurn(sessionId: string, messageId: string): ActiveTurn | null {
    const cached = this.#turnBySessionMessage.get(messageId);
    if (cached) return cached;
    const turns = this.#activeTurns.get(sessionId);
    if (!turns || turns.size === 0) return null;
    const turn = [...turns][0];
    if (!turn) return null;
    if (!turn.messageId) {
      turn.messageId = messageId;
      this.#turnBySessionMessage.set(messageId, turn);
    }
    return turn;
  }
}
