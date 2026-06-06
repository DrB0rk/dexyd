import { ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { EventEnvelope } from '../runtime/runtime-state.js';
import { EventService } from './event-service.js';
import { SqliteService } from '../db/sqlite.js';
import { ChatMessage } from '../domain/chat.js';
import { DiffSummary } from '../domain/diff.js';
import { SessionRecord } from '../domain/session.js';
import { CodexSessionService } from './codex-session-service.js';
import { DiffService, WorkspaceSnapshot } from './diff-service.js';

type LoggerLike = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

type CodexChatConfig = {
  runtimePath: string;
  permissionMode: 'inherit' | 'read-only' | 'workspace-write' | 'danger-full-access' | 'bypass';
  harness: {
    mode: 'direct' | 'omx' | 'custom';
    command: string;
    args: string[];
  };
  maxOutputBytes?: number;
};

type RuntimeLaunch = {
  command: string;
  argsPrefix: string[];
  label: string;
};

export type QueuedChatMessage = {
  queueId: string;
  turnId: string;
  sessionId: string;
  content: string;
  actorDeviceId: string;
  createdAt: string;
  updatedAt: string;
};

const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const QUEUE_DRAIN_DELAY_MS = 50;

export class CodexChatService {
  private readonly launch: RuntimeLaunch;
  private readonly activeTurns = new Map<string, Set<ChildProcess>>();
  private readonly runtimeStatuses = new Map<string, { status: SessionRecord['status']; updatedAt: string }>();
  private readonly queues = new Map<string, QueuedChatMessage[]>();
  private readonly drainingSessions = new Set<string>();
  private readonly queueDrainTimers = new Map<string, NodeJS.Timeout>();
  private readonly cancelTimers = new WeakMap<ChildProcess, NodeJS.Timeout>();

  constructor(
    private readonly db: SqliteService,
    private readonly eventService: EventService,
    private readonly codexSessionService: CodexSessionService,
    private readonly diffService: DiffService,
    private readonly config: CodexChatConfig,
    private readonly logger: LoggerLike
  ) {
    this.launch = resolveRuntimeLaunch(config);
    if (this.launch.command !== config.runtimePath || this.launch.argsPrefix.length > 0 || config.harness.mode !== 'direct') {
      this.logger.info(
        {
          runtimePath: config.runtimePath,
          harness: config.harness,
          command: this.launch.command,
          argsPrefix: this.launch.argsPrefix
        },
        'resolved codex launch command'
      );
    }
  }

  getMessages(sessionId: string, limit = 200): ChatMessage[] {
    const dexydMessages = this.db
      .listSessionEvents(sessionId, limit)
      .map((event) => this.eventToChatMessage(event))
      .filter((message): message is ChatMessage => message !== null);
    const codexMessages = this.codexSessionService.getMessages(sessionId, limit);
    return compactRuntimeMessages([...codexMessages, ...dexydMessages])
      .sort(compareChatMessages)
      .slice(-limit);
  }

  getQueue(sessionId: string): QueuedChatMessage[] {
    return [...(this.queues.get(sessionId) ?? [])];
  }

  getTurnDiff(sessionId: string, turnId: string): DiffSummary | null {
    const event = this.db
      .listSessionEvents(sessionId, 1000)
      .filter((entry) => entry.eventType === 'chat.turn.diff')
      .reverse()
      .find((entry) => {
        const payload = entry.payload as Record<string, unknown>;
        return payload.turnId === turnId;
      });
    if (!event) return null;

    const payload = event.payload as Record<string, unknown>;
    return {
      status: typeof payload.status === 'string' ? payload.status : '',
      stat: typeof payload.stat === 'string' ? payload.stat : '',
      diff: typeof payload.diff === 'string' ? payload.diff : '',
      truncated: payload.truncated === true
    };
  }

  applyRuntimeStatus<T extends SessionRecord>(session: T): T {
    const status = this.getRuntimeStatus(session.id);
    if (!status) return session;
    return {
      ...session,
      status: status.status,
      updatedAt: status.updatedAt
    };
  }

  getRuntimeStatus(sessionId: string): { status: SessionRecord['status']; updatedAt: string } | null {
    if (this.isSessionBusy(sessionId)) {
      return { status: 'running', updatedAt: new Date().toISOString() };
    }
    return this.runtimeStatuses.get(sessionId) ?? null;
  }

  steerQueuedMessage(input: { sessionId: string; queueId: string; steering: string }): QueuedChatMessage | null {
    const content = input.steering.trim();
    if (!content) return null;
    const queue = this.queues.get(input.sessionId) ?? [];
    const index = queue.findIndex((item) => item.queueId === input.queueId);
    if (index < 0) return null;

    const existing = queue[index];
    if (!existing) return null;
    const updated: QueuedChatMessage = {
      ...existing,
      content: `${existing.content}\n\nSteering note: ${content}`,
      updatedAt: new Date().toISOString()
    };
    queue[index] = updated;
    this.queues.set(input.sessionId, queue);
    this.eventService.emit({
      eventType: 'chat.message.queued.updated',
      source: 'session',
      sessionId: input.sessionId,
      payload: {
        id: updated.queueId,
        queueId: updated.queueId,
        turnId: updated.turnId,
        role: 'user',
        content: updated.content
      }
    });
    return updated;
  }

  removeQueuedMessage(input: { sessionId: string; queueId: string }): boolean {
    const queue = this.queues.get(input.sessionId) ?? [];
    const next = queue.filter((item) => item.queueId !== input.queueId);
    if (next.length === queue.length) return false;
    if (next.length) this.queues.set(input.sessionId, next);
    else this.queues.delete(input.sessionId);
    this.eventService.emit({
      eventType: 'chat.message.queued.removed',
      source: 'session',
      sessionId: input.sessionId,
      payload: { queueId: input.queueId }
    });
    return true;
  }

  sendMessage(input: { session: SessionRecord; message: string; actorDeviceId: string }): {
    turnId: string;
    userEvent: EventEnvelope;
    queued: boolean;
    queueId?: string;
  } {
    const content = input.message.trim();
    const turnId = randomUUID();

    if (this.isSessionBusy(input.session.id)) {
      const queued = this.enqueueMessage({
        sessionId: input.session.id,
        turnId,
        content,
        actorDeviceId: input.actorDeviceId
      });
      return { turnId, userEvent: queued.event, queued: true, queueId: queued.item.queueId };
    }

    const userEvent = this.emitUserMessage({
      sessionId: input.session.id,
      turnId,
      content,
      actorDeviceId: input.actorDeviceId
    });

    this.scheduleCodexTurn({ session: input.session, turnId, message: content });

    return { turnId, userEvent, queued: false };
  }

  cancelSession(sessionId: string): boolean {
    const drainTimer = this.queueDrainTimers.get(sessionId);
    if (drainTimer) {
      clearTimeout(drainTimer);
      this.queueDrainTimers.delete(sessionId);
      this.drainingSessions.delete(sessionId);
    }
    const children = this.activeTurns.get(sessionId);
    if (!children?.size) {
      this.setSessionStatus(sessionId, 'cancelled');
      return false;
    }

    for (const child of children) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => {
        if (this.activeTurns.get(sessionId)?.has(child)) {
          child.kill('SIGKILL');
        }
      }, 3000);
      timer.unref();
      this.cancelTimers.set(child, timer);
    }
    this.setSessionStatus(sessionId, 'cancelled');
    return true;
  }

  private emitUserMessage(input: { sessionId: string; turnId: string; content: string; actorDeviceId: string; queueId?: string }): EventEnvelope {
    return this.eventService.emit({
      eventType: 'chat.message.user',
      source: 'session',
      sessionId: input.sessionId,
      payload: {
        id: randomUUID(),
        turnId: input.turnId,
        role: 'user',
        content: input.content,
        actorDeviceId: input.actorDeviceId,
        ...(input.queueId ? { queueId: input.queueId } : {})
      }
    });
  }

  private enqueueMessage(input: { sessionId: string; turnId: string; content: string; actorDeviceId: string }): { item: QueuedChatMessage; event: EventEnvelope } {
    const now = new Date().toISOString();
    const item: QueuedChatMessage = {
      queueId: randomUUID(),
      turnId: input.turnId,
      sessionId: input.sessionId,
      content: input.content,
      actorDeviceId: input.actorDeviceId,
      createdAt: now,
      updatedAt: now
    };
    const queue = [...(this.queues.get(input.sessionId) ?? []), item];
    this.queues.set(input.sessionId, queue);
    const event = this.eventService.emit({
      eventType: 'chat.message.queued',
      source: 'session',
      sessionId: input.sessionId,
      payload: {
        id: item.queueId,
        queueId: item.queueId,
        turnId: item.turnId,
        role: 'user',
        content: item.content,
        actorDeviceId: item.actorDeviceId
      }
    });
    return { item, event };
  }

  private scheduleNextQueuedTurn(session: SessionRecord): void {
    if (this.queueDrainTimers.has(session.id)) return;
    if ((this.queues.get(session.id) ?? []).length === 0) return;

    this.drainingSessions.add(session.id);
    const timer = setTimeout(() => {
      this.queueDrainTimers.delete(session.id);
      this.drainingSessions.delete(session.id);
      this.startNextQueuedTurn(session);
    }, QUEUE_DRAIN_DELAY_MS);
    timer.unref();
    this.queueDrainTimers.set(session.id, timer);
  }

  private startNextQueuedTurn(session: SessionRecord): void {
    if (this.isSessionBusy(session.id)) return;
    const queue = this.queues.get(session.id) ?? [];
    const next = queue.shift();
    if (!next) {
      this.queues.delete(session.id);
      return;
    }
    if (queue.length) this.queues.set(session.id, queue);
    else this.queues.delete(session.id);

    this.drainingSessions.add(session.id);
    this.eventService.emit({
      eventType: 'chat.message.queued.removed',
      source: 'session',
      sessionId: session.id,
      payload: { queueId: next.queueId, turnId: next.turnId, started: true }
    });
    this.emitUserMessage({
      sessionId: session.id,
      turnId: next.turnId,
      content: next.content,
      actorDeviceId: next.actorDeviceId,
      queueId: next.queueId
    });
    this.drainingSessions.delete(session.id);

    this.scheduleCodexTurn({ session, turnId: next.turnId, message: next.content });
  }

  private isSessionBusy(sessionId: string): boolean {
    return Boolean(
      this.activeTurns.get(sessionId)?.size ||
        this.drainingSessions.has(sessionId) ||
        this.runtimeStatuses.get(sessionId)?.status === 'running'
    );
  }

  private scheduleCodexTurn(input: { session: SessionRecord; turnId: string; message: string }): void {
    this.setSessionStatus(input.session.id, 'running');
    this.eventService.emit({
      eventType: 'chat.turn.started',
      source: 'codexAdapter',
      sessionId: input.session.id,
      payload: { turnId: input.turnId }
    });

    setImmediate(() => {
      this.startCodexTurn(input).catch((error) => {
        const message = error instanceof Error ? error.message : 'chat turn failed';
        this.emitFailure(input.session.id, input.turnId, message);
        this.scheduleNextQueuedTurn(input.session);
      });
    });
  }

  private async startCodexTurn(input: { session: SessionRecord; turnId: string; message: string }): Promise<void> {
    const turnSnapshot = await this.captureTurnSnapshot(input.session, input.turnId);
    const prompt = this.buildPrompt(input.session, input.message);
    const maxOutputBytes = this.config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    let outputBytes = 0;
    let stdout = '';
    let stderr = '';
    let truncated = false;

    await new Promise<void>((resolve) => {
      const codexArgs = buildCodexArgs({
        source: input.session.source,
        sessionId: input.session.id,
        workspacePath: input.session.workspacePath,
        prompt,
        permissionMode: this.config.permissionMode
      });
      const args = [...this.launch.argsPrefix, ...codexArgs];
      const child = spawn(
        this.launch.command,
        args,
        {
          cwd: input.session.workspacePath,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: buildCodexEnvironment()
        }
      );
      let spawnFailed = false;
      let cancelled = false;
      this.trackChild(input.session.id, child);

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        const accepted = this.acceptChunk(text, outputBytes, maxOutputBytes);
        outputBytes += Buffer.byteLength(text);
        if (accepted.truncated) truncated = true;
        if (!accepted.text) return;
        stdout += accepted.text;
        this.emitDelta(input.session.id, input.turnId, 'stdout', accepted.text);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        const accepted = this.acceptChunk(text, outputBytes, maxOutputBytes);
        outputBytes += Buffer.byteLength(text);
        if (accepted.truncated) truncated = true;
        if (!accepted.text) return;
        stderr += accepted.text;
        this.emitDelta(input.session.id, input.turnId, 'stderr', accepted.text);
      });

      child.on('error', (error) => {
        spawnFailed = true;
        this.untrackChild(input.session.id, child);
        this.emitFailure(
          input.session.id,
          input.turnId,
          `Failed to start Codex launcher "${this.launch.label}": ${error.message}. Check codex.runtimePath / codex.harness.command or restart the bridge from a shell where the command is in PATH.`
        );
        this.scheduleNextQueuedTurn(input.session);
        resolve();
      });

      child.on('close', (code, signal) => {
        void (async () => {
        this.untrackChild(input.session.id, child);
        cancelled = signal === 'SIGTERM' || signal === 'SIGKILL';
        if (spawnFailed) {
          resolve();
          return;
        }

        const cleanOutput = sanitizeRuntimeOutput(stdout.trim() || stderr.trim());
        if (cancelled) {
          await this.emitTurnDiff(input.session, input.turnId, turnSnapshot);
          this.emitCancellation(input.session.id, input.turnId);
        } else if (code === 0) {
          await this.emitTurnDiff(input.session, input.turnId, turnSnapshot);
          if (cleanOutput) {
            this.eventService.emit({
              eventType: 'chat.message.assistant',
              source: 'codexAdapter',
              sessionId: input.session.id,
              payload: {
                id: randomUUID(),
                turnId: input.turnId,
                role: 'assistant',
                content: truncated ? `${cleanOutput}\n\n[output truncated]` : cleanOutput,
                exitCode: code
              }
            });
          }
          this.emitCompletion(input.session.id, input.turnId, code ?? 0, Boolean(cleanOutput), truncated);
          this.setSessionStatus(input.session.id, 'idle');
          this.scheduleNextQueuedTurn(input.session);
        } else {
          await this.emitTurnDiff(input.session, input.turnId, turnSnapshot);
          this.emitFailure(input.session.id, input.turnId, cleanOutput || formatCodexExit(code, signal));
          this.scheduleNextQueuedTurn(input.session);
        }
        resolve();
        })().catch((error) => {
          this.logger.warn(
            {
              sessionId: input.session.id,
              turnId: input.turnId,
              error: error instanceof Error ? error.message : 'unknown error'
            },
            'chat turn close handling failed'
          );
          this.emitFailure(input.session.id, input.turnId, 'Chat turn close handling failed.');
          this.scheduleNextQueuedTurn(input.session);
          resolve();
        });
      });
    });
  }

  private async captureTurnSnapshot(session: SessionRecord, turnId: string): Promise<WorkspaceSnapshot | null> {
    try {
      return await this.diffService.createSnapshot(session);
    } catch (error) {
      this.logger.warn(
        {
          sessionId: session.id,
          turnId,
          error: error instanceof Error ? error.message : 'unknown error'
        },
        'failed to capture pre-turn workspace snapshot'
      );
      return null;
    }
  }

  private async emitTurnDiff(session: SessionRecord, turnId: string, snapshot: WorkspaceSnapshot | null): Promise<void> {
    if (!snapshot) return;
    try {
      const diff = await this.diffService.summarizeChangesSince(session, snapshot);
      this.eventService.emit({
        eventType: 'chat.turn.diff',
        source: 'codexAdapter',
        sessionId: session.id,
        payload: {
          turnId,
          ...diff
        }
      });
    } catch (error) {
      this.logger.warn(
        {
          sessionId: session.id,
          turnId,
          error: error instanceof Error ? error.message : 'unknown error'
        },
        'failed to summarize per-turn workspace diff'
      );
    }
  }

  private trackChild(sessionId: string, child: ChildProcess): void {
    const children = this.activeTurns.get(sessionId) ?? new Set<ChildProcess>();
    children.add(child);
    this.activeTurns.set(sessionId, children);
  }

  private untrackChild(sessionId: string, child: ChildProcess): void {
    const children = this.activeTurns.get(sessionId);
    if (!children) return;
    children.delete(child);
    const cancelTimer = this.cancelTimers.get(child);
    if (cancelTimer) {
      clearTimeout(cancelTimer);
      this.cancelTimers.delete(child);
    }
    if (children.size === 0) {
      this.activeTurns.delete(sessionId);
    }
  }

  private buildPrompt(_session: SessionRecord, latestMessage: string): string {
    return latestMessage.trim();
  }

  private acceptChunk(text: string, usedBytes: number, maxBytes: number): { text: string; truncated: boolean } {
    if (usedBytes >= maxBytes) return { text: '', truncated: true };
    const remaining = maxBytes - usedBytes;
    const bytes = Buffer.byteLength(text);
    if (bytes <= remaining) return { text, truncated: false };
    return { text: Buffer.from(text).subarray(0, remaining).toString('utf8'), truncated: true };
  }

  private emitDelta(sessionId: string, turnId: string, stream: 'stdout' | 'stderr', text: string): void {
    this.eventService.emit({
      eventType: 'chat.output.delta',
      source: 'codexAdapter',
      sessionId,
      payload: { turnId, stream, text }
    });
  }

  private setSessionStatus(sessionId: string, status: SessionRecord['status']): void {
    const updatedAt = new Date().toISOString();
    if (status === 'idle') {
      this.runtimeStatuses.delete(sessionId);
    } else {
      this.runtimeStatuses.set(sessionId, { status, updatedAt });
    }

    const localSession = this.db.patchSession({ sessionId, status });
    const codexSession = localSession ? null : this.codexSessionService.getSession(sessionId);
    const session = localSession ?? (codexSession ? { ...codexSession, status, updatedAt } : null);
    if (!session) return;

    this.eventService.emit({
      eventType: 'session.updated',
      source: 'session',
      sessionId,
      payload: session
    });
  }

  private emitCompletion(sessionId: string, turnId: string, exitCode: number, hasOutput: boolean, truncated: boolean): void {
    this.eventService.emit({
      eventType: 'chat.turn.completed',
      source: 'codexAdapter',
      sessionId,
      payload: { turnId, exitCode, hasOutput, truncated }
    });
  }

  private emitCancellation(sessionId: string, turnId: string): void {
    this.eventService.emit({
      eventType: 'chat.turn.cancelled',
      source: 'codexAdapter',
      sessionId,
      payload: { turnId, message: 'Codex turn cancelled.' }
    });
    this.setSessionStatus(sessionId, 'cancelled');
  }

  private emitFailure(sessionId: string, turnId: string, message: string): void {
    this.logger.warn({ sessionId, turnId, message }, 'chat turn failed');
    this.eventService.emit({
      eventType: 'chat.turn.failed',
      source: 'codexAdapter',
      sessionId,
      payload: { turnId, message }
    });
    this.setSessionStatus(sessionId, 'failed');
  }

  private eventToChatMessage(event: EventEnvelope): ChatMessage | null {
    if (!event.eventType.startsWith('chat.')) return null;
    const payload = event.payload as Record<string, unknown>;
    const turnId = typeof payload.turnId === 'string' ? payload.turnId : `sequence-${event.sequence}`;

    if (event.eventType === 'chat.message.queued' || event.eventType === 'chat.message.queued.updated') {
      return {
        id: typeof payload.id === 'string' ? payload.id : `${event.sequence}`,
        turnId,
        role: 'user',
        content: typeof payload.content === 'string' ? payload.content : '',
        createdAt: event.timestamp,
        sequence: event.sequence,
        status: 'queued',
        ...(typeof payload.queueId === 'string' ? { queueId: payload.queueId } : {})
      };
    }

    if (event.eventType === 'chat.message.user' || event.eventType === 'chat.message.assistant') {
      const role = payload.role === 'assistant' ? 'assistant' : 'user';
      return {
        id: typeof payload.id === 'string' ? payload.id : `${event.sequence}`,
        turnId,
        role,
        content: typeof payload.content === 'string' ? payload.content : '',
        createdAt: event.timestamp,
        sequence: event.sequence,
        status: 'sent',
        ...(typeof payload.queueId === 'string' ? { queueId: payload.queueId } : {})
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
}

function formatCodexExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (typeof code === 'number') return `Codex exited with code ${code}`;
  if (signal) return `Codex exited after signal ${signal}`;
  return 'Codex exited without an exit code.';
}

function sanitizeRuntimeOutput(output: string): string {
  const lines = output.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/);
  const kept = lines.filter((line) => !isRuntimeNoiseLine(line));
  return kept.join('\n').trim();
}

