# Wallet Server — End-to-End Payment Process

Full payment flow starting from the moment the agent and vendor have agreed on a price.

## Systems & Actors

| Actor | System | Role |
|-------|--------|------|
| **Browser** | Next.js frontend | User sees activity feed, stages, status |
| **Orchestrator** | Next.js backend (`src/lib/orchestrator.ts`) | Drives the procurement pipeline stage-by-stage |
| **AgentMail** | External SaaS (`api.agentmail.to`) | Email delivery, webhook dispatch |
| **Wallet Server** | Standalone (`wallet_server/`, port 4020) | Invoice creation, mock settlement |
| **Vendor** | External human/system | Receives invoice email, (conceptually) pays |

## Sequence Diagram

```
 ORCHESTRATOR                  AGENTMAIL               WALLET SERVER              VENDOR
 (Next.js backend)             (external SaaS)         (localhost:4020)           (email recipient)
      │                              │                        │                        │
      │  ┌─────────────────────┐     │                        │                        │
      │  │ Negotiation done.   │     │                        │                        │
      │  │ Agreed price: $250k │     │                        │                        │
      │  │ Vendor: Acme Corp   │     │                        │                        │
      │  └─────────┬───────────┘     │                        │                        │
      │            │                 │                        │                        │
      │  STAGE: "paying_deposit"     │                        │                        │
      │  emit services_change        │                        │                        │
      │  { visa: true }              │                        │                        │
      │            │                 │                        │                        │
 ─────┼────────────┼─────────────────┼────────────────────────┼────────────────────────┼──────
 STEP 1: Agent sends email to vendor inbox via AgentMail
 ─────┼────────────┼─────────────────┼────────────────────────┼────────────────────────┼──────
      │            │                 │                        │                        │
      │  POST /v0/inboxes/{id}      │                        │                        │
      │       /messages/send ──────►│                        │                        │
      │  {                           │                        │                        │
      │    to: "acme@vendor.com",    │                        │                        │
      │    subject: "PO #...",       │                        │                        │
      │    text: "Amount: 250000"    │                        │                        │
      │  }                           │                        │                        │
      │            │                 │                        │                        │
      │            │   200 OK        │                        │                        │
      │  ◄─────────────────────────  │                        │                        │
      │                              │                        │                        │
 ─────┼──────────────────────────────┼────────────────────────┼────────────────────────┼──────
 STEP 2: Vendor inbox receives email → AgentMail fires webhook to wallet_server
 ─────┼──────────────────────────────┼────────────────────────┼────────────────────────┼──────
      │                              │                        │                        │
      │                              │  POST /webhook/agentmail                        │
      │                              │  {                     │                        │
      │                              │   event_type:          │                        │
      │                              │    "message.received", │                        │
      │                              │   message: {           │                        │
      │                              │    from: agent inbox,  │                        │
      │                              │    text: "Amount:      │                        │
      │                              │           250000",     │                        │
      │                              │    inbox_id: ...,      │                        │
      │                              │    message_id: ...     │                        │
      │                              │   }                    │                        │
      │                              │  } ───────────────────►│                        │
      │                              │                        │                        │
      │                              │                   ┌────┴──────────────────┐     │
      │                              │                   │ 1. Parse "Amount:     │     │
      │                              │                   │       250000"         │     │
      │                              │                   │ 2. Create invoice:    │     │
      │                              │                   │    INV-0001           │     │
      │                              │                   │    status: "pending"  │     │
      │                              │                   │    amount: 250000     │     │
      │                              │                   └────┬──────────────────┘     │
      │                              │                        │                        │
 ─────┼──────────────────────────────┼────────────────────────┼────────────────────────┼──────
 STEP 3: Wallet server replies with invoice details (threaded email via AgentMail)
 ─────┼──────────────────────────────┼────────────────────────┼────────────────────────┼──────
      │                              │                        │                        │
      │                              │  POST /v0/inboxes/{id} │                        │
      │                              │   /messages/{msg_id}   │                        │
      │                              │   /reply               │                        │
      │                              │  {                     │                        │
      │                              │   text:                │                        │
      │                              │    "Invoice: $250,000  │                        │
      │                              │     Wallet: 0xAbC...   │                        │
      │                              │     Invoice ID:        │                        │
      │                              │      INV-0001"         │                        │
      │                              │  }                     │                        │
      │                              │ ◄──────────────────────│                        │
      │                              │                        │                        │
      │                              │   200 OK               │                        │
      │                              │ ──────────────────────►│                        │
      │                              │                        │                        │
      │                              │    deliver reply email ─────────────────────────►
      │                              │                        │               ┌────────┴───────┐
      │                              │                        │               │ Vendor receives │
      │                              │                        │               │ email:          │
      │                              │                        │               │  Invoice: $250k │
      │                              │                        │               │  Wallet: 0xAbC..│
      │                              │                        │               │  ID: INV-0001   │
      │                              │                        │               └────────┬───────┘
      │                              │                        │                        │
 ─────┼──────────────────────────────┼────────────────────────┼────────────────────────┼──────
 STEP 4: Orchestrator calls wallet server to confirm payment (mock settlement)
 ─────┼──────────────────────────────┼────────────────────────┼────────────────────────┼──────
      │                              │                        │                        │
      │  POST http://localhost:4020/initiate-payment          │                        │
      │  { "invoice_id": "INV-0001" }                        │                        │
      │  ──────────────────────────────────────────────────►  │                        │
      │                              │                        │                        │
      │                              │                   ┌────┴──────────────────┐     │
      │                              │                   │ 1. Find INV-0001      │     │
      │                              │                   │ 2. Mark status: "paid"│     │
      │                              │                   │ 3. Return confirmation│     │
      │                              │                   └────┬──────────────────┘     │
      │                              │                        │                        │
      │  200 OK                                               │                        │
      │  {                                                    │                        │
      │    status: "confirmed",                               │                        │
      │    invoice_id: "INV-0001",                            │                        │
      │    amount: "250000",                                  │                        │
      │    wallet: "0xAbC..."                                 │                        │
      │  }                                                    │                        │
      │  ◄────────────────────────────────────────────────────│                        │
      │                              │                        │                        │
 ─────┼──────────────────────────────┼────────────────────────┼────────────────────────┼──────
 STEP 5: Orchestrator emits events to frontend
 ─────┼──────────────────────────────┼────────────────────────┼────────────────────────┼──────
      │                              │                        │                        │
      │  emitRunEvent("activity", {                           │                        │
      │    type: "payment",                                   │                        │
      │    title: "Deposit confirmed",                        │                        │
      │    description: "$250k → 0xAbC..."                    │                        │
      │  })                                                   │                        │
      │                              │                        │                        │
      │  emitRunEvent("stage_change",│                        │                        │
      │    { stage: "complete" })     │                        │                        │
      │                              │                        │                        │
      │           SSE ──────────────►│ BROWSER                │                        │
      │           (existing stream)  │ updates UI:            │                        │
      │                              │  ✓ "Pay deposit" done  │                        │
      │                              │  ✓ payment activity    │                        │
      │                              │  ✓ stage → complete    │                        │
      │                              │                        │                        │
      ▼                              ▼                        ▼                        ▼
```

