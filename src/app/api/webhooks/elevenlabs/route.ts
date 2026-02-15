// Webhook handler for ElevenLabs post-call events
// Receives transcript after a call completes, extracts offer terms via LLM,
// writes to Postgres (truth) and Elasticsearch (memory).
// Also drives the pipeline forward: round 1 → negotiation → summary.

import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { prisma } from '@/lib/db';
import { writeMemory } from '@/lib/elastic';
import { emitRunEvent } from '@/lib/events';
import { triggerOutboundCall, buildDynamicVariables, resolveDialNumber } from '@/lib/elevenlabs';
import { assembleOutreachContext } from '@/lib/outreach';
import { generateNegotiationStrategy, retrieveVendorIntelligence, formatStrategyForAgent, type NegotiationStrategyInput } from '@/lib/negotiation';

let webhookActivityCounter = 0;
function makeActivityId() {
    webhookActivityCounter++;
    return `wh-${Date.now()}-${webhookActivityCounter}-${Math.random().toString(36).slice(2, 6)}`;
}

// ─── Helper: emit full calls_change array ────────────────────────────

/**
 * Re-query all Call rows for a run, join with Vendor names, and emit
 * a `calls_change` event with the full array. This is what the frontend
 * PhoneCallPanel expects: [{ id, supplier, status, duration }]
 */
