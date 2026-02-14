# Procurement Voice Agents: Infra + Memory Plan (Perplexity Sonar + ElevenLabs + Postgres + Elastic Cloud)

## 0) Goal

Build a multi-user procurement workflow that:
- **Discovers** suppliers and contact info from the web (Perplexity Sonar)
- **Calls** suppliers to request quotes (ElevenLabs + Twilio)
- **Extracts** structured terms (price, MOQ, lead time, validity, payment)
- **Stores truth** durably (Postgres)
- **Stores memory** for fast semantic recall (Elasticsearch on Elastic Cloud)
- **Improves** outreach and ranking over time by retrieving prior interactions before each new outreach

---

## 1) Core systems and responsibilities

### 1.1 Postgres = system of record (truth + state)
Postgres stores anything that must be consistent, auditable, and updatable:
- Workflow state machine (`runs.status`)
- Canonical vendor records (`vendors`)
- Canonical offer objects (`offers`)
- The “timeline” UI stream (`events`)
- Outreach artifacts (`calls`, `emails`)
- Purchase execution (`purchases`)

Suggested minimum schema (matches your current design):
- `runs(id, raw_query, parsed_spec, status, created_at, updated_at)`
- `vendors(id, run_id, name, url, phone, email, source, metadata_json, created_at)`
- `offers(id, vendor_id, unit_price, total_price, delivery_days, validity, confidence, evidence_ref, created_at)`
- `events(id, run_id, stage, payload_json, created_at)`
- `calls(id, vendor_id, conversation_id, transcript, quoted_total, duration, created_at)`
- `emails(id, vendor_id, thread_id, subject, body, status, created_at)`
- `purchases(id, offer_id, method, tx_hash, status, created_at)`

Add multi-user tenancy:
- Add `org_id` and `user_id` to `runs` (and cascade via FK or copy to child tables).
- Enforce row-level access in application logic (or Postgres RLS if you have it).

### 1.2 Elasticsearch (Elastic Cloud) = long-term memory index (retrieval)
Elasticsearch stores documents optimized for:
- **Hybrid retrieval** (keyword + vector similarity + filters)
- **Fast top‑K recall** (build `OutreachContext` in <~100ms)
- Vendor behavior history across many runs

You keep the canonical “truth” in Postgres, but index useful text + derived notes for retrieval in Elasticsearch.

---

## 2) Data flow: read path vs write path

### 2.1 Read path (“long-term memory → short-term context”)
Before any outreach (call/email), build an `OutreachContext`:

1) **Postgres read**
- Run spec (`runs.parsed_spec`)
- Current vendor record (scraped info, known constraints)
- Competing offers in this run
- The current workflow stage

2) **Elasticsearch read**
- Retrieve semantically relevant prior interactions:
  - past transcripts with this vendor
  - similar items (e.g., “tungsten rod”) across vendors
  - vendor reliability notes (late delivery, surprise fees, etc.)

3) **Assemble `OutreachContext`**
A compact object for the agent:
- Must include: “what to ask”, “walkaway price”, “deadline”, “historical vendor behavior”, “prior terms”
- Must exclude: large raw text. Provide top‑K snippets + short summaries.

4) Use `OutreachContext` for:
- Injecting into ElevenLabs dynamic variables
- Grounding the RFQ email content
- Ranking / scoring logic

### 2.2 Write path (“new evidence → long-term truth + long-term memory”)
After outreach:

1) Webhook arrives with transcript (post-call)
2) Extract structured facts (LLM extraction)
3) Write structured facts + state to Postgres (truth)
4) Write transcript + derived notes to Elasticsearch (memory)
5) Emit `events` rows for SSE UI updates

---

## 3) APIs: what gets called and why

## 3.1 Perplexity Sonar API (web-grounded discovery)
Purpose:
- Find supplier candidates for an item and constraints
- Extract: supplier name, website, phone/email, indicative pricing, lead time, certifications
- Preserve citations so results are auditable

Implementation approach:
- Use Sonar chat completions to produce a *structured vendor-candidate list*.
- Parse response `citations` / `search_results` for provenance; store into Postgres fields like `source`, `evidence_ref`, `confidence`.

Recommended pattern for discovery:
- Prompt: “Return a JSON array of vendor candidates with fields {name,url,phone,email,source_url,notes,confidence}”.
- Use response `citations` or `search_results` rather than asking the model to embed links inside JSON.

