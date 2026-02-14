import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { runOrchestrator } from '@/lib/orchestrator';

export async function POST(req: Request) {
  try {
    const body = await req.json();

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

    // Fire-and-forget: start the orchestrator in the background
    // We don't await this -- it runs async and emits SSE events
    void runOrchestrator(run.id);

    return NextResponse.json({ runId: run.id });
  } catch (err: any) {
    console.error('POST /api/run error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
