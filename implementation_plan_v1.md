# Agentic Procurement Platform — Backend Implementation Plan

## Problem Summary

Build the backend for an AI-powered procurement system. A user submits a natural-language request (e.g. *"Get me $1000 worth of tungsten by Wednesday morning to Stanford campus"*). The platform autonomously:

1. **Extracts** structured constraints (item, budget, deadline, location)
2. **Discovers** vendors via Perplexity Sonar
3. **Scrapes** vendor websites via Browserbase Stagehand
4. **Negotiates** via phone (ElevenLabs) or email (Resend)
5. **Stores** all interactions in long-term memory (Elasticsearch)
6. **Ranks** offers with weighted scoring
7. **Optionally auto-purchases** via Coinbase x402
8. **Reports** a full structured run summary with audit trail

> [!IMPORTANT]
> **Frontend is a placeholder only** — the user's teammate owns the frontend. We will create a single minimal page that proves the API works.

---

## Technology Stack

| Layer | Technology | Purpose |
|---|---|---|
| Host / API | **Next.js App Router on Vercel** | Serverless route handlers |
| LLM Orchestration | **OpenAI** | Structured extraction, routing, final reports |
| Web Discovery | **Perplexity Sonar API** | Grounded vendor search with citations |
| Website Actions | **Browserbase + Stagehand** | Observe / extract / act on vendor pages |
| Voice Negotiation | **ElevenLabs Agents + Twilio** | Multi-turn outbound phone calls |
| Email Outreach | **Resend API** | RFQ emails when phone unavailable |
| Long-term Memory | **Elastic Cloud** | Hybrid vector + metadata retrieval (semantic text + embeddings) |
| Operational DB | **Vercel Postgres** | Runs, offers, events, vendors, payments (structured transactional data) |
| Payment | **Coinbase x402** | Programmatic stablecoin purchase |

---

## User Review Required

> [!WARNING]
> **API keys needed before execution.** You will need to provide (or set as env vars in Vercel) keys for: OpenAI, Perplexity, Browserbase/Stagehand, ElevenLabs, Elastic Cloud, Resend, and optionally Coinbase. I will scaffold `.env.example` with all required vars.

> [!IMPORTANT]
> **Hosting:** Everything runs on **Vercel** — Vercel Postgres for the operational DB, Elastic Cloud for semantic memory, Vercel serverless functions for all API routes.

---

## Proposed Changes

### Phase 1 — Project Skeleton & Core Orchestration

#### [NEW] Project initialization

- `npx create-next-app@latest ./` with App Router, TypeScript, ESLint
- Install dependencies: `openai`, `@vercel/postgres`, `@elastic/elasticsearch`, `uuid`
- Create `.env.example` listing all required API keys

#### [NEW] [schema.sql](file:///Users/andrewfong/Downloads/treehacks2026/db/schema.sql)

PostgreSQL schema with tables:

| Table | Purpose |
|---|---|
| `runs` | Top-level procurement run (id, raw_query, parsed_spec, status, timestamps) |
| `vendors` | Discovered vendor candidates (run_id, name, url, phone, email, source) |
| `offers` | Normalized offers (vendor_id, unit_price, total_price, delivery_days, validity, confidence, evidence_ref) |
| `events` | Stage-transition log for SSE timeline (run_id, stage, payload, timestamp) |
| `calls` | ElevenLabs call records (vendor_id, transcript, quoted_total, duration) |
| `emails` | Email thread records (vendor_id, subject, body, status) |
| `purchases` | Payment execution records (offer_id, method, tx_hash, status) |

#### [NEW] [route.ts](file:///Users/andrewfong/Downloads/treehacks2026/src/app/api/procure/start/route.ts)

`POST /api/procure/start` — accepts raw query string, calls OpenAI for structured extraction into a `ProcurementSpec` JSON object.

**Clarification loop:** The endpoint checks whether all **required fields** are populated. If any are missing or ambiguous, it returns a `status: "needs_clarification"` response with specific follow-up questions. The frontend reprompts the user and re-submits. This loop repeats until the spec is complete. Only then does the run enter `status: "ready"` and get stored in the DB.

**Required procurement fields (all must be resolved before proceeding):**

