// TEST ENDPOINT: Skip discovery + calls, jump straight to the post-negotiation flow.
// Creates a fake run with fake vendors + R1/R2 offers, then triggers finalizeSummary.
// This lets you test the round 3 confirmation call → email pipeline in isolation.
//
// Usage:
//   POST /api/test-finalize
//   Body (all optional — sensible defaults provided):
//   {
//     "item": "M8 steel bolts",
//     "quantity": "5000",
//     "vendorName": "Acme Industrial",
//     "vendorPhone": "+14155551234",
//     "vendorEmail": "sales@acme.com",
//     "r1Price": 4.50,
//     "r2Price": 3.94,
//     "leadTimeDays": 14,
//     "shipping": "Free over 1000 units",
//     "terms": "Net 30",
//     "moq": "500 units"
//   }

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { emitRunEvent } from '@/lib/events';
import { resolveWinner, triggerConfirmationCall, sendConfirmationEmailToWinner } from '@/lib/finalize';

export async function POST(req: Request) {
    console.log(`[TEST-FINALIZE] Creating test run to exercise post-negotiation flow...`);

    try {
        const body = await req.json().catch(() => ({}));

        const item = body.item ?? 'M8 steel bolts';
        const quantity = body.quantity ?? '5000';
        const vendorName = body.vendorName ?? 'Acme Industrial Supplies';
        const vendorPhone = body.vendorPhone ?? '+15551234567';
        const vendorEmail = body.vendorEmail ?? body.email ?? null;
        const r1Price = body.r1Price ?? 4.50;
        const r2Price = body.r2Price ?? 3.94;
        const leadTimeDays = body.leadTimeDays ?? 14;
        const shipping = body.shipping ?? 'Free shipping over 1000 units';
        const terms = body.terms ?? 'Net 30';
        const moq = body.moq ?? '500 units';

        // 1. Create a run
        const run = await prisma.run.create({
            data: {
                rawQuery: `Test: ${quantity} ${item}`,
                parsedSpec: { item, quantity, leadTime: '2 weeks', quality: 'standard', location: 'US' },
                status: 'summarizing',
            },
        });
        console.log(`[TEST-FINALIZE] Run created: ${run.id}`);

        // 2. Create a vendor
        const vendor = await prisma.vendor.create({
            data: {
                runId: run.id,
                name: vendorName,
                phone: vendorPhone,
                email: vendorEmail,
                source: 'sonar',
                metadata: { notes: 'Test vendor for finalize flow' },
            },
        });
        console.log(`[TEST-FINALIZE] Vendor created: ${vendor.id} (${vendorName}, email=${vendorEmail ?? 'none'})`);

        // Optionally create a second vendor (loser) to make the comparison realistic
        const loserVendor = await prisma.vendor.create({
            data: {
                runId: run.id,
                name: 'Budget Parts Co',
                phone: '+15559876543',
                email: 'sales@budgetparts.com',
                source: 'sonar',
                metadata: { notes: 'Test vendor (loser)' },
            },
        });

        // 3. Create R1 offer (initial quote)
        const r1Offer = await prisma.offer.create({
            data: {
                vendorId: vendor.id,
                unitPrice: r1Price,
                moq,
                leadTimeDays,
                shipping,
                terms,
                confidence: 85,
                source: 'voice-call-r1',
                rawEvidence: `Agent: What is your best price for ${quantity} ${item}?\nVendor: We can do $${r1Price} per unit with a ${leadTimeDays}-day lead time.`,
            },
        });
        console.log(`[TEST-FINALIZE] R1 offer created: $${r1Price}/unit`);

        // 4. Create R2 offer (negotiated)
        const r2Offer = await prisma.offer.create({
            data: {
                vendorId: vendor.id,
                unitPrice: r2Price,
                moq,
                leadTimeDays,
                shipping,
                terms,
                confidence: 92,
                source: 'voice-call-r2',
                rawEvidence: `Agent: Can you do better on price? We have a competing offer.\nVendor: OK, I can come down to $${r2Price} per unit for that volume.`,
            },
        });
        console.log(`[TEST-FINALIZE] R2 offer created: $${r2Price}/unit (negotiated from $${r1Price})`);

        // Create a loser R1 offer (higher price)
        await prisma.offer.create({
            data: {
                vendorId: loserVendor.id,
                unitPrice: r1Price * 1.15,
                moq: '1000 units',
                leadTimeDays: leadTimeDays + 7,
                shipping: 'Standard shipping',
                terms: 'Net 15',
                confidence: 70,
                source: 'voice-call-r1',
                rawEvidence: 'Test data for loser vendor',
            },
        });

        // 5. Create completed Call rows so the pipeline state is consistent
        await prisma.call.createMany({
            data: [
                { runId: run.id, vendorId: vendor.id, round: 1, status: 'completed', duration: 45 },
                { runId: run.id, vendorId: vendor.id, round: 2, status: 'completed', duration: 62 },
                { runId: run.id, vendorId: loserVendor.id, round: 1, status: 'completed', duration: 38 },
            ],
        });

        console.log(`[TEST-FINALIZE] Test data ready. Triggering finalizeSummary...`);
        console.log(`[TEST-FINALIZE] ──────────────────────────────────────`);
        console.log(`[TEST-FINALIZE]   Run ID:       ${run.id}`);
        console.log(`[TEST-FINALIZE]   Winner:       ${vendorName}`);
        console.log(`[TEST-FINALIZE]   R1 price:     $${r1Price}`);
        console.log(`[TEST-FINALIZE]   R2 price:     $${r2Price}`);
        console.log(`[TEST-FINALIZE]   Savings:      ${(((r1Price - r2Price) / r1Price) * 100).toFixed(1)}%`);
        console.log(`[TEST-FINALIZE]   Vendor email: ${vendorEmail ?? '(none — email will be skipped)'}`);
        console.log(`[TEST-FINALIZE]   Vendor phone: ${vendorPhone}`);
        console.log(`[TEST-FINALIZE] ──────────────────────────────────────`);
        console.log(`[TEST-FINALIZE] Pipeline: finalizeSummary → round 3 call → email`);
        console.log(`[TEST-FINALIZE] Open /api/run/${run.id}/events in browser for SSE stream.`);

        // 6. Trigger the post-negotiation pipeline in background
        void (async () => {
            try {
                // Resolve the winner from offers
                const { winner, allFinal, totalOffers: total, vendorCount: vc, savingsText } = await resolveWinner(run.id);
                console.log(`[TEST-FINALIZE] Winner resolved: ${winner?.vendorName ?? 'none'} at $${winner?.finalPrice ?? 'N/A'}`);

                // Emit summary events
                emitRunEvent(run.id, { type: 'stage_change', payload: { stage: 'complete' } });
                emitRunEvent(run.id, {
                    type: 'activity',
                    payload: {
                        id: `tf-${Date.now()}`,
                        type: 'system',
                        title: 'Procurement Complete',
                        description: `${vc} vendors, ${total} quotes.${winner ? ` Best: $${winner.finalPrice}/unit from ${winner.vendorName}${winner.wasNegotiated ? ' (negotiated)' : ''}.` : ''}${savingsText}`,
                        timestamp: new Date(),
                        status: 'done',
                        tool: 'orchestrator',
                    },
                });
                emitRunEvent(run.id, {
                    type: 'summary',
                    payload: {
                        suppliersFound: vc,
                        quotesReceived: total,
                        bestPrice: winner?.finalPrice != null ? `$${winner.finalPrice}` : 'N/A',
                        bestSupplier: winner?.vendorName ?? 'N/A',
                        negotiated: winner?.wasNegotiated ?? false,
                        originalPrice: winner?.originalPrice != null ? `$${winner.originalPrice}` : null,
                        savingsPercent: winner?.savingsPercent != null ? `${winner.savingsPercent}%` : null,
                        recommendation: winner
                            ? `Best: $${winner.finalPrice}/unit from ${winner.vendorName}.${savingsText}`
                            : 'No quotes.',
                    },
                });

                if (!winner) {
                    await prisma.run.update({ where: { id: run.id }, data: { status: 'complete' } });
                    return;
                }

                // Try round 3 confirmation call
                const callPlaced = await triggerConfirmationCall(run.id, winner);

                if (!callPlaced) {
                    // Call was skipped or failed — send email directly
                    console.log(`[TEST-FINALIZE] Confirmation call skipped — sending email directly`);
                    await prisma.run.update({ where: { id: run.id }, data: { status: 'sending_confirmation' } });
                    await sendConfirmationEmailToWinner(run.id);
                }
                // If call was placed, the webhook will handle round 3 completion → email
            } catch (err) {
                console.error(`[TEST-FINALIZE] Pipeline error:`, err);
            }
        })();

        return NextResponse.json({
            success: true,
            runId: run.id,
            sseUrl: `/api/run/${run.id}/events`,
            winner: {
                vendor: vendorName,
                r1Price,
                r2Price,
                savings: `${(((r1Price - r2Price) / r1Price) * 100).toFixed(1)}%`,
                email: vendorEmail,
                phone: vendorPhone,
            },
            pipeline: [
                'finalizeSummary → picks winner',
                'round 3 confirmation call (ElevenLabs)',
                'webhook processes transcript',
                'sendConfirmationEmailToWinner (AgentMail)',
                'webhook receives invoice reply',
            ],
            note: `Open /api/run/${run.id}/events in a new tab to see SSE events in real time.`,
        });
    } catch (err: any) {
        console.error('[TEST-FINALIZE] Error:', err);
        return NextResponse.json({ error: err.message, stack: err.stack }, { status: 500 });
    }
}