## 3.2 ElevenLabs Agents + Twilio outbound calls
Purpose:
- Make a phone call on behalf of the user to request/confirm quote details.
- Post-call webhook returns transcript for extraction + memory write-back.

Implementation approach:
- When ready to call:
  - Build `OutreachContext`
  - POST to ElevenLabs “Outbound call via Twilio” endpoint
  - Include `dynamic_variables` / client data containing `runId`, `vendorId`, and key constraints
- When call completes:
  - Receive `post_call_transcription` webhook
  - Verify signature
  - Store transcript and extracted terms

Critical details:
- Always verify HMAC signature on webhooks.
- Return HTTP 200 quickly; don’t do slow work inline—queue it if needed.

## 3.3 Elastic Cloud (hosted Elasticsearch + Kibana)
Purpose:
- Managed Elasticsearch cluster so you don’t run servers in a hackathon.
- Store embeddings + metadata for retrieval.
- Optionally generate embeddings inside Elastic via inference endpoints + ingest pipelines.

Implementation approach:
- Create an Elastic Cloud deployment; get:
  - Elasticsearch endpoint (or Cloud ID)
  - API key for your app
- Create indices and mappings (dense_vector + keyword fields)
- Create ingest pipeline to embed on write (optional)
- Query with kNN/hybrid search + filters

---

## 4) Coding infra: services/modules (high level)

### 4.1 Runtime units
- **Next.js API routes** (or a Node service) as orchestrator
- **Postgres** for transactional persistence
- **Elasticsearch** for memory index
- Optional: background worker/queue for long tasks

For hackathon simplicity, you can run without a queue if you keep webhook handler fast and offload heavy work with:
- `setImmediate` + async tasks, or
- a minimal in-memory queue, or
- a serverless queue service if deployed

### 4.2 Suggested internal module layout (TypeScript)
- `lib/perplexity.ts` — Sonar API client + vendor candidate parser
- `lib/elevenlabs.ts` — outbound call trigger; webhook signature verification
- `lib/db.ts` — Postgres client + typed queries
- `lib/elastic.ts` — Elastic Cloud client + index/pipeline helpers
- `lib/memory.ts` — writeTranscript/writeEmailThread/retrieveRelevantMemory
- `lib/outreach.ts` — assembleOutreachContext + channel selection logic
- `lib/events.ts` — emitEvent(runId, stage, payload) helper for SSE timeline

---

## 5) Workflow endpoints (low level)

### 5.1 Start + clarification loop
`POST /api/procure/start`
- Input: `raw_query`
- Action: LLM parses into `ProcurementSpec`
- If missing required fields: return `needs_clarification` with questions
- Else: create `runs` row with `status=ready`, return `run_id`

### 5.2 Discovery
`POST /api/procure/:runId/discover`
- Input: none or optional hints
- Action:
  1) Load `runs.parsed_spec`
  2) Call Perplexity Sonar to return vendor candidates + citations
  3) Insert vendors into `vendors` with `source=sonar`
  4) Emit event `vendors_discovered`

### 5.3 Scrape vendor site
`POST /api/procure/:runId/vendor/:vendorId/scrape`
- Action:
  1) Fetch vendor URL
  2) Extract pricing/contact info/terms
  3) Update vendor record in Postgres
  4) Emit event `vendor_scraped`
  5) Optionally write a short “site note” into Elasticsearch for later retrieval

### 5.4 Assemble context (shared helper)
`assembleOutreachContext(runId, vendorId)`
- Loads:
  - Postgres: run spec, vendor, competing offers
  - Elasticsearch: top‑K memory docs filtered by vendor_id and/or item family
- Outputs:
  - `OutreachContext` object (short; includes citations/evidence refs)

### 5.5 Call vendor (ElevenLabs + Twilio)
`POST /api/procure/:runId/vendor/:vendorId/call`
- Action:
  1) context = assembleOutreachContext()
  2) POST to ElevenLabs Twilio outbound call endpoint
  3) Insert a `calls` row with pending status and the returned conversation id
  4) Emit event `call_started`

