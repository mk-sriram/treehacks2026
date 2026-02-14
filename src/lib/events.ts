import { EventEmitter } from 'events';

// Global singleton survives HMR in dev
const globalForEvents = globalThis as unknown as { __eventBus: EventEmitter };

export const eventBus: EventEmitter =
  globalForEvents.__eventBus ?? (globalForEvents.__eventBus = new EventEmitter());

eventBus.setMaxListeners(100);

export function emitRunEvent(runId: string, event: Record<string, any>) {
  console.log(`[SSE] Emitting event for run:${runId} ->`, event.type, event.type === 'activity' ? event.payload?.title : event.type === 'stage_change' ? event.payload?.stage : '');
  eventBus.emit(`run:${runId}`, event);
}
