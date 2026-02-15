// Negotiation strategy planner
// Uses OpenAI (ChatGPT) to generate per-vendor negotiation strategies from:
//   - Vendor's round 1 offer (Postgres)
//   - Vendor's Sonar discovery data (Elasticsearch, channel='search')
//   - Vendor's round 1 call transcript (Elasticsearch, channel='call')
//   - All competing offers from other vendors (Postgres)
//   - Best price / best supplier from round 1

import { retrieveMemory } from './elastic';
import OpenAI from 'openai';

// ─── Types ───────────────────────────────────────────────────────────

export interface NegotiationStrategyInput {
    vendorName: string;
    vendorId: string;
    runId: string;
    item: string;
    quantity: string;

    // Round 1 offer from this vendor
    r1UnitPrice: number | null;
    r1Moq: string | null;
    r1LeadTimeDays: number | null;
    r1Terms: string | null;
    r1Transcript: string | null;

    // Competitive landscape
    bestPrice: string;
    bestSupplier: string;
    allCompetingOffers: string; // formatted summary of all R1 offers from other vendors
}

export interface NegotiationStrategy {
    openingApproach: string;
    keyLeveragePoints: string[];
    targetPrice: string;
    fallbackPosition: string;
    talkingPoints: string;
    riskNotes: string;
}

// ─── ES data retrieval ───────────────────────────────────────────────

/**
 * Retrieve Sonar discovery data and round 1 call transcript from ES
 * for a specific vendor.
 */
export async function retrieveVendorIntelligence(
    item: string,
    vendorId: string,
): Promise<{ sonarData: string; callTranscript: string }> {
    let sonarData = '';
    let callTranscript = '';

    try {
        const [sonarRes, callRes] = await Promise.allSettled([
            retrieveMemory(item, { vendor_id: vendorId }),
            retrieveMemory(`call transcript ${item}`, { vendor_id: vendorId }),
        ]);

        if (sonarRes.status === 'fulfilled') {
            const hits = sonarRes.value.hits?.hits ?? [];
            sonarData = hits
                .filter((h: any) => (h._source as any)?.channel === 'search')
                .map((h: any) => (h._source as any)?.text ?? '')
                .filter(Boolean)
                .join(' | ');
        }

        if (callRes.status === 'fulfilled') {
            const hits = callRes.value.hits?.hits ?? [];
            callTranscript = hits
                .filter((h: any) => (h._source as any)?.channel === 'call')
                .map((h: any) => (h._source as any)?.text ?? '')
                .filter(Boolean)
                .join(' | ');
        }
    } catch (err) {
        console.warn('[NEGOTIATION] ES retrieval failed (non-fatal):', err);
    }

    return { sonarData, callTranscript };
}

// ─── OpenAI strategy generation ──────────────────────────────────────

/**
 * Generate a per-vendor negotiation strategy using OpenAI.
 * Uses available context (including Sonar data) to inform the strategy.
 *
 * Env var: OPENAI_API_KEY
 */
export async function generateNegotiationStrategy(
    input: NegotiationStrategyInput,
    sonarData: string,
    callTranscript: string,
): Promise<NegotiationStrategy> {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
        console.warn('[NEGOTIATION] OPENAI_API_KEY not set — using basic strategy');
        return buildFallbackStrategy(input);
    }

    const openai = new OpenAI({ apiKey });
    const prompt = buildStrategyPrompt(input, sonarData, callTranscript);

    try {
        console.log(`[NEGOTIATION] Generating strategy for ${input.vendorName} via OpenAI...`);

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "You are a procurement negotiation strategist. Output valid JSON." },
                { role: "user", content: prompt }
            ],
            response_format: { type: "json_object" },
            temperature: 0.3,
        });

        const content = completion.choices[0].message.content;
        console.log(`[NEGOTIATION] OpenAI raw response for ${input.vendorName}:`, content?.slice(0, 500));

        if (!content) return buildFallbackStrategy(input);

        const parsed = JSON.parse(content);

        return {
            openingApproach: parsed.opening_approach ?? 'Reference our previous conversation and mention we have competing quotes.',
            keyLeveragePoints: Array.isArray(parsed.key_leverage_points) ? parsed.key_leverage_points : [],
            targetPrice: parsed.target_price ?? input.bestPrice,
            fallbackPosition: parsed.fallback_position ?? 'Accept their current price if they improve lead time or payment terms.',
            talkingPoints: parsed.talking_points ?? `We have a competing offer at ${input.bestPrice}/unit. Can you match or beat that?`,
            riskNotes: parsed.risk_notes ?? 'Avoid revealing exact competing vendor names if possible.',
        };
    } catch (err) {
        console.error('[NEGOTIATION] OpenAI strategy generation failed:', err);
        return buildFallbackStrategy(input);
    }
}

