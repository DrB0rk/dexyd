import { ModuleName } from '../core/module.js';

export type EventSource = ModuleName | 'system' | 'stream' | 'session' | 'harness' | 'plugin';

export type EventEnvelope<TPayload = unknown> = {
  sequence: number;
  timestamp: string;
  eventType: string;
  sessionId: string | null;
  streamId: string | null;
  source: EventSource;
  payload: TPayload;
};

export class RuntimeState {
  #sequence = 0;

  initializeSequence(lastKnown: number): void {
    this.#sequence = Math.max(0, lastKnown);
  }

  nextSequence(): number {
    this.#sequence += 1;
    return this.#sequence;
  }

  currentSequence(): number {
    return this.#sequence;
  }

  createEvent<TPayload>(event: {
    eventType: string;
    payload: TPayload;
    sessionId?: string | null;
    streamId?: string | null;
    source: EventSource;
  }): EventEnvelope<TPayload> {
    return {
      sequence: this.nextSequence(),
      timestamp: new Date().toISOString(),
      eventType: event.eventType,
      sessionId: event.sessionId ?? null,
      streamId: event.streamId ?? null,
      source: event.source,
      payload: event.payload
    };
  }
}
