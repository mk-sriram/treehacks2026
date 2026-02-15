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

// ─── Per-run service activation tracker (reference-counted) ──────────
// Allows concurrent operations to independently activate/deactivate services
// without clobbering each other. The frontend receives a boolean payload.

const runServiceCounts: Map<string, Record<string, number>> = new Map();

const SERVICE_KEYS = ['perplexity', 'stagehand', 'elevenlabs', 'elasticsearch', 'openai', 'payment'] as const;

function getOrCreateCounts(runId: string): Record<string, number> {
  if (!runServiceCounts.has(runId)) {
    const counts: Record<string, number> = {};
    for (const k of SERVICE_KEYS) counts[k] = 0;
    runServiceCounts.set(runId, counts);
  }
  return runServiceCounts.get(runId)!;
}

function emitCurrentServices(runId: string) {
  const counts = getOrCreateCounts(runId);
  const payload: Record<string, boolean> = {};
  for (const k of SERVICE_KEYS) {
    payload[k] = (counts[k] ?? 0) > 0;
  }
  emitRunEvent(runId, { type: 'services_change', payload });
}

/** Increment ref-count for a service and emit updated state */
export function activateService(runId: string, service: string) {
  const counts = getOrCreateCounts(runId);
  counts[service] = (counts[service] ?? 0) + 1;
  emitCurrentServices(runId);
}

/** Decrement ref-count for a service and emit updated state */
export function deactivateService(runId: string, service: string) {
  const counts = getOrCreateCounts(runId);
  counts[service] = Math.max(0, (counts[service] ?? 0) - 1);
  emitCurrentServices(runId);
}

/** Reset all service counts to zero and emit */
export function resetServices(runId: string) {
  const counts = getOrCreateCounts(runId);
  for (const k of SERVICE_KEYS) counts[k] = 0;
  emitCurrentServices(runId);
}

/** Get the current boolean service state for a run (for SSE replay) */
export function getCurrentServiceState(runId: string): Record<string, boolean> | null {
  if (!runServiceCounts.has(runId)) return null;
  const counts = getOrCreateCounts(runId);
  const payload: Record<string, boolean> = {};
  for (const k of SERVICE_KEYS) {
    payload[k] = (counts[k] ?? 0) > 0;
  }
  return payload;
}

/** Clean up tracking data for a completed run */
export function cleanupRunServices(runId: string) {
  runServiceCounts.delete(runId);
}
