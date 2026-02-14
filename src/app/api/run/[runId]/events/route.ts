import { eventBus } from '@/lib/events';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Send initial keepalive
      controller.enqueue(encoder.encode(': connected\n\n'));

      const handler = (event: Record<string, any>) => {
        try {
          const data = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(data));
        } catch {
          // Stream may be closed
        }
      };

      eventBus.on(`run:${runId}`, handler);

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
