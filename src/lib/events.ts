import { EventEmitter } from 'events';

// Global singleton survives HMR in dev
const globalForEvents = globalThis as unknown as { __eventBus: EventEmitter };

export const eventBus: EventEmitter =
  globalForEvents.__eventBus ?? (globalForEvents.__eventBus = new EventEmitter());

eventBus.setMaxListeners(100);

export function emitRunEvent(runId: string, event: Record<string, any>) {
  eventBus.emit(`run:${runId}`, event);
}