function isRuntimeNoiseLine(line: string): boolean {
  const text = line.trim();
  if (!text) return false;
  if (/^(Chunk ID|Wall time|Exit code|Process exited|Original token count|Output):/i.test(text)) return true;
  if (/^\{.*"(?:cmd|tool_uses|sandbox_permissions|recipient_name|function_call|call_id)"/.test(text)) return true;
  if (/^>{0,2}\s*(?:functions|web|image_gen|multi_tool_use)\./.test(text)) return true;
  return false;
}

function compactRuntimeMessages(messages: ChatMessage[]): ChatMessage[] {
  const ordered = [...messages].sort(compareChatMessages);
  const terminalTurns = new Set(
    ordered
      .filter((message) => message.role === 'assistant' || message.status === 'failed' || message.status === 'cancelled')
      .map((message) => message.turnId)
  );
  const sentQueuedTurns = new Set(
    ordered
      .filter((message) => message.role === 'user' && message.status === 'sent')
      .map((message) => message.queueId ?? message.turnId)
  );
  const result: ChatMessage[] = [];

  for (const message of ordered) {
    if (message.role === 'tool' && message.status === 'running' && terminalTurns.has(message.turnId)) continue;
    if (message.status === 'queued' && sentQueuedTurns.has(message.queueId ?? message.turnId)) continue;
    if (isDuplicateRuntimeMessage(result, message)) continue;

    const previous = result.at(-1);
    if (message.status === 'sent' && message.role === 'tool' && previous?.role === 'tool' && previous.status === 'sent') {
      result.pop();
    }
    result.push(message);
  }

  return result;
}

function compareChatMessages(left: ChatMessage, right: ChatMessage): number {
  const timeDiff = chatMessageTime(left) - chatMessageTime(right);
  if (timeDiff !== 0) return timeDiff;
  return left.sequence - right.sequence;
}

function chatMessageTime(message: ChatMessage): number {
  const time = new Date(message.createdAt).getTime();
  return Number.isFinite(time) ? time : 0;
}

function isDuplicateRuntimeMessage(messages: ChatMessage[], next: ChatMessage): boolean {
  return messages.some((message) => {
    if (message.role !== next.role || message.status !== next.status) return false;
    if (message.content.trim() !== next.content.trim()) return false;
    if (message.turnId === next.turnId) return true;
    return (
      message.role === 'user' &&
      next.role === 'user' &&
      Math.abs(chatMessageTime(message) - chatMessageTime(next)) <= 10 * 60 * 1000
    );
  });
}


function buildCodexEnvironment(): NodeJS.ProcessEnv {
  const home = process.env.HOME || homedir();
  const xdgConfigHome = process.env.XDG_CONFIG_HOME || join(home, '.config');
  const xdgDataHome = process.env.XDG_DATA_HOME || join(home, '.local', 'share');
  const path = mergePathWithUserBins(process.env.PATH || '', home);
  return {
    ...process.env,
    HOME: home,
    USER: process.env.USER || process.env.LOGNAME || 'user',
    LOGNAME: process.env.LOGNAME || process.env.USER || 'user',
    XDG_CONFIG_HOME: xdgConfigHome,
    XDG_DATA_HOME: xdgDataHome,
    CODEX_HOME: process.env.CODEX_HOME || join(home, '.codex'),
    GH_CONFIG_DIR: process.env.GH_CONFIG_DIR || join(xdgConfigHome, 'gh'),
    PATH: path,
    NO_COLOR: '1'
  };
}

function mergePathWithUserBins(existingPath: string, home: string): string {
  const dirs = existingPath.split(delimiter).filter(Boolean);
  const additions = [
    join(home, '.local', 'npm', 'bin'),
    join(home, '.local', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, 'go', 'bin'),
    '/usr/local/bin',
    '/usr/bin',
    '/bin'
  ];
  return [...new Set([...dirs, ...additions])].join(delimiter);
}

function resolveRuntimeLaunch(config: CodexChatConfig): RuntimeLaunch {
  if (config.harness.mode === 'direct') {
    return {
      command: resolveExecutable(config.runtimePath),
      argsPrefix: [],
      label: config.runtimePath
    };
  }

  const configuredCommand = config.harness.mode === 'omx' && !config.harness.command.trim()
    ? 'omx'
    : config.harness.command;
  const command = resolveExecutable(configuredCommand);
  return {
    command,
    argsPrefix: config.harness.args,
    label: [configuredCommand, ...config.harness.args].join(' ')
  };
}

function buildCodexArgs(input: {
  source: SessionRecord['source'];
  sessionId: string;
  workspacePath: string;
  prompt: string;
  permissionMode: CodexChatConfig['permissionMode'];
}): string[] {
  const permissionArgs = codexPermissionArgs(input.permissionMode, input.source === 'codex');
  if (input.source === 'codex') {
    return ['exec', 'resume', '--all', '--skip-git-repo-check', ...permissionArgs, input.sessionId, input.prompt];
  }

  return [
    'exec',
    '--skip-git-repo-check',
    ...permissionArgs,
    '--color',
    'never',
    '-C',
    input.workspacePath,
    input.prompt
  ];
}

function codexPermissionArgs(
  permissionMode: CodexChatConfig['permissionMode'],
  resume: boolean
): string[] {
  if (permissionMode === 'inherit') return [];
  if (permissionMode === 'bypass') return ['--dangerously-bypass-approvals-and-sandbox'];
  if (resume) return ['-c', `sandbox_mode="${permissionMode}"`];
  return ['--sandbox', permissionMode];
}

function resolveExecutable(configuredPath: string): string {
  const expanded = expandHome(configuredPath.trim());
  if (!expanded) return configuredPath;

  if (isAbsolute(expanded) || expanded.includes('/')) {
    return expanded;
  }

  for (const candidate of executableCandidates(expanded)) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return configuredPath;
}

function executableCandidates(command: string): string[] {
  const pathDirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const home = homedir();
  const commonDirs = [
    join(home, '.local', 'npm', 'bin'),
    join(home, '.local', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, 'node_modules', '.bin'),
    '/usr/local/bin',
    '/usr/bin',
    '/bin'
  ];

  return [...new Set([...pathDirs, ...commonDirs])].map((dir) => join(dir, command));
}

function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
