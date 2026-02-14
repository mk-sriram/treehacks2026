import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { createIndex } from '@/lib/elastic';

export async function GET() {
  console.log(`[API /api/setup] Setup check started`);
  const results: Record<string, any> = {};

  // 1. Verify Postgres connection
  try {
    console.log(`[API /api/setup] Testing Postgres connection...`);
    await prisma.$queryRaw`SELECT 1`;
    results.postgres = { ok: true };
    console.log(`[API /api/setup] Postgres: OK`);
  } catch (err: any) {
    results.postgres = { ok: false, error: err.message };
    console.error(`[API /api/setup] Postgres: FAILED —`, err.message);
  }

  // 2. Create Elasticsearch index (idempotent)
  try {
    console.log(`[API /api/setup] Creating/checking Elasticsearch index...`);
    const esResult = await createIndex();
    results.elasticsearch = { ok: true, ...esResult };
    console.log(`[API /api/setup] Elasticsearch:`, esResult);
  } catch (err: any) {
    results.elasticsearch = { ok: false, error: err.message };
    console.error(`[API /api/setup] Elasticsearch: FAILED —`, err.message);
  }

  const allOk = results.postgres?.ok && results.elasticsearch?.ok;
  console.log(`[API /api/setup] Setup result: ${allOk ? 'ALL OK' : 'SOME FAILED'}`, results);

  return NextResponse.json(results, { status: allOk ? 200 : 500 });
}