async function emitCallsChange(runId: string) {
    const allCalls = await prisma.call.findMany({
        where: { runId },
        include: { vendor: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
    });
    emitRunEvent(runId, {
        type: 'calls_change',
        payload: allCalls.map(c => ({
            id: c.id,
            supplier: c.vendor.name,
            status: c.status === 'in-progress' ? 'connected' : c.status === 'completed' ? 'ended' : c.status === 'failed' ? 'ended' : 'ringing',
            duration: c.duration ?? 0,
        })),
    });
}

// ─── Webhook entry point ─────────────────────────────────────────────

/**
 * POST /api/webhooks/elevenlabs
 *
 * ElevenLabs sends three webhook types:
 *   - post_call_transcription: full transcript + analysis (we handle this)
 *   - post_call_audio: base64 MP3 audio (we ignore)
 *   - call_initiation_failure: call failed to connect (we handle this)
 */
export async function POST(req: Request) {
    console.log(`[WEBHOOK] ElevenLabs webhook received`);

    try {
        // TODO: Verify HMAC signature in production
        // const signature = req.headers.get('x-elevenlabs-signature');
        // verifySignature(signature, rawBody, process.env.ELEVENLABS_WEBHOOK_SECRET);

        const body = await req.json();
        const eventType = body.type;

        console.log(`[WEBHOOK] Event type: ${eventType}`);

        switch (eventType) {
            case 'post_call_transcription':
                // Return 200 immediately so ElevenLabs doesn't timeout/retry.
                // Process the transcription asynchronously in the background.
                void processPostCallTranscription(body).catch(err =>
                    console.error('[WEBHOOK] Background transcription processing error:', err)
                );
                return NextResponse.json({ received: true, handled: true });
            case 'call_initiation_failure':
                // Return 200 immediately, process async
                void processCallInitiationFailure(body).catch(err =>
                    console.error('[WEBHOOK] Background failure processing error:', err)
                );
                return NextResponse.json({ received: true, handled: true });
            case 'post_call_audio':
                // We don't need audio — just acknowledge
                console.log(`[WEBHOOK] Ignoring post_call_audio event`);
                return NextResponse.json({ received: true, handled: false });
            default:
                console.log(`[WEBHOOK] Unknown event type: ${eventType}`);
                return NextResponse.json({ received: true, handled: false });
        }
    } catch (err: any) {
        console.error('[WEBHOOK] Error processing webhook:', err);
        // Always return 200 quickly to ElevenLabs so they don't retry
        return NextResponse.json({ received: true, error: err.message }, { status: 200 });
    }
}

// ─── post_call_transcription processor (runs in background) ──────────

async function processPostCallTranscription(body: any) {
    const data = body.data;
    const conversationId = data?.conversation_id;
    const status = data?.status;  // "done" | "failed" etc.

    // Transcript is an array of {role, message, time_in_call_secs, ...}
    const transcriptTurns: Array<{ role: string; message: string; time_in_call_secs?: number }> =
        data?.transcript ?? [];

    // Flatten transcript into a readable string
    const transcriptText = transcriptTurns
        .map(t => `${t.role === 'agent' ? 'Agent' : 'Vendor'}: ${t.message}`)
        .join('\n');

    // ElevenLabs analysis object
    const analysis = data?.analysis ?? {};
    const metadata = data?.metadata ?? {};
    const callDurationSecs = metadata?.call_duration_secs ?? null;

    // The dynamic_variables we sent are echoed back in conversation_initiation_client_data
    const clientData = data?.conversation_initiation_client_data ?? {};
    const dynamicVars = clientData?.dynamic_variables ?? {};

    console.log(`[WEBHOOK] Transcription — conversation_id=${conversationId}, status=${status}`);
    console.log(`[WEBHOOK] Transcript turns: ${transcriptTurns.length}, duration: ${callDurationSecs}s`);
    console.log(`[WEBHOOK] Analysis summary: ${(analysis.transcript_summary ?? '').slice(0, 200)}`);
    console.log(`[WEBHOOK] Dynamic vars received back:`, Object.keys(dynamicVars));

    if (!conversationId) {
        console.error('[WEBHOOK] No conversation_id in payload — cannot map to a call');
        return;
    }

    // 1. Find the Call row by conversationId (with retry for race condition)
    // The Call row might not have its conversationId set yet if the webhook
    // arrives before triggerOutboundCall returns and updates the placeholder row.
    let call = await prisma.call.findUnique({
        where: { conversationId },
        include: { vendor: true },
    });

    if (!call) {
        console.log(`[WEBHOOK] Call row not found for conversationId=${conversationId} — retrying in 3s...`);
        await new Promise(resolve => setTimeout(resolve, 3000));
        call = await prisma.call.findUnique({
            where: { conversationId },
            include: { vendor: true },
        });
    }

    if (!call) {
        console.error(`[WEBHOOK] No Call row found for conversationId=${conversationId} after retry`);
        return;
    }

    console.log(`[WEBHOOK] Mapped to — runId=${call.runId}, vendor=${call.vendor.name}, round=${call.round}`);

    // 2. Update the Call row with transcript + status
    await prisma.call.update({
        where: { id: call.id },
        data: {
            transcript: transcriptText,
            status: 'completed',
            duration: callDurationSecs ? Math.round(callDurationSecs) : null,
        },
    });
    console.log(`[WEBHOOK] Call row updated — status=completed, duration=${callDurationSecs ?? 'unknown'}s`);

    // Emit full calls_change array so frontend PhoneCallPanel updates IMMEDIATELY
    await emitCallsChange(call.runId);

    // 3. Extract structured offer terms from the transcript via LLM
    let extractedOffer = null;
    try {
        extractedOffer = await extractOfferViaLLM(transcriptText, call.vendor.name, analysis);

        if (extractedOffer) {
            const offer = await prisma.offer.create({
                data: {
                    vendorId: call.vendorId,
                    unitPrice: extractedOffer.unitPrice,
                    moq: extractedOffer.moq,
                    leadTimeDays: extractedOffer.leadTimeDays,
                    shipping: extractedOffer.shipping,
                    terms: extractedOffer.terms,
                    confidence: extractedOffer.confidence,
                    source: call.round === 1 ? 'voice-call-r1' : 'voice-call-r2',
                    rawEvidence: transcriptText.slice(0, 2000),
                },
            });
            console.log(`[WEBHOOK] Offer created — id=${offer.id}, unitPrice=${offer.unitPrice}, leadTime=${offer.leadTimeDays}d, confidence=${offer.confidence}`);

            // Emit quote event for the frontend
            emitRunEvent(call.runId, {
                type: 'quote',
                payload: {
                    supplier: call.vendor.name,
                    unitPrice: extractedOffer.unitPrice != null ? `$${extractedOffer.unitPrice}` : 'Not quoted',
                    moq: extractedOffer.moq ?? 'N/A',
                    leadTime: extractedOffer.leadTimeDays != null ? `${extractedOffer.leadTimeDays} days` : 'N/A',
                    shipping: extractedOffer.shipping ?? 'N/A',
                    terms: extractedOffer.terms ?? 'N/A',
                    confidence: extractedOffer.confidence ?? 50,
                    source: call.round === 1 ? 'voice-call' : 'negotiation-call',
                },
            });
        }
    } catch (err) {
        console.error(`[WEBHOOK] Offer extraction failed for ${call.vendor.name}:`, err);
        // Continue execution - do not return
    }

    // 4. Write transcript + extracted facts to Elasticsearch (memory)
    try {
        const memoryText = [
            `Voice call with ${call.vendor.name} (round ${call.round}).`,
            analysis.transcript_summary ? `Summary: ${analysis.transcript_summary}` : '',
            extractedOffer?.unitPrice != null ? `Quoted $${extractedOffer.unitPrice}/unit.` : '',
            extractedOffer?.leadTimeDays != null ? `Lead time: ${extractedOffer.leadTimeDays} days.` : '',
            extractedOffer?.terms ? `Terms: ${extractedOffer.terms}.` : '',
            `Full transcript: ${transcriptText.slice(0, 800)}`,
        ].filter(Boolean).join(' ');

        await writeMemory({
            text: memoryText,
            run_id: call.runId,
            vendor_id: call.vendorId,
            channel: 'call',
        });
        console.log(`[WEBHOOK] Transcript indexed in Elasticsearch`);
    } catch (err) {
        console.error('[WEBHOOK] Failed to write to ES (non-fatal):', err);
    }

    // 5. Emit SSE events for the frontend
    const activityId = makeActivityId();
    emitRunEvent(call.runId, {
        type: 'activity',
        payload: {
            id: activityId,
            type: 'call',
            title: `Call completed: ${call.vendor.name}`,
            description: extractedOffer
                ? `Quote received: ${extractedOffer.unitPrice != null ? `$${extractedOffer.unitPrice}/unit` : 'pricing discussed'}, ${extractedOffer.leadTimeDays ? `${extractedOffer.leadTimeDays} day lead time` : 'lead time TBD'}. Confidence: ${extractedOffer.confidence}%.`
                : `Call completed but no deal extracted. Transcript stored.`,
            timestamp: new Date(),
            status: 'done',
            tool: 'elevenlabs',
        },
    });

    console.log(`[WEBHOOK] Done processing transcription for ${call.vendor.name}`);

    // 6. Check if all calls for this round are done — advance the pipeline
    checkRoundCompletion(call.runId, call.round).catch(err =>
        console.error(`[WEBHOOK] checkRoundCompletion error (non-fatal):`, err)
    );
}

// ─── call_initiation_failure processor (runs in background) ──────────

async function processCallInitiationFailure(body: any) {
    const data = body.data;
    const conversationId = data?.conversation_id;
    const failureReason = data?.failure_reason ?? 'unknown';

    console.log(`[WEBHOOK] Call initiation failure — conversation_id=${conversationId}, reason=${failureReason}`);

    if (!conversationId) {
        console.error('[WEBHOOK] No conversation_id in failure payload');
        return;
    }

    const call = await prisma.call.findUnique({
        where: { conversationId },
        include: { vendor: true },
    });

    if (call) {
        await prisma.call.update({
            where: { id: call.id },
            data: { status: 'failed' },
        });

        emitRunEvent(call.runId, {
            type: 'activity',
            payload: {
                id: makeActivityId(),
                type: 'call',
                title: `Call failed: ${call.vendor.name}`,
                description: `Call could not connect: ${failureReason}`,
                timestamp: new Date(),
                status: 'error',
                tool: 'elevenlabs',
            },
        });

        console.log(`[WEBHOOK] Call marked as failed for ${call.vendor.name}`);

        // Emit full calls_change array so frontend PhoneCallPanel updates
        await emitCallsChange(call.runId);

        // Check if all calls for this round are done — advance the pipeline
        checkRoundCompletion(call.runId, call.round).catch(err =>
            console.error(`[WEBHOOK] checkRoundCompletion error (non-fatal):`, err)
        );
    }
}

// ─── LLM-based offer extraction ─────────────────────────────────────

interface ExtractedOffer {
    unitPrice: number | null;
    moq: string | null;
    leadTimeDays: number | null;
    shipping: string | null;
    terms: string | null;
    confidence: number;
}

/**
 * Extract structured offer terms from a call transcript using OpenAI.
 * Falls back gracefully to ElevenLabs analysis if the LLM call fails.
 */
async function extractOfferViaLLM(
    transcript: string,
    vendorName: string,
    elevenLabsAnalysis: any
): Promise<ExtractedOffer | null> {
    if (!transcript || transcript.length < 30) {
        console.log(`[WEBHOOK] Transcript too short for extraction (${transcript.length} chars)`);
        return null;
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        console.warn('[WEBHOOK] OPENAI_API_KEY not set — skipping LLM extraction');
        return parseElevenLabsAnalysis(elevenLabsAnalysis);
    }

    const openai = new OpenAI({ apiKey });

    const extractionPrompt = `You are a procurement data extraction system. Analyze this phone call transcript between our procurement agent and ${vendorName}. Extract any pricing or offer information discussed.

TRANSCRIPT:
${transcript.slice(0, 3000)}

${elevenLabsAnalysis?.transcript_summary ? `CALL SUMMARY: ${elevenLabsAnalysis.transcript_summary}` : ''}

Extract the following fields. If a field was not discussed or is unclear, set it to null.
Return ONLY valid JSON.
`;

    try {
        console.log(`[WEBHOOK] Calling OpenAI for offer extraction...`);
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: extractionPrompt },
                { role: "user", content: "Extract offer details to JSON." }
            ],
            response_format: { type: "json_object" },
            temperature: 0,
        });

        const content = completion.choices[0].message.content;
        console.log(`[WEBHOOK] OpenAI extraction result:`, content?.slice(0, 500));

        if (!content) return parseElevenLabsAnalysis(elevenLabsAnalysis);

        const parsed = JSON.parse(content);

        // Compute unit price from total if only total was given
        let unitPrice = parsed.unit_price;
        if (unitPrice == null && parsed.total_price != null) {
            unitPrice = parsed.total_price;
        }

        return {
            unitPrice: unitPrice != null ? Number(unitPrice) : null,
            moq: parsed.moq ?? null,
            leadTimeDays: parsed.lead_time_days != null ? Number(parsed.lead_time_days) : null,
            shipping: parsed.shipping ?? null,
            terms: [parsed.payment_terms, parsed.notes].filter(Boolean).join('. ') || null,
            confidence: parsed.confidence ?? 50,
        };
    } catch (err) {
        console.error('[WEBHOOK] OpenAI extraction failed:', err);
        return parseElevenLabsAnalysis(elevenLabsAnalysis);
    }
}

