// Webhook handler for ElevenLabs post-call events
// Receives transcript after a call completes, extracts offer terms via LLM,
// writes to Postgres (truth) and Elasticsearch (memory).
// Also drives the pipeline forward: round 1 → negotiation → summary.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { writeMemory } from '@/lib/elastic';
import { emitRunEvent } from '@/lib/events';
import { triggerOutboundCall, buildDynamicVariables, resolveDialNumber } from '@/lib/elevenlabs';
import { assembleOutreachContext } from '@/lib/outreach';

let webhookActivityCounter = 0;
function makeActivityId() {
    webhookActivityCounter++;
    return `wh-${Date.now()}-${webhookActivityCounter}-${Math.random().toString(36).slice(2, 6)}`;
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
                return handlePostCallTranscription(body);
            case 'call_initiation_failure':
                return handleCallInitiationFailure(body);
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

// ─── post_call_transcription handler ─────────────────────────────────

async function handlePostCallTranscription(body: any) {
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
        return NextResponse.json({ received: true, error: 'no conversation_id' }, { status: 200 });
    }

    // 1. Find the Call row by conversationId
    const call = await prisma.call.findUnique({
        where: { conversationId },
        include: { vendor: true },
    });

    if (!call) {
        console.error(`[WEBHOOK] No Call row found for conversationId=${conversationId}`);
        return NextResponse.json({ received: true, error: 'call not found' }, { status: 200 });
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

    // 3. Extract structured offer terms from the transcript via LLM
    const extractedOffer = await extractOfferViaLLM(transcriptText, call.vendor.name, analysis);

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
                : `Call completed but no clear quote extracted. Transcript stored for review.`,
            timestamp: new Date(),
            status: 'done',
            tool: 'elevenlabs',
        },
    });

    emitRunEvent(call.runId, {
        type: 'call_update',
        payload: {
            vendorId: call.vendorId,
            vendorName: call.vendor.name,
            status: 'completed',
            round: call.round,
            hasOffer: !!extractedOffer,
            duration: callDurationSecs,
        },
    });

    console.log(`[WEBHOOK] Done processing transcription for ${call.vendor.name}`);

    // 6. Check if all calls for this round are done — advance the pipeline
    checkRoundCompletion(call.runId, call.round).catch(err =>
        console.error(`[WEBHOOK] checkRoundCompletion error (non-fatal):`, err)
    );

    return NextResponse.json({ received: true, handled: true });
}

// ─── call_initiation_failure handler ─────────────────────────────────