## Steps Summary

| Step | Who | Does what | Via |
|------|-----|-----------|-----|
| **1** | **Orchestrator** | Sends email to vendor inbox with the agreed `Amount: 250000` | AgentMail Send Message API |
| **2** | **AgentMail** | Receives the email in the vendor inbox, fires `message.received` webhook | HTTP POST to `wallet_server/webhook/agentmail` |
| **3** | **Wallet Server** | Parses amount, creates `INV-0001` (pending), replies in-thread with invoice + mock wallet address | AgentMail Reply API |
| **4** | **Orchestrator** | Calls `POST /initiate-payment` with `{ invoice_id: "INV-0001" }` to simulate settlement | Direct HTTP to wallet_server |
| **5** | **Orchestrator** | Emits `activity` (payment confirmed) + `stage_change` (complete) events over SSE | In-process event bus → browser |

## Implementation Status

| Piece | Status |
|-------|--------|
| Wallet server: webhook, invoice store, `/initiate-payment` | **Done** (running) |
| Wallet server: AgentMail reply | **Done** (works with real message IDs) |
| Orchestrator: Step 1 (send email via AgentMail) | **Not yet** — orchestrator currently ends at `discovery_complete`. Needs a `paying_deposit` stage that calls AgentMail send |
| Orchestrator: Step 4 (call `/initiate-payment`) | **Not yet** — needs to be added after the email is sent and invoice ID is known |
| Orchestrator: Step 5 (emit payment events to frontend) | **Not yet** — but the SSE infrastructure and `payment` activity type already exist in the frontend |