### 5.6 Webhook: transcript write-back
`POST /api/webhooks/elevenlabs`
- Action:
  1) Verify signature (HMAC)
  2) Parse `post_call_transcription` payload
  3) Map transcript → the correct `runId/vendorId` (from client data / dynamic variables)
  4) Store transcript into Postgres (`calls.transcript`)
  5) Extract offer terms via LLM; upsert into `offers`
  6) Index transcript + extracted facts into Elasticsearch
  7) Emit event `call_transcribed` and `offer_extracted`

### 5.7 Rank
`POST /api/procure/:runId/rank`
- Loads all offers and scores them.
- Uses Elasticsearch memory for reliability signals (optional) and Postgres for transactional constraints.
- Writes event `ranked`.

### 5.8 SSE events
`GET /api/procure/:runId/events`
- Streams rows from `events` to UI (server-sent events)

---

## 6) Elasticsearch: index design for procurement memory

### 6.1 Indices
Use separate indices to keep document shapes clean:
- `proc_call_transcripts` — call transcripts (chunked or whole)
- `proc_email_threads` — email bodies + thread summaries
- `proc_offer_facts` — extracted offer facts as short text docs + structured fields
- `proc_vendor_memory` — vendor notes and behavior stats

### 6.2 Common fields (required in every doc)
To support filters and multi-user isolation:
- `org_id` (keyword)
- `run_id` (keyword)
- `vendor_id` (keyword)
- `channel` (keyword: call/email/site)
- `created_at` (date)
- `text` (text)
- `evidence_ref` (keyword: points to Postgres row IDs)

### 6.3 Vector fields
Add one embedding field per index, e.g.:
- `embedding` as `dense_vector` with `index: true` for kNN.

### 6.4 Chunking strategy (practical)
- Chunk transcripts into 200–500 tokens (or ~1–2 minutes of speech)
- Store:
  - `chunk_id`, `chunk_index`, `start_ms`, `end_ms`
  - `speaker` metadata if available

This prevents retrieval from pulling a single massive transcript when you only need one snippet.

---

## 7) Elastic: embedding options

### Option A (simple): BYO embeddings
- Your app calls an embedding model (OpenAI, etc.)
- You write `{ text, embedding }` to Elasticsearch

Pros: works everywhere.
Cons: more moving parts + API calls.

### Option B (cleaner on Elastic Cloud): embeddings on write
- Create an inference endpoint (Jina embeddings)
- Attach an ingest pipeline that runs inference on incoming docs
- Your app only writes plain `text`, Elastic fills `embedding`.

This matches your “Jina auto-embeds via inference pipeline” approach.

---

## 8) Retrieval query pattern (hybrid + filters)

### 8.1 Retrieval policy (what you want)
- Filter hard by `org_id` and usually `vendor_id`
- Bias towards recency (last 6–12 months)
- Use a hybrid scoring approach:
  - vector similarity on `embedding`
  - lexical match on `text` for exact terms (standards, part numbers)

### 8.2 Practical approach for hackathon
Start with:
- vector kNN + filter on `vendor_id` and `org_id`
Then add lexical match later if needed.

---

## 9) Reliability memory used in ranking (how it fits)

You can compute reliability as a blend of:
- Postgres truth: deliveries marked successful vs incidents recorded
- Elastic memory: response behavior and negotiation behavior derived from past transcripts/emails

Implementation pattern:
- Maintain vendor stats in Postgres (fast + consistent)
- Store behavior notes and derived text in Elastic for retrieval and for “explainability” in UI.

---

## 10) Multi-user + multi-run isolation (must-haves)

### 10.1 Keys and scoping
Every Postgres row and every Elastic document must carry:
- `org_id` and `run_id`
Most queries must filter by both.

### 10.2 API auth
- Users must be authenticated (whatever you use in the app)
- API routes derive `org_id/user_id` from session
- Never accept `org_id` from the client directly

### 10.3 Rate limits and abuse control
- Per-user limit for:
  - Sonar searches per run
  - calls per run
  - emails per run

---

## 11) Concrete implementation steps (order of operations)

1) Postgres: finalize schema + migrations
2) Perplexity Sonar: implement `/discover`
3) Elastic Cloud:
   - Create deployment
   - Create API key
   - Create indices + mappings
   - (Optional) Create inference endpoint + pipeline
4) Memory:
   - `writeTranscript()` to Elastic
   - `retrieveRelevantMemory()` from Elastic
5) Outreach:
   - `assembleOutreachContext()`
   - ElevenLabs outbound call endpoint integration