| # | Field | Type | Description | Example |
|---|---|---|---|---|
| 1 | `item` | string | What to procure — must be specific enough to search vendors | `"tungsten rod, 99.95% purity"` |
| 2 | `budget` | `{ amount, currency }` | Maximum spend — must have a numeric amount and currency | `{ "amount": 1000, "currency": "USD" }` |
| 3 | `deadline_iso` | ISO 8601 datetime | When the item must arrive by — must be a concrete date/time, not vague | `"2026-02-18T08:00:00-08:00"` |
| 4 | `delivery_location` | string | Where to deliver — must be a real address or recognizable location | `"Stanford Campus, 450 Serra Mall, CA 94305"` |
| 5 | `quantity` | number \| null | How many/how much — if the item is countable, this must be specified; null only if budget implicitly defines quantity (e.g. "$1000 worth of") | `5` or `null` |
| 6 | `quality_constraints` | string[] | Any specs, grades, certifications, or material requirements | `["99.95% purity", "ASTM B760"]` |
| 7 | `auto_purchase` | boolean | Whether the system is authorized to buy autonomously or must ask first | `false` |

**Clarification response contract:**
```json
{
  "status": "needs_clarification",
  "parsed_so_far": {
    "item": "tungsten",
    "budget": { "amount": 1000, "currency": "USD" },
    "deadline_iso": null,
    "delivery_location": "Stanford Campus, CA",
    "quantity": null,
    "quality_constraints": [],
    "auto_purchase": null
  },
  "questions": [
    "When do you need this delivered by? Please provide a specific date and time.",
    "Do you need a specific quantity, or should I maximize what $1000 can buy?",
    "Are there any purity, grade, or certification requirements?",
    "Should I auto-purchase the best option, or present recommendations for your approval first?"
  ]
}
```

**Ready response contract:**
```json
{
  "status": "ready",
  "run_id": "run_abc123",
  "spec": {
    "item": "tungsten rod, 99.95% purity",
    "budget": { "amount": 1000, "currency": "USD" },
    "deadline_iso": "2026-02-18T08:00:00-08:00",
    "delivery_location": "Stanford Campus, 450 Serra Mall, CA 94305",
    "quantity": null,
    "quality_constraints": ["99.95% purity"],
    "auto_purchase": false
  },
  "confidence": 0.95
}
```

#### [NEW] [route.ts](file:///Users/andrewfong/Downloads/treehacks2026/src/app/api/procure/[runId]/events/route.ts)

`GET /api/procure/:runId/events` — SSE endpoint. Polls `events` table and streams `RunEvent` objects to the client in real time.

#### [NEW] [page.tsx](file:///Users/andrewfong/Downloads/treehacks2026/src/app/page.tsx)

Minimal placeholder frontend: a text input + submit button that calls `/api/procure/start` and displays the returned `run_id`. **This is a stub** — the real UI will be swapped in by a teammate.

#### [NEW] Shared types & utilities

- `src/lib/types.ts` — TypeScript interfaces (`ProcurementSpec`, `Vendor`, `Offer`, `RunEvent`, `OutreachContext`, etc.)
- `src/lib/db.ts` — Vercel Postgres client (uses `@vercel/postgres`)
- `src/lib/openai.ts` — OpenAI client wrapper with structured output helpers
- `src/lib/events.ts` — `emitEvent(runId, stage, payload)` helper

---

### Phase 2 — Discovery & Site Inspection

#### [NEW] [route.ts](file:///Users/andrewfong/Downloads/treehacks2026/src/app/api/procure/[runId]/discover/route.ts)

`POST /api/procure/:runId/discover` — calls Perplexity Sonar API (`POST https://api.perplexity.ai/chat/completions`, model `sonar` or `sonar-pro` based on complexity heuristic). Parses citations/search_results. Inserts vendor candidates into `vendors` table.

#### [NEW] [route.ts](file:///Users/andrewfong/Downloads/treehacks2026/src/app/api/procure/[runId]/vendor/[vendorId]/scrape/route.ts)

`POST /api/procure/:runId/vendor/:vendorId/scrape` — uses Stagehand to `goto` vendor URL, `observe` the page, and `extract` structured data (price, MOQ, ETA, payment methods, contact info). Updates vendor record.

#### [NEW] Perplexity & Stagehand client wrappers

- `src/lib/perplexity.ts` — Sonar API call + response parser
- `src/lib/stagehand.ts` — Browserbase session management + extraction helpers

---

### Phase 3 — Outreach Integration (Memory-Augmented)

