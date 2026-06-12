import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { replayRequestSchema } from '../domain/events.js';
import { EventEnvelope } from './runtime-state.js';

type LoggerLike = {
  debug: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

type ReplayRequest = {
  lastSeenSequence: number;
  sessionId?: string;
  deviceId?: string;
};

type ReplayRequestEvent = {
  socket: WebSocket;
  request: ReplayRequest;
};

type ClientState = {
  queue: string[];
  flushing: boolean;
};

export class StreamHub {
  readonly #clients = new Map<WebSocket, ClientState>();
  readonly #events = new EventEmitter();

  constructor(
    private readonly maxQueuedEventsPerClient: number,
    private readonly maxBufferedBytes: number,
    private readonly logger: LoggerLike
  ) {}

  registerConnection(socket: WebSocket): void {
    this.#clients.set(socket, { queue: [], flushing: false });

    socket.on('close', () => {
      this.#clients.delete(socket);
    });

    socket.on('message', (raw: WebSocket.RawData) => {
      this.#handleIncoming(socket, raw.toString());
    });
  }

  on(eventName: 'replayRequested', listener: (event: ReplayRequestEvent) => void | Promise<void>): void {
    this.#events.on(eventName, listener);
  }

  broadcastEnvelope(event: EventEnvelope): void {
    const encoded = JSON.stringify(event);
    for (const socket of this.#clients.keys()) {
      this.sendToSocket(socket, encoded);
    }
  }

  sendEvent(socket: WebSocket, event: EventEnvelope): void {
    this.sendToSocket(socket, JSON.stringify(event));
  }

  sendJson(socket: WebSocket, payload: unknown): void {
    this.sendToSocket(socket, JSON.stringify(payload));
  }

  clientCount(): number {
    return this.#clients.size;
  }

  private sendToSocket(socket: WebSocket, encoded: string): void {
    const clientState = this.#clients.get(socket);
    if (!clientState || socket.readyState !== socket.OPEN) {
      return;
    }

    if (socket.bufferedAmount > this.maxBufferedBytes) {
      this.logger.warn(
        {
          bufferedAmount: socket.bufferedAmount,
          maxBufferedBytes: this.maxBufferedBytes
        },
        'closing slow websocket client due to backpressure'
      );

      socket.close(1013, 'backpressure: client too slow');
      this.#clients.delete(socket);
      return;
    }

    if (clientState.queue.length >= this.maxQueuedEventsPerClient) {
      this.logger.warn(
        {
          queueLength: clientState.queue.length,
          maxQueuedEventsPerClient: this.maxQueuedEventsPerClient
        },
        'closing websocket client due to full outbound queue'
      );

      socket.close(1013, 'backpressure: queue full');
      this.#clients.delete(socket);
      return;
    }

    clientState.queue.push(encoded);
    this.#flushSocketQueue(socket, clientState);
  }

  #flushSocketQueue(socket: WebSocket, state: ClientState): void {
    if (state.flushing || socket.readyState !== socket.OPEN) {
      return;
    }

    state.flushing = true;

    const next = () => {
      if (socket.readyState !== socket.OPEN) {
        state.queue.length = 0;
        state.flushing = false;
        return;
      }

      const message = state.queue.shift();
      if (!message) {
        state.flushing = false;
        return;
      }

      socket.send(message, (error) => {
        if (error) {
          this.logger.warn({ error }, 'websocket send failure');
          socket.close(1011, 'send failure');
          this.#clients.delete(socket);
          state.flushing = false;
          return;
        }

        setImmediate(next);
      });
    };

    next();
  }

  #handleIncoming(socket: WebSocket, raw: string): void {
    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      this.sendJson(socket, {
        error: 'invalid_json',
        message: 'Incoming websocket payload must be valid JSON.'
      });
      return;
    }

    const replayResult = replayRequestSchema.safeParse(parsed);
    if (replayResult.success) {
      const request: ReplayRequest = {
        lastSeenSequence: replayResult.data.lastSeenSequence,
        ...(replayResult.data.sessionId ? { sessionId: replayResult.data.sessionId } : {}),
        ...(replayResult.data.deviceId ? { deviceId: replayResult.data.deviceId } : {})
      };

      this.#events.emit('replayRequested', {
        socket,
        request
      } satisfies ReplayRequestEvent);
      return;
    }

    const message = parsed as { type?: string };

    if (message.type === 'ping') {
      this.sendJson(socket, { type: 'pong', ts: new Date().toISOString() });
      return;
    }

    this.sendJson(socket, {
      error: 'unsupported_message',
      message: 'Unsupported websocket message type.'
    });
  }
}
