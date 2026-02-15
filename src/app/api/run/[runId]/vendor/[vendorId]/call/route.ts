// API route: trigger an outbound call to a specific vendor
// POST /api/run/[runId]/vendor/[vendorId]/call
//
// Body: { round?: number }  (defaults to 1)
// Returns: { callId, conversationId, callSid, vendor, round }

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { triggerOutboundCall, buildDynamicVariables, resolveDialNumber } from '@/lib/elevenlabs';
import { assembleOutreachContext } from '@/lib/outreach';

export async function POST(
    req: Request,
    { params }: { params: Promise<{ runId: string; vendorId: string }> }
) {
    const { runId, vendorId } = await params;
    console.log(`[API /call] POST — runId=${runId}, vendorId=${vendorId}`);

    try {
        const body = await req.json().catch(() => ({}));
        const round = body.round ?? 1;

        // 1. Load vendor to get phone number
        const vendor = await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });
        if (!vendor.phone) {
            return NextResponse.json(
                { error: `Vendor "${vendor.name}" has no phone number` },
                { status: 400 }
            );
        }

        // 2. Validate ElevenLabs env vars
        const agentIdQuote = process.env.ELEVENLABS_AGENT_ID_QUOTE;
        const agentIdNegotiate = process.env.ELEVENLABS_AGENT_ID_NEGOTIATE;
        const agentPhoneNumberId = process.env.ELEVENLABS_PHONE_NUMBER_ID;
        if (!agentIdQuote || !agentPhoneNumberId) {
            return NextResponse.json(
                { error: 'Missing ELEVENLABS_AGENT_ID_QUOTE or ELEVENLABS_PHONE_NUMBER_ID env vars' },
                { status: 500 }
            );
        }
        const agentId = round >= 2 ? (agentIdNegotiate || agentIdQuote) : agentIdQuote;

        // 3. Assemble outreach context (PG + ES)
        console.log(`[API /call] Assembling outreach context...`);
        const ctx = await assembleOutreachContext(runId, vendorId);

        // 4. Resolve phone number (may be overridden for testing)
        const { dialNumber, isOverridden } = resolveDialNumber(vendor.phone);
        if (isOverridden) {
            console.log(`[API /call] ⚠️ TEST MODE: Calling ${dialNumber} instead of ${vendor.phone}`);
        }

        // 5. Build dynamic variables (all context injected via {{var}} templates)
        const dynamicVariables = buildDynamicVariables(ctx, runId, vendorId, round);

        // 6. Trigger the outbound call
        console.log(`[API /call] Triggering ElevenLabs outbound call to ${dialNumber}...`);
        const callResponse = await triggerOutboundCall({
            agentId,
            agentPhoneNumberId,
            toNumber: dialNumber,
            dynamicVariables,
        });

        // 7. Create Call row in Postgres
        const call = await prisma.call.create({
            data: {
                vendorId,
                runId,
                round,
                conversationId: callResponse.conversation_id,
                status: 'in-progress',
            },
        });

        console.log(`[API /call] Call created — id=${call.id}, conversationId=${callResponse.conversation_id}`);

        return NextResponse.json({
            callId: call.id,
            conversationId: callResponse.conversation_id,
            callSid: callResponse.callSid,
            vendor: vendor.name,
            round,
            testMode: isOverridden,
        });
    } catch (err: any) {
        console.error(`[API /call] Error:`, err);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
