// ElevenLabs Conversational AI client
// Handles outbound voice calls via Twilio integration
//
// Dynamic variables: the agent's prompt template lives on the ElevenLabs dashboard.
// We only pass DATA as dynamic variables — the dashboard prompt references them
// via {{variable_name}} syntax. We do NOT generate prompt text locally.

import { type OutreachContext } from './outreach';

// ─── Types ───────────────────────────────────────────────────────────

export interface OutboundCallRequest {
    agentId: string;
    agentPhoneNumberId: string;
    toNumber: string;
    /** Dynamic variables injected into the agent's prompt via {{var}} syntax */
    dynamicVariables?: Record<string, string>;
}

export interface OutboundCallResponse {
    success: boolean;
    message: string;
    conversation_id: string | null;  // null if call failed to initiate
    callSid: string;
}

// ─── Core API ────────────────────────────────────────────────────────

/**
 * Trigger an outbound call via ElevenLabs + Twilio.
 * Returns the conversation_id which we store in the Call row
 * so the webhook can map the transcript back.
 */
export async function triggerOutboundCall(
    req: OutboundCallRequest
): Promise<OutboundCallResponse> {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set');

    console.log(`[ELEVENLABS] triggerOutboundCall() — agent=${req.agentId}, to=${req.toNumber}`);

    const body: any = {
        agent_id: req.agentId,
        agent_phone_number_id: req.agentPhoneNumberId,
        to_number: req.toNumber,
    };

    if (req.dynamicVariables && Object.keys(req.dynamicVariables).length > 0) {
        body.conversation_initiation_client_data = {
            dynamic_variables: req.dynamicVariables,
        };
    }

    console.log(`[ELEVENLABS] Request body:`, JSON.stringify(body, null, 2));

    const res = await fetch('https://api.elevenlabs.io/v1/convai/twilio/outbound-call', {
        method: 'POST',
        headers: {
            'xi-api-key': apiKey,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });

    console.log(`[ELEVENLABS] Response status: ${res.status} ${res.statusText}`);

    if (!res.ok) {
        const errText = await res.text();
        console.error('[ELEVENLABS] API error:', res.status, errText.slice(0, 500));
        throw new Error(`ElevenLabs API error ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json();
    console.log(`[ELEVENLABS] Call initiated — conversation_id=${data.conversation_id}, callSid=${data.callSid}`);
    return data as OutboundCallResponse;
}

// ─── Dynamic variable builder ────────────────────────────────────────

/**
 * Build the dynamic variables object from OutreachContext.
 * These are pure DATA — no prompt text. The agent prompt on the
 * ElevenLabs dashboard references them via {{variable_name}}.
 *
 * Variables available in the dashboard prompt:
 *   {{vendor_name}}, {{vendor_phone}}, {{vendor_url}}, {{vendor_notes}},
 *   {{item}}, {{quantity}}, {{deadline}}, {{quality}},
 *   {{indicative_pricing}}, {{competing_offers}}, {{past_history}},
 *   {{best_price}}, {{best_supplier}}, {{target_price}}, {{negotiation_plan}} (round 2 only)
 */
export function buildDynamicVariables(
    ctx: OutreachContext,
    runId: string,
    vendorId: string,
    round: number
): Record<string, string> {
    const vars: Record<string, string> = {
        // IDs (for webhook → Call row mapping)
        run_id: runId,
        vendor_id: vendorId,
        round: String(round),

        // Vendor info
        vendor_name: ctx.vendorName,
        vendor_phone: ctx.vendorPhone,
        vendor_url: ctx.vendorUrl,
        vendor_notes: ctx.vendorNotes,

        // What we're buying
        item: ctx.item,
        quantity: ctx.quantity,
        deadline: ctx.deadline,
        quality: ctx.quality,

        // Market intelligence
        indicative_pricing: ctx.indicativePricing,
        competing_offers: ctx.competingOffers,
        past_history: ctx.pastHistory,

        // Negotiation context (populated for round 2+, empty strings for round 1)
        best_price: ctx.bestPrice,
        best_supplier: ctx.bestSupplier,
        target_price: ctx.targetPrice,

        // LLM-generated per-vendor negotiation strategy (round 2 only)
        negotiation_plan: ctx.negotiationPlan,
    };

    return vars;
}

/**
 * Resolve the phone number to dial.
 * If ELEVENLABS_TEST_PHONE_OVERRIDE is set (comma-separated list of phone numbers),
 * calls are round-robined across the list. With a batch size of 3 and 3 test phones,
 * each concurrent call goes to a different test number.
 *
 * .env.local example:
 *   ELEVENLABS_TEST_PHONE_OVERRIDE=+14155551111,+14155552222,+14155553333
 */
export function resolveDialNumber(vendorPhone: string, vendorIndex: number = 0): {
    dialNumber: string;
    isOverridden: boolean;
} {
    const override = process.env.ELEVENLABS_TEST_PHONE_OVERRIDE;
    if (override) {
        const phones = override.split(',').map(p => p.trim()).filter(Boolean);
        const picked = phones[vendorIndex % phones.length];
        console.log(`[ELEVENLABS] ⚠️  Phone override active — dialing ${picked} instead of ${vendorPhone} (index ${vendorIndex}, pool size ${phones.length})`);
        return { dialNumber: picked, isOverridden: true };
    }
    return { dialNumber: vendorPhone, isOverridden: false };
}
