import { Client } from '@elastic/elasticsearch';

const client = new Client({
    node: process.env.ELASTIC_URL!,
    auth: { apiKey: process.env.ELASTIC_SECRET! },
});

const INDEX_NAME = 'proc_memory';

console.log('[ES] Elasticsearch client initialized. ELASTIC_URL present:', !!process.env.ELASTIC_URL, '| ELASTIC_SECRET present:', !!process.env.ELASTIC_SECRET);

// Called once via /api/setup
export async function createIndex() {
    console.log('[ES] createIndex() called — checking if index exists...');
    const exists = await client.indices.exists({ index: INDEX_NAME });
    if (exists) {
        console.log('[ES] Index already exists, skipping creation');
        return { created: false, message: 'Index already exists' };
    }

    console.log('[ES] Creating index with semantic_text mapping...');
    await client.indices.create({
        index: INDEX_NAME,
        mappings: {
            properties: {
                text: { type: 'semantic_text' as any },
                run_id: { type: 'keyword' },
                vendor_id: { type: 'keyword' },
                channel: { type: 'keyword' },  // "search" | "call" | "note"
                created_at: { type: 'date' },
            },
        },
    });

    console.log('[ES] Index created successfully');
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
    console.log(`[ES] writeMemory() called — run_id=${doc.run_id}, channel=${doc.channel}, text length=${doc.text.length}`);
    await client.index({
        index: INDEX_NAME,
        document: {
            ...doc,
            created_at: doc.created_at ?? new Date().toISOString(),
        },
        timeout: '5m', // semantic_text may need model warmup on first call
    });
    console.log(`[ES] writeMemory() complete — run_id=${doc.run_id}`);
}

// Retrieve relevant memories using hybrid search (BM25 + semantic, RRF-ranked)
export async function retrieveMemory(
    query: string,
    filters: { vendor_id?: string; run_id?: string } = {}
) {
    console.log(`[ES] retrieveMemory() called — query="${query.slice(0, 80)}...", filters=`, filters);
    const filterClauses: any[] = [];
    if (filters.vendor_id) filterClauses.push({ term: { vendor_id: filters.vendor_id } });
    if (filters.run_id) filterClauses.push({ term: { run_id: filters.run_id } });

    return client.search({
        index: INDEX_NAME,
        retriever: {
            rrf: {
                retrievers: [
                    // Retriever 1: BM25 keyword match
                    {
                        standard: {
                            query: {
                                bool: {
                                    must: [{ match: { text: { query } } }],
                                    filter: filterClauses,
                                },
                            },
                        },
                    },
                    // Retriever 2: Semantic (vector) search on the semantic_text field
                    {
                        standard: {
                            query: {
                                bool: {
                                    must: [{ semantic: { field: 'text', query } }],
                                    filter: filterClauses,
                                },
                            },
                        },
                    },
                ],
                rank_window_size: 20,
                rank_constant: 60,
            },
        } as any,
        size: 5,
    });
}

export { client as esClient };