6) Webhook:
   - signature verification
   - transcript -> Postgres
   - extraction -> offers
   - index -> Elastic
7) UI timeline:
   - write events + SSE streaming
8) Rank endpoint:
   - price/deadline constraints from Postgres
   - reliability signals from memory + Postgres

---

## 12) Reference API endpoints (summary)

### Perplexity Sonar
- `POST https://api.perplexity.ai/chat/completions` (OpenAI-compatible chat completions)

### ElevenLabs
- `POST https://api.elevenlabs.io/v1/convai/twilio/outbound-call` (outbound calls via Twilio)
- Post-call webhook event type: `post_call_transcription`

### Elasticsearch / Elastic Cloud
- API key auth header: `Authorization: ApiKey <encoded>`
- Vector search: kNN option in the search API
- Dense vector mapping: `dense_vector`
- Ingest pipelines: pipelines + processors
- Inference endpoint for Jina: `PUT /_inference/{task_type}/{id}`

---

## 13) Appendix: sample HTTP snippets (templates)

### A) Perplexity Sonar chat completions
```bash
curl -X POST "https://api.perplexity.ai/chat/completions" \
  -H "Authorization: Bearer $PPLX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sonar-pro",
    "messages": [
      {"role":"system","content":"Return a JSON array of vendor candidates with name,url,phone,email,source_url,notes,confidence."},
      {"role":"user","content":"Find suppliers for tungsten rod, 99.95% purity, ship to Stanford CA by Feb 18, budget $1000."}
    ]
  }'
```

### B) ElevenLabs outbound call via Twilio
```bash
curl -X POST "https://api.elevenlabs.io/v1/convai/twilio/outbound-call" \
  -H "xi-api-key: $ELEVENLABS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "YOUR_AGENT_ID",
    "phone_number": "+14155550123",
    "from_number": "+14155550999",
    "conversation_initiation_client_data": {
      "dynamic_variables": {
        "runId": "run_abc123",
        "vendorId": "vendor_xyz789",
        "item": "tungsten rod, 99.95%",
        "deadline_iso": "2026-02-18T08:00:00-08:00",
        "budget": "1000 USD"
      }
    }
  }'
```

### C) Elasticsearch API key auth example
```bash
curl -X GET "$ES_URL/_cat/indices?v=true" \
  -H "Authorization: ApiKey $ELASTIC_API_KEY"
```

---

## 14) References (official docs)
```text
Perplexity Sonar API (Chat Completions): https://docs.perplexity.ai/api-reference/chat-completions-post
Perplexity Sonar Quickstart: https://docs.perplexity.ai/docs/sonar/quickstart
Perplexity OpenAI compatibility (Sonar): https://docs.perplexity.ai/docs/sonar/openai-compatibility
Perplexity Sonar features (citations/search_results guidance): https://docs.perplexity.ai/docs/sonar/features

ElevenLabs: Outbound call via Twilio: https://elevenlabs.io/docs/eleven-agents/api-reference/twilio/outbound-call
ElevenLabs: Post-call webhooks (post_call_transcription + signature verification): https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks
ElevenLabs: Webhooks overview (return 200 quickly): https://elevenlabs.io/docs/overview/administration/webhooks
ElevenLabs Agents overview: https://elevenlabs.io/docs/eleven-agents/overview

Elastic Cloud Hosted overview: https://www.elastic.co/docs/deploy-manage/deploy/elastic-cloud/cloud-hosted
Find Cloud ID: https://www.elastic.co/docs/deploy-manage/deploy/elastic-cloud/find-cloud-id
Elasticsearch API authentication (ApiKey header): https://www.elastic.co/docs/api/doc/elasticsearch/authentication
Dense vector mapping: https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/dense-vector
kNN vector search: https://www.elastic.co/docs/solutions/search/vector/knn
Ingest pipelines: https://www.elastic.co/docs/manage-data/ingest/transform-enrich/ingest-pipelines
Inference processor (ingest): https://www.elastic.co/docs/reference/enrich-processor/inference-processor
Create JinaAI inference endpoint: https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-inference-put-jinaai
Elastic Inference Service: https://www.elastic.co/docs/explore-analyze/elastic-inference/eis
Jina embeddings v3 on Elastic Inference Service (blog): https://www.elastic.co/search-labs/blog/jina-embeddings-v3-elastic-inference-service
```