/**
 * Fallback: try to parse ElevenLabs' own analysis results
 * if the LLM extraction fails or OpenAI is unavailable.
 */
function parseElevenLabsAnalysis(analysis: any): ExtractedOffer | null {
    if (!analysis) return null;

    const dataCollection = analysis.data_collection_results ?? {};

    // ElevenLabs data_collection_results contains whatever fields
    // were configured in the agent's data collection settings
    if (Object.keys(dataCollection).length > 0) {
        console.log(`[WEBHOOK] Using ElevenLabs data_collection_results as fallback:`, dataCollection);
        return {
            unitPrice: parseFloat(dataCollection.unit_price ?? dataCollection.price) || null,
            moq: dataCollection.moq ?? dataCollection.minimum_order ?? null,
            leadTimeDays: parseInt(dataCollection.lead_time_days ?? dataCollection.lead_time) || null,
            shipping: dataCollection.shipping ?? null,
            terms: dataCollection.payment_terms ?? null,
            confidence: 50, // Moderate confidence for auto-extracted data
        };
    }

    return null;
}

// ─── Pipeline continuation ──────────────────────────────────────────

/**
 * After each call completes (transcript or failure), check if ALL calls
 * for the round are done. If so, advance the pipeline.
 *
 * Uses compare-and-swap (CAS) on Run.status to prevent duplicate transitions
 * when multiple webhooks arrive at the same time.
 */