async function handleCallInitiationFailure(body: any) {
    const data = body.data;
    const conversationId = data?.conversation_id;
    const failureReason = data?.failure_reason ?? 'unknown';

    console.log(`[WEBHOOK] Call initiation failure — conversation_id=${conversationId}, reason=${failureReason}`);

    if (!conversationId) {
        return NextResponse.json({ received: true, error: 'no conversation_id' }, { status: 200 });
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

        // Check if all calls for this round are done — advance the pipeline
        checkRoundCompletion(call.runId, call.round).catch(err =>
            console.error(`[WEBHOOK] checkRoundCompletion error (non-fatal):`, err)
        );
    }

    return NextResponse.json({ received: true, handled: true });
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
 * Falls back gracefully if the LLM call fails.
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

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
        console.warn('[WEBHOOK] OPENAI_API_KEY not set — skipping LLM extraction');
        // If ElevenLabs gave us data_collection_results, try to use those
        return parseElevenLabsAnalysis(elevenLabsAnalysis);
    }

    const extractionPrompt = `You are a procurement data extraction system. Analyze this phone call transcript between our procurement agent and ${vendorName}. Extract any pricing or offer information discussed.

TRANSCRIPT:
${transcript.slice(0, 3000)}

${elevenLabsAnalysis?.transcript_summary ? `CALL SUMMARY: ${elevenLabsAnalysis.transcript_summary}` : ''}

Extract the following fields. If a field was not discussed or is unclear, set it to null.
Return ONLY valid JSON, no markdown, no explanation:

{
  "unit_price": <number or null — the per-unit price in USD. Convert from other currencies if mentioned.>,
  "total_price": <number or null — if they quoted a total rather than per-unit>,
  "moq": <string or null — minimum order quantity, e.g. "100 units" or "1 pallet">,
  "lead_time_days": <integer or null — delivery/lead time in business days>,
  "shipping": <string or null — shipping method, cost, or terms mentioned>,
  "payment_terms": <string or null — e.g. "net-30", "credit card", "wire transfer", "COD">,
  "confidence": <integer 1-100 — how confident you are that the vendor gave a real, actionable quote vs. vague discussion>,
  "notes": <string or null — any important context like "price only valid for 7 days" or "requires credit application">
}`;

    try {
        console.log(`[WEBHOOK] Calling OpenAI for offer extraction...`);
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${openaiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: extractionPrompt }],
                temperature: 0,
                response_format: { type: 'json_object' },
            }),
        });

        if (!res.ok) {
            const errText = await res.text();
            console.error(`[WEBHOOK] OpenAI API error: ${res.status}`, errText.slice(0, 300));
            return parseElevenLabsAnalysis(elevenLabsAnalysis);
        }

        const data = await res.json();
        const content = data.choices?.[0]?.message?.content ?? '';
        console.log(`[WEBHOOK] OpenAI extraction result:`, content.slice(0, 500));

        const parsed = JSON.parse(content);

        // Compute unit price from total if only total was given
        let unitPrice = parsed.unit_price;
        if (unitPrice == null && parsed.total_price != null) {
            // We don't know quantity here, store total as unit price with a note
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
        console.error('[WEBHOOK] LLM extraction failed:', err);
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
    const pendingCalls = await prisma.call.count({
        where: { runId, round, status: 'in-progress' },
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

    const bestOffer = round1Offers[0];
    const bestPrice = bestOffer.unitPrice != null ? String(bestOffer.unitPrice) : '';
    const bestSupplier = bestOffer.vendor.name;
    // Target 10-15% below best price
    const targetPrice = bestOffer.unitPrice != null
        ? String(Math.round(bestOffer.unitPrice * 0.87 * 100) / 100)
        : '';

    // Build competing offers text
    const competingText = round1Offers
        .map(o => `${o.vendor.name}: $${o.unitPrice}/unit, ${o.leadTimeDays ?? '?'} day lead time`)
        .join('; ');

    // Get vendors to negotiate with (all who gave a round 1 offer)
    const vendorsToNegotiate = round1Offers.map(o => o.vendor);

    emitRunEvent(runId, {
        type: 'activity',
        payload: {
            id: makeActivityId(),
            type: 'system',
            title: 'Starting Negotiation Round',
            description: `Round 1 collected ${round1Offers.length} quotes. Best: $${bestPrice}/unit from ${bestSupplier}. Target: $${targetPrice}/unit. Calling ${vendorsToNegotiate.length} vendors.`,
            timestamp: new Date(),
            status: 'running',
            tool: 'elevenlabs',
        },
    });

    await prisma.run.update({ where: { id: runId }, data: { status: 'calling_round_2' } });

    const MAX_CONCURRENT = 3;
    for (let i = 0; i < vendorsToNegotiate.length; i += MAX_CONCURRENT) {
        const batch = vendorsToNegotiate.slice(i, i + MAX_CONCURRENT);
        const promises = batch.map(async (vendor, batchIdx) => {
            try {
                const ctx = await assembleOutreachContext(runId, vendor.id);
                // Inject negotiation context
                ctx.bestPrice = bestPrice;
                ctx.bestSupplier = bestSupplier;
                ctx.targetPrice = targetPrice;
                ctx.competingOffers = competingText;

                const vendorIndex = i + batchIdx;
                const { dialNumber } = resolveDialNumber(vendor.phone ?? '', vendorIndex);
                const dynamicVars = buildDynamicVariables(ctx, runId, vendor.id, 2);

                const callResponse = await triggerOutboundCall({
                    agentId: agentIdNegotiate,
                    agentPhoneNumberId,
                    toNumber: dialNumber,
                    dynamicVariables: dynamicVars,
                });

                await prisma.call.create({
                    data: {
                        runId,
                        vendorId: vendor.id,
                        round: 2,
                        status: 'in-progress',
                        conversationId: callResponse.conversation_id,
                    },
                });

                console.log(`[WEBHOOK] Round 2 call placed → ${vendor.name} (${dialNumber})`);
            } catch (err) {
                console.error(`[WEBHOOK] Round 2 call failed for ${vendor.name}:`, err);
            }
        });
        await Promise.allSettled(promises);
    }

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
