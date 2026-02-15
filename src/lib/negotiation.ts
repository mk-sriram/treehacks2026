// Negotiation strategy planner
// Uses Gemini with grounded Google Search to generate per-vendor negotiation
// strategies from:
//   - Vendor's round 1 offer (Postgres)
//   - Vendor's Sonar discovery data (Elasticsearch, channel='search')
//   - Vendor's round 1 call transcript (Elasticsearch, channel='call')
//   - All competing offers from other vendors (Postgres)
//   - Best price / best supplier from round 1
//   - Live web search via Gemini's google_search tool (market pricing, vendor info)

import { retrieveMemory } from './elastic';

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

// ─── Gemini strategy generation (with grounded Google Search) ─────────

/**
 * Generate a per-vendor negotiation strategy using Gemini with grounded
 * Google Search. The google_search tool lets Gemini look up live market
 * pricing, vendor reputation, and industry benchmarks during generation.
 *
 * Falls back to a basic rule-based strategy if the API call fails.
 *
 * Env var: GEMINI_API_KEY
 */
export async function generateNegotiationStrategy(
    input: NegotiationStrategyInput,
    sonarData: string,
    callTranscript: string,
): Promise<NegotiationStrategy> {
    const geminiKey = process.env.GEMINI_API_KEY;

    if (!geminiKey) {
        console.warn('[NEGOTIATION] GEMINI_API_KEY not set — using basic strategy');
        return buildFallbackStrategy(input);
    }

    const prompt = buildStrategyPrompt(input, sonarData, callTranscript);

    try {
        console.log(`[NEGOTIATION] Generating strategy for ${input.vendorName} via Gemini + Google Search...`);

        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [
                        { parts: [{ text: prompt }] },
                    ],
                    tools: [
                        { google_search: {} },   // enable grounded web search
                    ],
                    generationConfig: {
                        temperature: 0.3,
                        responseMimeType: 'application/json',
                    },
                }),
            },
        );

        if (!res.ok) {
            const errText = await res.text();
            console.error(`[NEGOTIATION] Gemini API error: ${res.status}`, errText.slice(0, 400));
            return buildFallbackStrategy(input);
        }

        const data = await res.json();

        // Gemini response: candidates[0].content.parts[0].text
        const textContent = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        console.log(`[NEGOTIATION] Gemini raw response for ${input.vendorName}:`, textContent.slice(0, 500));

        // Log grounding metadata if present (search queries Gemini ran)
        const groundingMeta = data.candidates?.[0]?.groundingMetadata;
        if (groundingMeta?.searchEntryPoint) {
            console.log(`[NEGOTIATION] Gemini used grounded search for ${input.vendorName}`);
        }
        if (groundingMeta?.groundingChunks?.length) {
            console.log(`[NEGOTIATION] Grounding sources: ${groundingMeta.groundingChunks.length} web results used`);
        }

        // Parse JSON — strip markdown fences if Gemini wraps them
        const cleanJson = textContent.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
        const parsed = JSON.parse(cleanJson);

        return {
            openingApproach: parsed.opening_approach ?? 'Reference our previous conversation and mention we have competing quotes.',
            keyLeveragePoints: Array.isArray(parsed.key_leverage_points) ? parsed.key_leverage_points : [],
            targetPrice: parsed.target_price ?? input.bestPrice,
            fallbackPosition: parsed.fallback_position ?? 'Accept their current price if they improve lead time or payment terms.',
            talkingPoints: parsed.talking_points ?? `We have a competing offer at ${input.bestPrice}/unit. Can you match or beat that?`,
            riskNotes: parsed.risk_notes ?? 'Avoid revealing exact competing vendor names if possible.',
        };
    } catch (err) {
        console.error('[NEGOTIATION] Gemini strategy generation failed:', err);
        return buildFallbackStrategy(input);
    }
}

// ─── Prompt builder ──────────────────────────────────────────────────

function buildStrategyPrompt(
    input: NegotiationStrategyInput,
    sonarData: string,
    callTranscript: string,
): string {
    return `You are a procurement negotiation strategist with access to live web search. Given the following data about a vendor and the competitive landscape, create a specific negotiation plan for a follow-up phone call.

IMPORTANT: Use your Google Search capability to:
1. Look up current market pricing for "${input.item}" to validate whether the quotes we received are reasonable
2. Search for "${input.vendorName}" to find any public info about their pricing, reputation, or recent news
3. Find industry benchmarks for bulk pricing on this type of product

VENDOR: ${input.vendorName}
ITEM WE'RE BUYING: ${input.item} (quantity: ${input.quantity})

THEIR ROUND 1 QUOTE:
- Unit price: ${input.r1UnitPrice != null ? `$${input.r1UnitPrice}` : 'Not quoted'}
- MOQ: ${input.r1Moq ?? 'Not specified'}
- Lead time: ${input.r1LeadTimeDays != null ? `${input.r1LeadTimeDays} days` : 'Not specified'}
- Payment terms: ${input.r1Terms ?? 'Not specified'}

VENDOR BACKGROUND (from our earlier web research):
${sonarData || 'No background data available.'}

ROUND 1 CALL SUMMARY:
${callTranscript || input.r1Transcript || 'No transcript available.'}

COMPETING OFFERS FROM OTHER VENDORS:
${input.allCompetingOffers || 'No other quotes available.'}

BEST COMPETING PRICE: ${input.bestPrice}/unit from ${input.bestSupplier}

INSTRUCTIONS:
Create a negotiation strategy for a follow-up call with this vendor. The goal is to get a lower price, ideally matching or beating the best competing offer. Factor in any market pricing data you found via web search. Consider the vendor's strengths, weaknesses, and any leverage points from their background or the competitive landscape.

Output ONLY valid JSON with this structure:
{
  "opening_approach": "How to open the negotiation call — 1-2 natural sentences the AI agent should use to frame the conversation",
  "key_leverage_points": ["point1", "point2", "point3"],
  "target_price": "$X.XX — the price we should push for, informed by market research",
  "fallback_position": "What to accept if they can't hit the target — e.g. better terms, faster shipping, volume discount",
  "talking_points": "2-3 sentence guidance for the AI phone agent on how to conduct this specific negotiation. Be concrete, reference the data above and any market pricing found via search. This will be directly injected into the agent's prompt.",
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
