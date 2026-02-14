import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { runOrchestrator } from '@/lib/orchestrator';

export async function POST(req: Request) {
  console.log(`[API /api/run] POST request received`);
  try {
    const body = await req.json();
    console.log(`[API /api/run] Request body:`, JSON.stringify(body));

    // body is the RFQ: { item, quantity, leadTime, quality, location }
    const run = await prisma.run.create({
      data: {
        rawQuery: body.item ?? '',
        parsedSpec: {
          item: body.item ?? '',
          quantity: body.quantity ?? '',
          leadTime: body.leadTime ?? '',
          quality: body.quality ?? '',
          location: body.location ?? '',
        },
        status: 'pending',
      },
    });
    console.log(`[API /api/run] Run created in Postgres — runId=${run.id}`);

    // Fire-and-forget: start the orchestrator in the background
    // We don't await this -- it runs async and emits SSE events
    void runOrchestrator(run.id);
    console.log(`[API /api/run] Orchestrator kicked off (fire-and-forget). Returning runId.`);

    return NextResponse.json({ runId: run.id });
  } catch (err: any) {
    console.error('[API /api/run] POST error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
