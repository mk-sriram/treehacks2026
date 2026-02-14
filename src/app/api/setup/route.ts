import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { createIndex } from '@/lib/elastic';

export async function GET() {
  const results: Record<string, any> = {};

  // 1. Verify Postgres connection
  try {
    await prisma.$queryRaw`SELECT 1`;
    results.postgres = { ok: true };
  } catch (err: any) {
    results.postgres = { ok: false, error: err.message };
  }

  // 2. Create Elasticsearch index (idempotent)
  try {
    const esResult = await createIndex();
    results.elasticsearch = { ok: true, ...esResult };
  } catch (err: any) {
    results.elasticsearch = { ok: false, error: err.message };
  }

  const allOk = results.postgres?.ok && results.elasticsearch?.ok;

  return NextResponse.json(results, { status: allOk ? 200 : 500 });
}