async function checkRoundCompletion(runId: string, round: number) {
    // Count calls that are NOT in a terminal state.
    // This includes 'pending' (placeholder rows) and 'in-progress' (active calls).
    const pendingCalls = await prisma.call.count({
        where: { runId, round, status: { notIn: ['completed', 'failed'] } },
    });

    if (pendingCalls > 0) {
        console.log(`[WEBHOOK] ${pendingCalls} calls still pending for round ${round} — not advancing yet`);
        return;
    }

    console.log(`[WEBHOOK] All round ${round} calls complete for run ${runId} — advancing pipeline`);

    if (round === 1) {
        // CAS: only transition if status is still 'calling_round_1'
        const updated = await prisma.run.updateMany({
            where: { id: runId, status: 'calling_round_1' },
            data: { status: 'negotiating' },
        });
        if (updated.count === 0) {
            console.log(`[WEBHOOK] CAS miss — run ${runId} already advanced past calling_round_1`);
            return;
        }
        console.log(`[WEBHOOK] Round 1 complete — starting negotiation round`);
        startNegotiationRound(runId).catch(err =>
            console.error(`[WEBHOOK] startNegotiationRound error:`, err)
        );
    } else if (round === 2) {
        // CAS: only transition if status is still 'calling_round_2'
        const updated = await prisma.run.updateMany({
            where: { id: runId, status: 'calling_round_2' },
            data: { status: 'summarizing' },
        });
        if (updated.count === 0) {
            console.log(`[WEBHOOK] CAS miss — run ${runId} already advanced past calling_round_2`);
            return;
        }
        console.log(`[WEBHOOK] Round 2 complete — finalizing summary`);
        finalizeSummary(runId).catch(err =>
            console.error(`[WEBHOOK] finalizeSummary error:`, err)
        );
    }
}

