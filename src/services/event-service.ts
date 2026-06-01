import { SqliteService } from '../db/sqlite.js';
import { RuntimeState } from '../runtime/runtime-state.js';
import { StreamHub } from '../runtime/stream-hub.js';
import { EventEnvelope, EventSource } from '../runtime/runtime-state.js';

type LoggerLike = {
  debug: (obj: unknown, msg?: string) => void;
};

export class EventService {
  constructor(
    private readonly runtime: RuntimeState,
    private readonly db: SqliteService,
    private readonly streamHub: StreamHub,
    private readonly replayWindowSeconds: number,
    private readonly maxReplayEvents: number,
    private readonly logger: LoggerLike
  ) {}

  emit(input: {
    eventType: string;
    payload: unknown;
    source: EventSource;
    sessionId?: string | null;
    streamId?: string | null;
  }): EventEnvelope {
    const event = this.runtime.createEvent({
      eventType: input.eventType,
      payload: input.payload,
      source: input.source,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.streamId !== undefined ? { streamId: input.streamId } : {})
    });

    this.db.persistEvent(event);
    this.streamHub.broadcastEnvelope(event);

    return event;
  }

  replay(input: { lastSeenSequence: number; sessionId?: string }): {
    replayExpired: boolean;
    events: EventEnvelope[];
    nextSequence: number;
  } {
    return this.db.getEventsSince({
      lastSeenSequence: input.lastSeenSequence,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      replayWindowSeconds: this.replayWindowSeconds,
      maxEvents: this.maxReplayEvents
    });
  }

  pruneExpiredEvents(): number {
    const cutoffIso = new Date(Date.now() - this.replayWindowSeconds * 1000).toISOString();
    const removed = this.db.pruneEventsOlderThan(cutoffIso);
    this.logger.debug({ removed, cutoffIso }, 'pruned expired events');
    return removed;
  }
}
