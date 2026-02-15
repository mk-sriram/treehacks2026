# Procure — AI-Powered Procurement Agent

The agentic procurement platform built to help small businesses source, negotiate, and settle vendor deals faster and smarter.

## Inspiration
With the recent rise of agentic capabilities, we saw an opportunity to empower small businesses with all of their online procurement needs. In times of financial turmoil, we often witness the shutdown of our favorite local cafes, barbershops, and other community centers due to costs that are too high and revenues that are too low. We hope to change that.

Our product does more than vendor calls: it remembers historical vendor behavior, negotiates across competing offers, and fights for the best deals globally. It also enables near-instant cross-border settlement via stablecoins, so businesses can pay and get paid in real time—protecting cash flow when every day matters.

## What it does
Procure is an agentic procurement platform that automates vendor sourcing, quote negotiation, and deal closure. It combines web-scale vendor discovery, memory-aware negotiation, and transparent interaction tracking to help businesses secure better terms faster, with rapid global settlement and clear next-step summaries for approval.

- **AI-powered vendor discovery:** Searches the internet to identify reliable, verifiable vendor contacts.  
- **Automated quote collection and negotiation:** Voice agents call vendors, gather quotes, compare offers, and follow up until target terms are reached.  
- **Behavior-aware vendor intelligence:** Uses semantic and lexical retrieval over vendor records to evaluate consistency, reliability, and pricing behavior over time.  
- **Transparent, auditable workflows:** Logs and records all interactions for verification and accountability.  
- **Fast global settlement:** Enables near-instant cross-border payments once deals are approved.  
- **Actionable decision support:** Generates concise, LLM-powered deal summaries and recommended next steps for user review.

## YC Track: Reimagining [Weave](https://www.ycombinator.com/companies/weave) (YC W14)

Weave built a customer communication and payments platform — threading together data, software, and communication channels to strengthen business relationships at the point of contact. It was founded in 2011 and went through YC in Winter 2014, well before the AI era.

**Procure reimagines this for 2026:** instead of giving humans better tools to communicate with vendors, we replace the human entirely. Procure is an autonomous AI agent that handles end-to-end B2B procurement — it discovers suppliers, calls them on the phone, negotiates prices across multiple rounds using competitive intelligence, picks a winner, sends confirmation emails, and closes the deal with a stablecoin payment. Where Weave made human-to-business communication more efficient, Procure makes it fully autonomous.

## How we built it
- **Frontend:** Built with Next.js 16 and React 19, styled with Tailwind CSS 4 and shadcn/ui. The dashboard streams real-time progress via Server-Sent Events (SSE), letting users watch the agent work live. Recharts powers quote comparison visualizations.  
- **Backend & Database:** Next.js API Routes handle backend logic. Prisma 7 connects to a Neon serverless PostgreSQL database storing runs, vendors, offers, and call transcripts.  
- **Vendor Discovery:** Perplexity Sonar Pro runs multiple search angles per request to find real suppliers with verified contact info and citations — replacing hours of manual sourcing.  
- **Voice AI Calls:** ElevenLabs Conversational AI makes autonomous phone calls to vendors via Twilio. Three specialized agents handle initial quoting (Round 1), competitive negotiation (Round 2), and order confirmation (Round 3).  
- **Intelligent Memory:** Elasticsearch provides hybrid retrieval combining BM25 keyword search with semantic vector search, ranked via Reciprocal Rank Fusion (RRF). The agent remembers what each vendor said and uses that intel to negotiate better deals.  
- **LLM Processing:** OpenAI GPT-4o-mini extracts structured offer data from call transcripts, generates per-vendor negotiation strategies, and parses natural-language requirements into structured RFQ specs.  
- **Email Communication:** AgentMail sends confirmation emails to winning vendors and listens for invoice replies via webhooks, closing the procurement loop automatically.  
- **Payment:** We use ElevenLabs server tool calling integrated with a Turnkey-based crypto wallet implementation. During the Round 3 confirmation call, the voice agent autonomously initiates a USDC stablecoin payment on the Base network to the vendor's wallet address and generates an invoice. Note that the payment is simulated for demo purposes to avoid sending real funds, but the full pipeline is wired end-to-end.