/**
 * After round 1 quotes are in, trigger round 2 negotiation calls.
 * Uses the negotiate agent (ELEVENLABS_AGENT_ID_NEGOTIATE) and populates
 * competitive intelligence variables (best_price, target_price, etc.).
 */
async function startNegotiationRound(runId: string) {
    console.log(`[WEBHOOK] ========== Starting Negotiation Round ==========`);

    const agentIdNegotiate = process.env.ELEVENLABS_AGENT_ID_NEGOTIATE;
    const agentPhoneNumberId = process.env.ELEVENLABS_PHONE_NUMBER_ID;

    if (!agentIdNegotiate || !agentPhoneNumberId) {
        console.warn(`[WEBHOOK] ELEVENLABS_AGENT_ID_NEGOTIATE or PHONE_NUMBER_ID not set — skipping negotiation`);
        // Skip straight to summary
        await prisma.run.update({ where: { id: runId }, data: { status: 'summarizing' } });
        finalizeSummary(runId).catch(console.error);
        return;
    }

    // Get round 1 results to populate competitive intelligence
    const round1Offers = await prisma.offer.findMany({
        where: { vendor: { runId }, source: 'voice-call-r1' },
        include: { vendor: true },
        orderBy: { unitPrice: 'asc' },
    });

    if (round1Offers.length < 2) {
        console.log(`[WEBHOOK] Only ${round1Offers.length} round 1 offers — not enough to negotiate. Skipping to summary.`);
        await prisma.run.update({ where: { id: runId }, data: { status: 'summarizing' } });
        finalizeSummary(runId).catch(console.error);
        return;
    }

    // Log all round 1 offers for debugging vendor selection
    console.log(`[WEBHOOK] Round 1 offers (sorted by unitPrice ASC):`);
    round1Offers.forEach((o, idx) => {
        console.log(`  [${idx}] ${o.vendor.name} — $${o.unitPrice}/unit, lead=${o.leadTimeDays}d, vendorId=${o.vendorId}`);
    });

    const bestOffer = round1Offers[0];
    const bestPrice = bestOffer.unitPrice != null ? String(bestOffer.unitPrice) : '';
    const bestSupplier = bestOffer.vendor.name;
    console.log(`[WEBHOOK] Best offer: ${bestSupplier} at $${bestPrice}/unit (vendorId=${bestOffer.vendorId})`);

    // Target 10-15% below best price
    const targetPrice = bestOffer.unitPrice != null
        ? String(Math.round(bestOffer.unitPrice * 0.87 * 100) / 100)
        : '';

    // Build competing offers text
    const competingText = round1Offers
        .map(o => `${o.vendor.name}: $${o.unitPrice}/unit, ${o.leadTimeDays ?? '?'} day lead time`)
        .join('; ');

    // Negotiate with all vendors EXCEPT the one with the best (lowest) price
    const vendorsToNegotiate = round1Offers
        .filter(o => o.vendorId !== bestOffer.vendorId)
        .map(o => o.vendor);

    console.log(`[WEBHOOK] Vendors selected for negotiation: ${vendorsToNegotiate.map(v => v.name).join(', ')}`);
    console.log(`[WEBHOOK] Vendor EXCLUDED (best price): ${bestSupplier}`);

    if (vendorsToNegotiate.length === 0) {
        console.log(`[WEBHOOK] No vendors to negotiate with — skipping to summary`);
        await prisma.run.update({ where: { id: runId }, data: { status: 'summarizing' } });
        finalizeSummary(runId).catch(console.error);
        return;
    }

    // Load run spec for item/quantity context
    const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
    const spec = run.parsedSpec as { item: string; quantity: string; leadTime?: string; quality?: string };

    emitRunEvent(runId, {
        type: 'activity',
        payload: {
            id: makeActivityId(),
            type: 'system',
            title: 'Starting Negotiation Round',
            description: `Round 1 collected ${round1Offers.length} quotes. Best: $${bestPrice}/unit from ${bestSupplier}. Generating per-vendor negotiation strategies for ${vendorsToNegotiate.length} vendors...`,
            timestamp: new Date(),
            status: 'running',
            tool: 'elevenlabs',
        },
    });

    // Enable services indicator for the strategy generation phase
    emitRunEvent(runId, {
        type: 'services_change',
        payload: { perplexity: false, elasticsearch: true, openai: true, stagehand: false, elevenlabs: true, visa: false },
    });

    // ===== PHASE 1: Generate per-vendor negotiation strategies via LLM =====
    // For each vendor: retrieve ES intel → call OpenAI → get tailored strategy
    const vendorStrategies = new Map<string, string>(); // vendorId → formatted strategy

    // Build a map of vendorId → their R1 offer for quick lookup
    const r1OfferByVendor = new Map(round1Offers.map(o => [o.vendorId, o]));

    for (const vendor of vendorsToNegotiate) {
        const strategyActivityId = makeActivityId();
        emitRunEvent(runId, {
            type: 'activity',
            payload: {
                id: strategyActivityId,
                type: 'analyze',
                title: `Analyzing negotiation leverage: ${vendor.name}`,
                description: `Retrieving discovery data and call transcript from Elasticsearch, then generating LLM strategy...`,
                timestamp: new Date(),
                status: 'running',
                tool: 'openai',
            },
        });

        try {
            // 1. Retrieve ES intelligence (Sonar + R1 call data)
            const { sonarData, callTranscript } = await retrieveVendorIntelligence(spec.item, vendor.id);

            // 2. Build the strategy input
            const vendorR1Offer = r1OfferByVendor.get(vendor.id);
            const strategyInput: NegotiationStrategyInput = {
                vendorName: vendor.name,
                vendorId: vendor.id,
                runId,
                item: spec.item,
                quantity: spec.quantity,
                r1UnitPrice: vendorR1Offer?.unitPrice ?? null,
                r1Moq: vendorR1Offer?.moq ?? null,
                r1LeadTimeDays: vendorR1Offer?.leadTimeDays ?? null,
                r1Terms: vendorR1Offer?.terms ?? null,
                r1Transcript: vendorR1Offer?.rawEvidence ?? null,
                bestPrice: `$${bestPrice}`,
                bestSupplier,
                allCompetingOffers: competingText,
            };

            // 3. Generate LLM strategy
            const strategy = await generateNegotiationStrategy(strategyInput, sonarData, callTranscript);
            const formattedStrategy = formatStrategyForAgent(strategy);
            vendorStrategies.set(vendor.id, formattedStrategy);

            console.log(`[WEBHOOK] Strategy generated for ${vendor.name}: target=${strategy.targetPrice}, leverage=${strategy.keyLeveragePoints.length} points`);

            emitRunEvent(runId, {
                type: 'update_activity',
                payload: {
                    id: strategyActivityId,
                    updates: {
                        status: 'done',
                        description: `Strategy ready: targeting ${strategy.targetPrice}. Leverage: ${strategy.keyLeveragePoints.slice(0, 2).join('; ')}`,
                    },
                },
            });
        } catch (err) {
            console.error(`[WEBHOOK] Strategy generation failed for ${vendor.name}:`, err);
            emitRunEvent(runId, {
                type: 'update_activity',
                payload: {
                    id: strategyActivityId,
                    updates: {
                        status: 'error',
                        description: `Strategy generation failed — will use default negotiation approach.`,
                    },
                },
            });
        }
    }

    console.log(`[WEBHOOK] All strategies generated — ${vendorStrategies.size}/${vendorsToNegotiate.length} succeeded`);

    // ===== PHASE 2: Fire negotiation calls with per-vendor strategies =====
    await prisma.run.update({ where: { id: runId }, data: { status: 'calling_round_2' } });

    // Create placeholder Call rows BEFORE firing calls (same pattern as round 1)
    const r2PlaceholderCalls = await Promise.all(
        vendorsToNegotiate.map(vendor =>
            prisma.call.create({
                data: {
                    runId,
                    vendorId: vendor.id,
                    round: 2,
                    status: 'pending',
                },
            })
        )
    );
    console.log(`[WEBHOOK] Created ${r2PlaceholderCalls.length} placeholder round 2 Call rows`);

    const callPromises = vendorsToNegotiate.map(async (vendor, i) => {
        const placeholderCall = r2PlaceholderCalls[i];
        try {
            const ctx = await assembleOutreachContext(runId, vendor.id);
            // Inject negotiation context
            ctx.bestPrice = bestPrice;
            ctx.bestSupplier = bestSupplier;
            ctx.targetPrice = targetPrice;
            ctx.competingOffers = competingText;

            // Inject the LLM-generated negotiation strategy
            ctx.negotiationPlan = vendorStrategies.get(vendor.id) ?? '';

            const { dialNumber } = resolveDialNumber(vendor.phone ?? '', i);
            const dynamicVars = buildDynamicVariables(ctx, runId, vendor.id, 2);

            const callResponse = await triggerOutboundCall({
                agentId: agentIdNegotiate,
                agentPhoneNumberId,
                toNumber: dialNumber,
                dynamicVariables: dynamicVars,
            });

            // Update placeholder row with conversationId + status
            const callStatus = callResponse.conversation_id ? 'in-progress' : 'failed';
            await prisma.call.update({
                where: { id: placeholderCall.id },
                data: {
                    conversationId: callResponse.conversation_id,
                    status: callStatus,
                },
            });

            if (!callResponse.conversation_id) {
                console.warn(`[WEBHOOK] Round 2 conversation_id is null for ${vendor.name} — marked as failed`);
            }

            console.log(`[WEBHOOK] Round 2 call placed → ${vendor.name} (${dialNumber}), status=${callStatus}`);
        } catch (err) {
            console.error(`[WEBHOOK] Round 2 call failed for ${vendor.name}:`, err);
            // Mark placeholder as failed so checkRoundCompletion doesn't hang
            await prisma.call.update({
                where: { id: placeholderCall.id },
                data: { status: 'failed' },
            }).catch(e => console.error(`[WEBHOOK] Failed to mark call as failed:`, e));
        }
    });
    await Promise.allSettled(callPromises);

    // Emit calls_change so frontend shows the round 2 calls
    await emitCallsChange(runId);

    console.log(`[WEBHOOK] All round 2 negotiation calls fired`);
}