// ─── Prompt builder ──────────────────────────────────────────────────

function buildStrategyPrompt(
    input: NegotiationStrategyInput,
    sonarData: string,
    callTranscript: string,
): string {
    return `You are a procurement negotiation strategist. Given the following data about a vendor and the competitive landscape, create a specific negotiation plan for a follow-up phone call.

VENDOR: ${input.vendorName}
ITEM WE'RE BUYING: ${input.item} (quantity: ${input.quantity})

THEIR ROUND 1 QUOTE:
- Unit price: ${input.r1UnitPrice != null ? `$${input.r1UnitPrice}` : 'Not quoted'}
- MOQ: ${input.r1Moq ?? 'Not specified'}
- Lead time: ${input.r1LeadTimeDays != null ? `${input.r1LeadTimeDays} days` : 'Not specified'}
- Payment terms: ${input.r1Terms ?? 'Not specified'}

VENDOR BACKGROUND (from our earlier research):
${sonarData || 'No background data available.'}

ROUND 1 CALL SUMMARY:
${callTranscript || input.r1Transcript || 'No transcript available.'}

COMPETING OFFERS FROM OTHER VENDORS:
${input.allCompetingOffers || 'No other quotes available.'}

BEST COMPETING PRICE: ${input.bestPrice}/unit from ${input.bestSupplier}

INSTRUCTIONS:
Create a negotiation strategy for a follow-up call with this vendor. The goal is to get a lower price, ideally matching or beating the best competing offer. Consider the vendor's strengths, weaknesses, and any leverage points from their background or the competitive landscape.

Output ONLY valid JSON with this structure:
{
  "opening_approach": "How to open the negotiation call — 1-2 natural sentences the AI agent should use to frame the conversation",
  "key_leverage_points": ["point1", "point2", "point3"],
  "target_price": "$X.XX — the price we should push for",
  "fallback_position": "What to accept if they can't hit the target — e.g. better terms, faster shipping, volume discount",
  "talking_points": "2-3 sentence guidance for the AI phone agent on how to conduct this specific negotiation. Be concrete.",
  "risk_notes": "Any risks or things to avoid mentioning during this call"
}`;
}

// ─── Fallback strategy ───────────────────────────────────────────────

function buildFallbackStrategy(input: NegotiationStrategyInput): NegotiationStrategy {
    const targetNum = input.r1UnitPrice != null
        ? `$${(input.r1UnitPrice * 0.87).toFixed(2)}`
        : input.bestPrice;

    return {
        openingApproach: `Reference our previous conversation about ${input.item} and mention we've received competitive quotes.`,
        keyLeveragePoints: [
            `We have a competing offer at ${input.bestPrice}/unit from another supplier`,
            'We are ready to place the order immediately if the price is right',
            'Volume commitment for repeat orders if terms are favorable',
        ],
        targetPrice: targetNum,
        fallbackPosition: 'If they cannot match the price, negotiate for better payment terms (net-60), faster lead time, or free shipping.',
        talkingPoints: `We spoke earlier about ${input.item}. Since then, we received a quote at ${input.bestPrice}/unit from ${input.bestSupplier}. We prefer working with you but need the price to be competitive. Can you match ${targetNum}/unit? We're ready to commit to the full order of ${input.quantity} today.`,
        riskNotes: 'Avoid being overly aggressive. If they seem firm on price, pivot to negotiating other terms like lead time or payment conditions.',
    };
}

/**
 * Format a NegotiationStrategy into a single string suitable for injection
 * as a dynamic variable into the ElevenLabs agent prompt.
 */
export function formatStrategyForAgent(strategy: NegotiationStrategy): string {
    const parts = [
        `APPROACH: ${strategy.openingApproach}`,
        `TARGET PRICE: ${strategy.targetPrice}`,
        `LEVERAGE: ${strategy.keyLeveragePoints.join('; ')}`,
        `TALKING POINTS: ${strategy.talkingPoints}`,
        `FALLBACK: ${strategy.fallbackPosition}`,
        `CAUTION: ${strategy.riskNotes}`,
    ];
    return parts.join('\n');
}