> [!IMPORTANT]
> **Context-loading before every outreach action.** Both call and email endpoints first assemble an `OutreachContext` by:
> 1. **Elasticsearch read** — retrieve semantically similar past interactions (prior quotes, negotiation transcripts, vendor behavior notes) via hybrid kNN + filter query
> 2. **PostgreSQL read** — load structured transactional data (current run spec, this vendor's scraped data, competing offers from other vendors in same run, prior offer history)
> 3. Both are merged into a single `OutreachContext` object and fed to the ElevenLabs agent (as dynamic variables) or used to compose the email body.

> [!IMPORTANT]
> **Write-back after every outreach action.** After a call or email completes:
> 1. The transcript / email content is written to Elasticsearch — **Jina embeddings are generated automatically** via the Elastic Inference API ingest pipeline (no separate embedding call needed)
> 2. Written to Elasticsearch indices (`proc_call_transcripts` or `proc_email_threads`) with auto-generated embedding + metadata
> 3. Any extracted offer facts are written to `proc_offer_facts` index
> 4. Vendor behavior notes are updated in `proc_vendor_memory`
> 5. Structured records (call/email/offer rows) are written to PostgreSQL

#### [NEW] [route.ts](file:///Users/andrewfong/Downloads/treehacks2026/src/app/api/procure/[runId]/vendor/[vendorId]/call/route.ts)

`POST /api/procure/:runId/vendor/:vendorId/call` — **Step 1:** calls `assembleOutreachContext()` to load from Elasticsearch + PostgreSQL. **Step 2:** triggers ElevenLabs outbound call via `POST /v1/convai/twilio/outbound-call` with context injected as dynamic variables. **Step 3:** stores call record in PostgreSQL.

#### [NEW] [route.ts](file:///Users/andrewfong/Downloads/treehacks2026/src/app/api/procure/[runId]/vendor/[vendorId]/email/route.ts)

`POST /api/procure/:runId/vendor/:vendorId/email` — **Step 1:** calls `assembleOutreachContext()` to load from Elasticsearch + PostgreSQL. **Step 2:** uses OpenAI to compose a context-aware RFQ email grounded in prior interactions. **Step 3:** sends via Resend API. **Step 4:** writes the sent email to Elasticsearch (Jina auto-embeds via inference pipeline) + PostgreSQL.

#### [NEW] [route.ts](file:///Users/andrewfong/Downloads/treehacks2026/src/app/api/webhooks/elevenlabs/route.ts)

`POST /api/webhooks/elevenlabs` — receives post-call webhook from ElevenLabs. **Step 1:** parses transcript. **Step 2:** extracts quoted price/terms via OpenAI. **Step 3:** writes transcript to Elasticsearch (auto-embedded by Jina inference pipeline into `proc_call_transcripts` + `proc_offer_facts`). **Step 4:** updates PostgreSQL call record and creates an Offer row.

#### [NEW] Outreach helpers

- `src/lib/elevenlabs.ts` — ElevenLabs agent creation + outbound call trigger
- `src/lib/email.ts` — Resend email helper + context-aware RFQ composer
- `src/lib/outreach.ts` — Channel selector logic + `assembleOutreachContext()` function

---

### Phase 4 — Memory & Ranking

> [!NOTE]
> Elasticsearch setup and memory helpers are built in Phase 2-3 implicitly (needed for outreach context). This phase focuses on the **ranking engine** and ensures all memory indices are properly configured.

#### [NEW] Elasticsearch index setup (Elastic Cloud + Jina Inference)

- `src/lib/elastic.ts` — Elastic Cloud client (uses `@elastic/elasticsearch` with cloud auth)
- `src/lib/memory.ts` — `writeTranscript()`, `writeEmailThread()`, `writeOfferFact()`, `writeVendorNote()`, `retrieveRelevantMemory()`
- **Jina inference endpoint** — created via `PUT /_inference/text_embedding/jina-embed` with `jinaai` service and model `jina-embeddings-v3`. This endpoint is attached to an **ingest pipeline** so documents are automatically embedded on write — no manual embedding calls needed.
- Indices: `proc_call_transcripts`, `proc_email_threads`, `proc_offer_facts`, `proc_vendor_memory`
- Mappings include `dense_vector` (1024 dims for Jina v3, cosine) + keyword/text/date fields

#### [NEW] [route.ts](file:///Users/andrewfong/Downloads/treehacks2026/src/app/api/procure/[runId]/rank/route.ts)

`POST /api/procure/:runId/rank` — loads all offers for the run, applies weighted scoring. Hard-rejects offers that violate budget or deadline. Returns ranked list with scores.

**Scoring formula:** `score = 0.45 × price_score + 0.30 × deadline_score + 0.20 × reliability_score + 0.05 × payment_score`

#### Factor 1: Price Competitiveness (45%)

**How it's computed:** Normalize all offer total prices within the run relative to the budget.
```
price_score = 1 - (offer_total / budget_amount)
```
Clamped to `[0, 1]`. An offer exactly at budget = 0.0. An offer at half the budget = 0.5. Offers exceeding budget are **hard-rejected** (not scored at all).

#### Factor 2: Deadline Fit Confidence (30%)

**How it's computed:** Compare the vendor's stated delivery ETA against the user's deadline.
```
days_margin = deadline_date - (now + delivery_days)
if days_margin < 0: HARD REJECT
if days_margin >= 3: deadline_score = 1.0
else: deadline_score = days_margin / 3.0
```
Additionally penalized by a **confidence multiplier** from the source: if the ETA came from a phone negotiation (high confidence, ×1.0), scraped from a product page (medium, ×0.8), or inferred by the LLM (low, ×0.6).

#### Factor 3: Vendor Reliability History (20%)

**How it's computed:** This is the most nuanced factor. It's derived from the `proc_vendor_memory` Elasticsearch index, which accumulates data across *all* runs (not just the current one). The reliability score is a weighted composite of **5 signals**:

| Sub-signal | Weight | Source | Computation |
|---|---|---|---|
| **Quote consistency** | 30% | `proc_offer_facts` | Compare this vendor's current quote to their historical quotes for the same/similar items. Low variance = high score. `1 - min(stdev(historical_prices) / mean(historical_prices), 1)` |
| **Response rate** | 25% | `proc_vendor_memory` tags | Fraction of outreach attempts (calls + emails) that received a substantive response. `responses / attempts` |
| **Fulfillment track record** | 20% | `proc_vendor_memory` incident notes | Count of past successful deliveries vs. reported issues (late, wrong item, quality). `successes / (successes + incidents)`. Defaults to 0.5 for new vendors (no history) |
| **Response speed** | 15% | `proc_vendor_memory` response_time_stats | Average time from outreach to substantive response. Normalized: ≤1hr = 1.0, ≤24hr = 0.5, >24hr = 0.2 |
| **Negotiation behavior** | 10% | `proc_call_transcripts` + `proc_email_threads` | Semantic analysis (via OpenAI) of past negotiation transcripts: did the vendor honor quoted prices? Were there surprise fees or last-minute changes? Binary flag averaged over interactions |

```
reliability_score = 0.30 × quote_consistency
                  + 0.25 × response_rate
                  + 0.20 × fulfillment_record
                  + 0.15 × response_speed
                  + 0.10 × negotiation_behavior
```

**Cold-start handling:** For vendors with no prior history, `reliability_score` defaults to **0.5** (neutral). This means new vendors aren't penalized, but known-reliable vendors get a meaningful boost.

#### Factor 4: Payment Automation Compatibility (5%)

**How it's computed:** Binary check with a small gradient.
```
if vendor supports x402/crypto checkout: payment_score = 1.0
else if vendor has online checkout (credit card): payment_score = 0.5
else (invoice/manual payment only): payment_score = 0.0
```
This factor is intentionally low-weight — it's a tiebreaker, not a decision driver.

---

### Phase 5 — Purchase, Payment & Hardening

#### [NEW] [route.ts](file:///Users/andrewfong/Downloads/treehacks2026/src/app/api/procure/[runId]/purchase/route.ts)

`POST /api/procure/:runId/purchase` — checks policy gates (user opt-in via `auto_purchase` field, offer validity, budget ceiling), then attempts payment through a **two-tier strategy:**

**Tier 1 — Coinbase x402 (preferred):** If vendor supports programmatic crypto/stablecoin checkout, execute payment via x402 protocol. Instant, fully automated, auditable.

**Tier 2 — Traditional checkout via Stagehand (fallback):** If x402 is not available but the vendor has an online checkout (credit card, PayPal, etc.), use Browserbase Stagehand to:
1. `goto` the vendor's checkout/cart page
2. `observe` the checkout form fields
3. `act` to fill in shipping address, quantity, and payment details
4. `act` to submit the order
5. `extract` the confirmation number / order ID from the confirmation page

Payment credentials (card number, etc.) are stored as encrypted Vercel environment variables and only accessed server-side during the Stagehand session.

**No automated payment:** If neither tier is available (e.g. vendor requires phone/invoice payment), the purchase step records `status: "manual_required"` with instructions for the user and skips to finalize.

All payment attempts are recorded in the `purchases` table with method, status, and transaction reference.

#### [NEW] [route.ts](file:///Users/andrewfong/Downloads/treehacks2026/src/app/api/procure/[runId]/finalize/route.ts)

`POST /api/procure/:runId/finalize` — OpenAI generates structured JSON + markdown executive summary. Stores final report. Emits completion event.

#### [NEW] Hardening utilities

- `src/lib/idempotency.ts` — idempotency key generation for outbound actions
- `src/lib/guardrails.ts` — budget ceiling enforcement, kill switch for active runs
- `src/lib/x402.ts` — Coinbase x402 payment client wrapper

---

## File Structure (backend focus)

```
treehacks2026/
├── .env.example
├── db/
│   └── schema.sql
├── src/
│   ├── app/
│   │   ├── page.tsx                              # Placeholder UI
│   │   └── api/
│   │       ├── procure/
│   │       │   ├── start/route.ts                # Intake + extraction
│   │       │   └── [runId]/
│   │       │       ├── events/route.ts           # SSE stream
│   │       │       ├── discover/route.ts         # Perplexity vendor search
│   │       │       ├── rank/route.ts             # Offer scoring
│   │       │       ├── purchase/route.ts         # x402 payment
│   │       │       ├── finalize/route.ts         # Final report
│   │       │       └── vendor/
│   │       │           └── [vendorId]/
│   │       │               ├── scrape/route.ts   # Stagehand extraction
│   │       │               ├── call/route.ts     # ElevenLabs call
│   │       │               └── email/route.ts    # Resend email
│   │       └── webhooks/
│   │           └── elevenlabs/route.ts           # Post-call webhook
│   └── lib/
│       ├── types.ts        # Shared interfaces (incl. OutreachContext)
│       ├── db.ts           # Vercel Postgres client
│       ├── openai.ts       # OpenAI helpers (structured output)
│       ├── perplexity.ts   # Sonar API client
│       ├── stagehand.ts    # Browserbase client
│       ├── elevenlabs.ts   # ElevenLabs client
│       ├── email.ts        # Resend email + context-aware composer
│       ├── elastic.ts      # Elastic Cloud client
│       ├── memory.ts       # Memory read/write + retrieval
│       ├── events.ts       # Event emitter
│       ├── outreach.ts     # Channel selector + assembleOutreachContext()
│       ├── scoring.ts      # Offer ranking
│       ├── idempotency.ts  # Idempotency keys
│       ├── guardrails.ts   # Safety checks
│       └── x402.ts         # Coinbase payment
├── package.json
└── tsconfig.json
```

---

## Verification Plan

Since this is a greenfield hackathon project with many external API integrations, verification is primarily through:

### Automated Tests

1. **Type-check & lint** — `npx tsc --noEmit && npx next lint` to confirm all code compiles without errors
2. **Unit tests for scoring engine** — write a Jest test in `src/lib/__tests__/scoring.test.ts` that feeds mock offers and validates ranking output (command: `npx jest src/lib/__tests__/scoring.test.ts`)
3. **Unit test for structured extraction** — mock OpenAI response and validate `ProcurementSpec` parsing (command: `npx jest src/lib/__tests__/openai.test.ts`)

### Manual Verification

1. **Start endpoint** — run `npm run dev`, then `curl -X POST http://localhost:3000/api/procure/start -H 'Content-Type: application/json' -d '{"query": "Get me $1000 worth of tungsten by Wednesday morning to Stanford campus"}'` — should return a `run_id` and parsed spec
2. **SSE stream** — open `http://localhost:3000/api/procure/{runId}/events` in browser — should receive real-time event updates
3. **Discovery** — call the discover endpoint for a run and verify vendor candidates are returned with source URLs
4. **Full pipeline** — trigger start → discover → scrape → outreach → rank → finalize and verify the final report is generated

> [!NOTE]
> All infrastructure is Vercel-hosted. External API integrations (Perplexity, ElevenLabs, Stagehand, Elastic Cloud) require live API keys configured in Vercel environment variables. If keys are unavailable for specific services, those modules will log the intended action and return mock data so the pipeline still completes end-to-end.