/**
 * After all calls are done (round 2 or skipped negotiation),
 * compute final stats and emit summary to the frontend.
 */
async function finalizeSummary(runId: string) {
    console.log(`[WEBHOOK] ========== Finalizing Summary ==========`);

    const totalOffers = await prisma.offer.count({ where: { vendor: { runId } } });
    const allOffers = await prisma.offer.findMany({
        where: { vendor: { runId } },
        include: { vendor: true },
        orderBy: { unitPrice: 'asc' },
    });

    const bestOffer = allOffers.find(o => o.unitPrice != null);
    const vendorCount = new Set(allOffers.map(o => o.vendorId)).size;

    // Compute savings if we have both R1 and R2 offers from same vendor
    let savingsText = '';
    const r1Offers = allOffers.filter(o => o.source === 'voice-call-r1');
    const r2Offers = allOffers.filter(o => o.source === 'voice-call-r2');
    if (r1Offers.length > 0 && r2Offers.length > 0) {
        const r1Best = r1Offers[0]?.unitPrice ?? 0;
        const r2Best = r2Offers[0]?.unitPrice ?? 0;
        if (r1Best > 0 && r2Best > 0 && r2Best < r1Best) {
            const savings = ((r1Best - r2Best) / r1Best * 100).toFixed(1);
            savingsText = ` Negotiation saved ${savings}% ($${r1Best} → $${r2Best}).`;
        }
    }

    emitRunEvent(runId, {
        type: 'services_change',
        payload: { perplexity: false, elasticsearch: false, openai: false, stagehand: false, elevenlabs: false, visa: false },
    });
    emitRunEvent(runId, { type: 'stage_change', payload: { stage: 'complete' } });

    emitRunEvent(runId, {
        type: 'activity',
        payload: {
            id: makeActivityId(),
            type: 'system',
            title: 'Procurement Complete',
            description: `${vendorCount} vendors contacted, ${totalOffers} total quotes.${bestOffer ? ` Best: $${bestOffer.unitPrice}/unit from ${bestOffer.vendor.name}.` : ''}${savingsText}`,
            timestamp: new Date(),
            status: 'done',
            tool: 'orchestrator',
        },
    });

    emitRunEvent(runId, {
        type: 'summary',
        payload: {
            suppliersFound: vendorCount,
            quotesReceived: totalOffers,
            bestPrice: bestOffer?.unitPrice != null ? `$${bestOffer.unitPrice}` : 'N/A',
            bestSupplier: bestOffer?.vendor?.name ?? 'N/A',
            avgLeadTime: 'N/A',
            recommendation: bestOffer
                ? `Best price: $${bestOffer.unitPrice}/unit from ${bestOffer.vendor.name}.${savingsText} Ready to proceed with purchase.`
                : `${vendorCount} vendors contacted but no firm quotes extracted. Review call transcripts.`,
            nextSteps: [
                'Review all quotes in the quotes panel',
                'Select winning vendor and proceed to purchase order',
            ],
        },
    });

    await prisma.run.update({ where: { id: runId }, data: { status: 'complete' } });
    console.log(`[WEBHOOK] Run ${runId} COMPLETE — ${totalOffers} offers, best: $${bestOffer?.unitPrice ?? 'N/A'}`);
}
