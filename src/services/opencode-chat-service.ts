import { ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEnvelope } from '../runtime/runtime-state.js';
import { ChatMessage } from '../domain/chat.js';
import { SessionRecord } from '../domain/session.js';
import { EventService } from './event-service.js';
import { OpenCodeSessionService } from './opencode-session-service.js';

type LoggerLike = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

type OpenCodeChatConfig = {
  runtimePath: string;
  permissionMode: string;
};

export class OpenCodeChatService {
  private readonly activeTurns = new Map<string, Set<ChildProcess>>();
  private readonly runtimeStatuses = new Map<string, { status: SessionRecord['status']; updatedAt: string }>();
  private readonly cancelTimers = new WeakMap<ChildProcess, NodeJS.Timeout>();

  constructor(
    private readonly eventService: EventService,
    private readonly opencodeSessionService: OpenCodeSessionService,
    private readonly config: OpenCodeChatConfig,
    private readonly logger: LoggerLike
  ) {}

  getMessages(sessionId: string, limit = 200): ChatMessage[] {
    return this.opencodeSessionService.getMessages(sessionId, limit);
  }

  applyRuntimeStatus<T extends SessionRecord>(session: T): T {
    if (this.isSessionBusy(session.id)) {
      return {
        ...session,
        status: 'running',
        updatedAt: new Date().toISOString()
      };
    }
    const status = this.runtimeStatuses.get(session.id);
    if (!status) return session;
    return {
      ...session,
      status: status.status,
      updatedAt: status.updatedAt
    };
  }

  sendMessage(input: { session: SessionRecord; message: string; actorDeviceId: string }): {
    turnId: string;
    userEvent: EventEnvelope;
    queued: boolean;
  } {
    const content = input.message.trim();
    const turnId = randomUUID();

    const userEvent = this.emitUserMessage({
      sessionId: input.session.id,
      turnId,
      content,
      actorDeviceId: input.actorDeviceId
    });

    this.startOpenCodeTurn({ session: input.session, turnId, message: content });

    return { turnId, userEvent, queued: false };
  }

  cancelSession(sessionId: string): boolean {
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

  private isSessionBusy(sessionId: string): boolean {
    return Boolean(
      this.activeTurns.get(sessionId)?.size ||
        this.runtimeStatuses.get(sessionId)?.status === 'running'
    );
  }

  private emitUserMessage(input: { sessionId: string; turnId: string; content: string; actorDeviceId: string }): EventEnvelope {
    return this.eventService.emit({
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

  private startOpenCodeTurn(input: { session: SessionRecord; turnId: string; message: string }): void {
    this.setSessionStatus(input.session.id, 'running');
    this.eventService.emit({
      eventType: 'chat.turn.started',
      source: 'session',
      sessionId: input.session.id,
      payload: { turnId: input.turnId }
    });

    setImmediate(() => {
      this.runOpenCodeTurn(input).catch((error) => {
        const message = error instanceof Error ? error.message : 'chat turn failed';
        this.emitFailure(input.session.id, input.turnId, message);
      });
    });
  }

  private async runOpenCodeTurn(input: { session: SessionRecord; turnId: string; message: string }): Promise<void> {
    const prompt = input.message;
    let stdout = '';

    await new Promise<void>((resolve) => {
      const args = this.buildOpenCodeArgs({
        sessionId: input.session.id,
        prompt
      });
      const child = spawn(
        this.config.runtimePath,
        args,
        {
          cwd: input.session.workspacePath,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            NO_COLOR: '1'
          }
        }
      );
      let spawnFailed = false;
      let cancelled = false;
      this.trackChild(input.session.id, child);

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stdout += text;
        this.emitDelta(input.session.id, input.turnId, 'stdout', text);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        this.emitDelta(input.session.id, input.turnId, 'stderr', text);
      });

      child.on('error', (error) => {
        spawnFailed = true;
        this.untrackChild(input.session.id, child);
        this.emitFailure(
          input.session.id,
          input.turnId,
          `Failed to start opencode: ${error.message}`
        );
        resolve();
      });

      child.on('close', (code, signal) => {
        this.untrackChild(input.session.id, child);
        cancelled = signal === 'SIGTERM' || signal === 'SIGKILL';
        if (spawnFailed) {
          resolve();
          return;
        }

        const cleanOutput = stdout.trim();
        if (cancelled) {
          this.emitCancellation(input.session.id, input.turnId);
        } else if (code === 0) {
          if (cleanOutput) {
            this.eventService.emit({
              eventType: 'chat.message.assistant',
              source: 'session',
              sessionId: input.session.id,
              payload: {
                id: randomUUID(),
                turnId: input.turnId,
                role: 'assistant',
                content: cleanOutput,
                exitCode: code
              }
            });
          }
          this.emitCompletion(input.session.id, input.turnId, code ?? 0, Boolean(cleanOutput));
          this.setSessionStatus(input.session.id, 'idle');
        } else {
          this.emitFailure(input.session.id, input.turnId, cleanOutput || this.formatExit(code, signal));
        }
        resolve();
      });
    });
  }

  private buildOpenCodeArgs(input: { sessionId: string; prompt: string }): string[] {
    const args = ['run', '-s', input.sessionId, input.prompt];
    return args;
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

  private emitDelta(sessionId: string, turnId: string, stream: 'stdout' | 'stderr', text: string): void {
    this.eventService.emit({
      eventType: 'chat.output.delta',
      source: 'session',
      sessionId,
      payload: { turnId, stream, text }
    });
  }

  private emitCompletion(sessionId: string, turnId: string, exitCode: number, hasOutput: boolean): void {
    this.eventService.emit({
      eventType: 'chat.turn.completed',
      source: 'session',
      sessionId,
      payload: { turnId, exitCode, hasOutput }
    });
  }

  private emitCancellation(sessionId: string, turnId: string): void {
    this.eventService.emit({
      eventType: 'chat.turn.cancelled',
      source: 'session',
      sessionId,
      payload: { turnId, message: 'OpenCode turn cancelled.' }
    });
    this.setSessionStatus(sessionId, 'cancelled');
  }

  private emitFailure(sessionId: string, turnId: string, message: string): void {
    this.logger.warn({ sessionId, turnId, message }, 'chat turn failed');
    this.eventService.emit({
      eventType: 'chat.turn.failed',
      source: 'session',
      sessionId,
      payload: { turnId, message }
    });
    this.setSessionStatus(sessionId, 'failed');
  }

  private setSessionStatus(sessionId: string, status: SessionRecord['status']): void {
    const updatedAt = new Date().toISOString();
    if (status === 'idle') {
      this.runtimeStatuses.delete(sessionId);
    } else {
      this.runtimeStatuses.set(sessionId, { status, updatedAt });
    }

    this.eventService.emit({
      eventType: 'session.updated',
      source: 'session',
      sessionId,
      payload: {
        id: sessionId,
        status,
        updatedAt
      }
    });
  }

  private formatExit(code: number | null, signal: NodeJS.Signals | null): string {
    if (typeof code === 'number') return `OpenCode exited with code ${code}`;
    if (signal) return `OpenCode exited after signal ${signal}`;
    return 'OpenCode exited without an exit code.';
  }
}