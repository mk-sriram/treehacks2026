import { Client } from '@elastic/elasticsearch';

const client = new Client({
  node: process.env.ELASTIC_URL!,
  auth: { apiKey: process.env.ELASTIC_SECRET! },
});

const INDEX_NAME = 'proc_memory';

// Called once via /api/setup
export async function createIndex() {
  const exists = await client.indices.exists({ index: INDEX_NAME });
  if (exists) return { created: false, message: 'Index already exists' };

  await client.indices.create({
    index: INDEX_NAME,
    mappings: {
      properties: {
        text:       { type: 'semantic_text' as any },
        run_id:     { type: 'keyword' },
        vendor_id:  { type: 'keyword' },
        channel:    { type: 'keyword' },  // "search" | "call" | "note"
        created_at: { type: 'date' },
      },
    },
  });

  return { created: true, message: 'Index created' };
}

// Write a memory document
export async function writeMemory(doc: {
  text: string;
  run_id: string;
  vendor_id?: string;
  channel: string;
  created_at?: string;
}) {
  await client.index({
    index: INDEX_NAME,
    document: {
      ...doc,
      created_at: doc.created_at ?? new Date().toISOString(),
    },
    timeout: '5m', // semantic_text may need model warmup on first call
  });
}

// Retrieve relevant memories
export async function retrieveMemory(
  query: string,
  filters: { vendor_id?: string; run_id?: string } = {}
) {
  const must: any[] = [];
  if (filters.vendor_id) must.push({ term: { vendor_id: filters.vendor_id } });
  if (filters.run_id)    must.push({ term: { run_id: filters.run_id } });

  return client.search({
    index: INDEX_NAME,
    body: {
      retriever: {
        standard: {
          query: {
            bool: {
              must: [
                { semantic: { field: 'text', query } },
                ...must,
              ],
            },
          },
        },
      },
      size: 5,
    },
  });
}

export { client as esClient };
