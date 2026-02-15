import { eventBus, getCurrentServiceState } from '@/lib/events';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;
  console.log(`[API /api/run/${runId}/events] SSE connection opened`);

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Send initial keepalive
      controller.enqueue(encoder.encode(': connected\n\n'));

      const handler = (event: Record<string, any>) => {
        try {
          const data = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(data));
          console.log(`[API SSE] Sent event to client: type=${event.type}`);
        } catch {
          // Stream may be closed
        }
      };

      eventBus.on(`run:${runId}`, handler);
      console.log(`[API SSE] Subscribed to eventBus for run:${runId}`);

      // Replay current service state to handle the race condition where
      // the orchestrator emitted events before this SSE connection opened
      const currentServices = getCurrentServiceState(runId);
      if (currentServices) {
        handler({ type: 'services_change', payload: currentServices });
        console.log(`[API SSE] Replayed current service state for run:${runId}`);
      }

      // Keepalive every 15s to prevent timeouts
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          clearInterval(keepalive);
        }
      }, 15000);

      // Cleanup on disconnect
      req.signal.addEventListener('abort', () => {
        console.log(`[API SSE] Client disconnected for run:${runId}`);
        eventBus.off(`run:${runId}`, handler);
        clearInterval(keepalive);
        try {
          controller.close();
        } catch {
          // Already closed
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
