import { neonConfig } from '@neondatabase/serverless';
import { PrismaNeon } from '@prisma/adapter-neon';
import { PrismaClient } from '@prisma/client';
import ws from 'ws';

// WebSocket is needed for the Neon serverless driver
neonConfig.webSocketConstructor = ws;

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

function createPrismaClient() {
  console.log('[DB] Creating Prisma client with Neon adapter...');
  console.log('[DB] DATABASE_URL present:', !!process.env.DATABASE_URL);
  const adapter = new PrismaNeon({
    connectionString: process.env.DATABASE_URL!,
  });
  const client = new PrismaClient({ adapter } as any);
  console.log('[DB] Prisma client created successfully');
  return client;
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