## Challenges we ran into
- **Concurrency and call-state race conditions:** Our workflow depends on parallel outbound calls and multi-round follow-ups. Coordinating state transitions across simultaneous call events introduced race conditions (e.g., conflicting status updates, missed callbacks, duplicate transitions), which occasionally caused dropped opportunities and inconsistent call flow.
- **Complex real-time orchestration across frontend + SSE + voice webhooks:** Integrating live UI updates with server-sent events and asynchronous voice-provider webhooks was more complex than expected. We had to handle out-of-order events, retries, and idempotency to keep the interface consistent with backend truth in real time.
- **Voice-agent alignment and information fidelity:** Getting voice agents to sound natural while reliably extracting structured procurement details (price, MOQ, lead time, payment terms, delivery constraints) required substantial prompt and policy iteration. Small phrasing changes often affected both conversation quality and extraction accuracy.
- **Vendor data normalization across heterogeneous sources:** Vendor information arrived in inconsistent formats across web sources and call transcripts. Standardizing entities (company identity, unit pricing, terms, and reliability signals) into a comparable schema was a non-trivial data quality challenge.
- **Negotiation strategy tuning under uncertainty:** We needed agents to negotiate assertively without becoming repetitive or adversarial, while adapting to vendor-specific behavior across rounds. Balancing win-rate, final pricing quality, and conversation length required careful policy tuning and guardrails.

## Accomplishments we're proud of
- Enabled parallel vendor outreach and multi-round negotiation in real time  
- Implemented memory-aware vendor comparison across historical and live quote data  
- Delivered fast cross-border settlement flow after deal approval  
- Shipped a clean, intuitive interface for rapid operator review and control  
- Designed a scalable architecture that supports multiple concurrent procurement workflows  
- Generated concise, actionable AI summaries to speed up final decision-making  

## What we learned
- **Asynchronous state-machine orchestration:** Architected a resilient state machine with Next.js and Postgres to manage long-running, multi-stage procurement workflows across days of async vendor interactions and webhook callbacks.  
- **Hybrid search implementation:** Engineered a hybrid Elasticsearch strategy combining semantic vector retrieval with lexical constraint matching for high-recall, high-precision vendor discovery.  
- **Real-time event streaming:** Implemented an SSE pipeline to stream background workflow updates to the frontend in real time, eliminating polling for call progress and negotiation outcomes.  
- **Audio-to-structured-data pipelines:** Built fault-tolerant extraction workflows that transform noisy phone audio into strict JSON schemas for pricing, inventory, and terms using multi-pass LLM inference.  
- **Latency-sensitive voice integration:** Optimized the Twilio–ElevenLabs handshake for sub-second conversational latency while injecting retrieved context to support interruptions and complex live negotiation logic.  

## What's next for Procure
- **Live context injection:** Upgrading the voice pipeline to support mid-call context updates so agents can reference newly discovered competitor pricing or inventory in real time and apply immediate negotiation leverage.  
- **Adaptive agent personas:** Implementing learning loops from historical interaction logs to tailor agent style (e.g., aggressive vs. consultative) based on which strategies consistently produce better terms for specific vendors.  
- **Domain-specific knowledge graphs:** Integrating vertical knowledge bases (e.g., aerospace, medical devices) so agents use correct industry terminology, improve vendor trust, and reduce hallucinations in technical conversations.  

## Built With

nextjs, react, tailwindcss, typescript, prisma, neon, elasticsearch, perplexity, elevenlabs, twilio, openai, agentmail, turnkey, usdc, base, shadcn/ui, recharts

## Running the project

Acquire the necessary API keys for Elasticsearch, OpenAI, ElevenLabs, Perplexity, AgentMail, and Neon. Then run the following commands on a UNIX-like machine:

```bash
npm install
./scripts/quick-tunnel.sh # If permissions are denied, try chmod +x ./scripts/quick-tunnel.sh
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to see the results.
