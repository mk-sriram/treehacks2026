// Shared finalize logic — used by both the webhook pipeline and the test endpoint.
// Resolves offers to per-vendor winners, triggers round 3 call, sends email.

import { prisma } from './db';
import { emitRunEvent, activateService, deactivateService, resetServices } from './events';
import { sendConfirmationEmail } from './agentmail';
import { triggerOutboundCall, resolveDialNumber } from './elevenlabs';

let counter = 0;
function makeActivityId() {
    counter++;
    return `fin-${Date.now()}-${counter}-${Math.random().toString(36).slice(2, 6)}`;
}

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
            status: c.status === 'in-progress' ? 'connected' : c.status === 'completed' ? 'ended' : c.status === 'failed' ? 'ended' : c.status === 'processing' ? 'ended' : 'ringing',
            duration: c.duration ?? 0,
        })),
    });
}

// ─── Types ───────────────────────────────────────────────────────────

export interface ResolvedWinner {
    vendorId: string;
    vendorName: string;
    vendorEmail: string | null;
    vendorPhone: string | null;
    finalOffer: {
        unitPrice: number | null;
        moq: string | null;
        leadTimeDays: number | null;
        shipping: string | null;
        terms: string | null;
    };
    originalPrice: number | null;
    finalPrice: number | null;
    wasNegotiated: boolean;
    savingsPercent: number | null;
}

// ─── Resolve winner from offers ──────────────────────────────────────

/**
 * Given a runId, resolves all offers to per-vendor final offers (R2 preferred)
 * and returns the winner (cheapest final price).
 */
export async function resolveWinner(runId: string): Promise<{
    winner: ResolvedWinner | null;
    allFinal: ResolvedWinner[];
    totalOffers: number;
    vendorCount: number;
    savingsText: string;
}> {
    const allOffers = await prisma.offer.findMany({
        where: { vendor: { runId } },
        include: { vendor: true },
        orderBy: { createdAt: 'desc' },
    });

    const totalOffers = allOffers.length;
    const vendorIds = [...new Set(allOffers.map(o => o.vendorId))];
    const vendorCount = vendorIds.length;

    const finalOffers: ResolvedWinner[] = [];

    for (const vendorId of vendorIds) {
        const vendorOffers = allOffers.filter(o => o.vendorId === vendorId);
        const r2 = vendorOffers.find(o => o.source === 'voice-call-r2');
        const r1 = vendorOffers.find(o => o.source === 'voice-call-r1');
        const finalOffer = r2 ?? r1;
        if (!finalOffer) continue;

        const wasNegotiated = !!r2;
        const originalPrice = r1?.unitPrice ?? null;
        const finalPrice = finalOffer.unitPrice;

        let savingsPercent: number | null = null;
        if (wasNegotiated && originalPrice != null && finalPrice != null && originalPrice > 0 && finalPrice < originalPrice) {
            savingsPercent = Math.round(((originalPrice - finalPrice) / originalPrice) * 1000) / 10;
        }

        finalOffers.push({
            vendorId: vendorId as string,
            vendorName: finalOffer.vendor.name as string,
            vendorEmail: 'mksriram24@gmail.com',  // hardcoded for demo
            vendorPhone: (finalOffer.vendor.phone as string) ?? null,
            finalOffer: {
                unitPrice: finalOffer.unitPrice,
                moq: finalOffer.moq,
                leadTimeDays: finalOffer.leadTimeDays,
                shipping: finalOffer.shipping,
                terms: finalOffer.terms,
            },
            originalPrice,
            finalPrice,
            wasNegotiated,
            savingsPercent,
        });
    }

    finalOffers.sort((a, b) => {
        if (a.finalPrice == null) return 1;
        if (b.finalPrice == null) return -1;
        return a.finalPrice - b.finalPrice;
    });

    const winner = finalOffers.find(o => o.finalPrice != null) ?? null;

    let savingsText = '';
    if (winner?.wasNegotiated && winner.savingsPercent != null && winner.originalPrice != null) {
        savingsText = ` Negotiation saved ${winner.savingsPercent}% ($${winner.originalPrice} → $${winner.finalPrice}).`;
    } else {
        const anyNeg = finalOffers.find(o => o.wasNegotiated && o.savingsPercent != null && o.savingsPercent > 0);
        if (anyNeg) {
            savingsText = ` Negotiation reduced ${anyNeg.vendorName} from $${anyNeg.originalPrice} to $${anyNeg.finalPrice} (${anyNeg.savingsPercent}% savings).`;
        }
    }

    return { winner, allFinal: finalOffers, totalOffers, vendorCount, savingsText };
}

// ─── Round 3 confirmation call ───────────────────────────────────────

/**
 * Call the winning vendor to verbally confirm the deal.
 * Returns true if call was placed, false if skipped/failed (email should be sent directly).
 */
export async function triggerConfirmationCall(runId: string, winner: ResolvedWinner): Promise<boolean> {
    const agentIdConfirm = process.env.ELEVENLABS_AGENT_ID_CONFIRM;
    const agentPhoneNumberId = process.env.ELEVENLABS_PHONE_NUMBER_ID;

    if (!agentIdConfirm || !agentPhoneNumberId || !winner.vendorPhone) {
        console.log(`[FINALIZE] Skipping confirmation call (agent=${!!agentIdConfirm}, phone=${!!winner.vendorPhone})`);
        return false;
    }

    const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
    const spec = run.parsedSpec as { item: string; quantity: string };

    const { dialNumber, isOverridden } = resolveDialNumber(winner.vendorPhone ?? '', winner.vendorId);

    activateService(runId, 'elevenlabs');

    const callActivityId = makeActivityId();
    emitRunEvent(runId, {
        type: 'activity',
        payload: {
            id: callActivityId,
            type: 'call',
            title: `Confirmation call to ${winner.vendorName}`,
            description: `Calling back to confirm: $${winner.finalPrice}/unit for ${spec.quantity} ${spec.item}${winner.wasNegotiated ? ` (negotiated from $${winner.originalPrice})` : ''}. Will mention sending email confirmation.`,
            timestamp: new Date(),
            status: 'running',
            tool: 'elevenlabs',
        },
    });

    // Compute total amount for payment (unit price * quantity, fallback to unit price)
    const qtyNum = parseFloat(spec.quantity) || 1;
    const totalAmount = winner.finalPrice != null ? (winner.finalPrice * qtyNum).toFixed(2) : '';

    const dynamicVars: Record<string, string> = {
        run_id: runId,
        vendor_id: winner.vendorId,
        round: '3',
        vendor_name: winner.vendorName,
        item: spec.item,
        quantity: spec.quantity,
        agreed_price: winner.finalPrice != null ? `$${winner.finalPrice}` : '',
        total_amount: totalAmount,
        original_price: winner.originalPrice != null ? `$${winner.originalPrice}` : '',
        was_negotiated: winner.wasNegotiated ? 'yes' : 'no',
        savings_percent: winner.savingsPercent != null ? `${winner.savingsPercent}%` : '',
        lead_time: winner.finalOffer.leadTimeDays != null ? `${winner.finalOffer.leadTimeDays} days` : '',
        shipping: winner.finalOffer.shipping ?? '',
        payment_terms: winner.finalOffer.terms ?? '',
        moq: winner.finalOffer.moq ?? '',
        vendor_email: winner.vendorEmail ?? '',
        seller_wallet_address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    };

    try {
        const callResponse = await triggerOutboundCall({
            agentId: agentIdConfirm,
            agentPhoneNumberId,
            toNumber: dialNumber,
            dynamicVariables: dynamicVars,
        });

        const callStatus = callResponse.conversation_id ? 'in-progress' : 'failed';
        await prisma.call.create({
            data: {
                runId,
                vendorId: winner.vendorId,
                round: 3,
                status: callStatus,
                conversationId: callResponse.conversation_id,
            },
        });

        await prisma.run.update({ where: { id: runId }, data: { status: 'calling_round_3' } });

        emitRunEvent(runId, {
            type: 'update_activity',
            payload: {
                id: callActivityId,
                updates: {
                    status: callStatus === 'in-progress' ? 'running' : 'error',
                    description: callStatus === 'in-progress'
                        ? `Confirmation call in progress with ${winner.vendorName}${isOverridden ? ' (test mode)' : ''}. Confirming deal terms...`
                        : `Confirmation call failed to connect. Will proceed to send email.`,
                },
            },
        });

        await emitCallsChange(runId);

        if (!callResponse.conversation_id) {
            console.log(`[FINALIZE] Call failed to connect — returning false`);
            return false;
        }

        console.log(`[FINALIZE] Round 3 call placed — webhook will handle the rest`);
        return true;
    } catch (err) {
        console.error(`[FINALIZE] Confirmation call failed:`, err);

        await prisma.call.create({
            data: { runId, vendorId: winner.vendorId, round: 3, status: 'failed' },
        }).catch(e => console.error(`[FINALIZE] Failed to create failed call row:`, e));

        emitRunEvent(runId, {
            type: 'update_activity',
            payload: {
                id: callActivityId,
                updates: {
                    status: 'error',
                    description: `Confirmation call failed: ${(err as Error).message}. Proceeding to send email.`,
                },
            },
        });

        return false;
    }
}

// ─── Send confirmation email ─────────────────────────────────────────

/**
 * Look up the winner for a run and send the confirmation email.
 * Used after round 3 call and as fallback when call is skipped.
 */
export async function sendConfirmationEmailToWinner(runId: string) {
    console.log(`[FINALIZE] Sending confirmation email for run ${runId}...`);

    const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
    const spec = run.parsedSpec as { item: string; quantity: string };

    const { winner } = await resolveWinner(runId);

    if (!winner) {
        console.log(`[FINALIZE] No winner — marking complete`);
        await prisma.run.update({ where: { id: runId }, data: { status: 'complete' } });
        resetServices(runId);
        emitRunEvent(runId, { type: 'stage_change', payload: { stage: 'complete' } });
        return;
    }

    if (!winner.vendorEmail) {
        console.log(`[FINALIZE] Winner ${winner.vendorName} has no email — skipping`);
        emitRunEvent(runId, {
            type: 'activity',
            payload: {
                id: makeActivityId(),
                type: 'email',
                title: `No email for ${winner.vendorName}`,
                description: `Winning vendor has no email on file — confirmation email skipped. Manual outreach required.`,
                timestamp: new Date(),
                status: 'done',
                tool: 'agentmail',
            },
        });
        await prisma.run.update({ where: { id: runId }, data: { status: 'complete' } });
        resetServices(runId);
        emitRunEvent(runId, { type: 'stage_change', payload: { stage: 'complete' } });
        return;
    }

    const emailActivityId = makeActivityId();
    emitRunEvent(runId, {
        type: 'activity',
        payload: {
            id: emailActivityId,
            type: 'email',
            title: `Sending confirmation to ${winner.vendorName}`,
            description: `Emailing ${winner.vendorEmail} with confirmed deal terms and invoice request...`,
            timestamp: new Date(),
            status: 'running',
            tool: 'agentmail',
        },
    });

    try {
        const emailResult = await sendConfirmationEmail({
            runId,
            vendorId: winner.vendorId,
            vendorName: winner.vendorName,
            vendorEmail: winner.vendorEmail,
            item: spec.item,
            quantity: spec.quantity,
            unitPrice: winner.finalPrice!,
            originalPrice: winner.originalPrice,
            wasNegotiated: winner.wasNegotiated,
            savingsPercent: winner.savingsPercent,
            leadTimeDays: winner.finalOffer.leadTimeDays,
            shipping: winner.finalOffer.shipping,
            terms: winner.finalOffer.terms,
            moq: winner.finalOffer.moq,
        });

        emitRunEvent(runId, {
            type: 'update_activity',
            payload: {
                id: emailActivityId,
                updates: {
                    status: 'done',
                    description: `Confirmation email sent to ${winner.vendorEmail} with ${winner.wasNegotiated ? 'negotiated' : 'quoted'} price of $${winner.finalPrice}/unit. Awaiting invoice.`,
                },
            },
        });

        emitRunEvent(runId, {
            type: 'email_sent',
            payload: {
                vendorName: winner.vendorName,
                vendorEmail: winner.vendorEmail,
                messageId: emailResult.messageId,
                threadId: emailResult.threadId,
                unitPrice: winner.finalPrice,
                wasNegotiated: winner.wasNegotiated,
                originalPrice: winner.originalPrice,
            },
        });

        console.log(`[FINALIZE] Email sent to ${winner.vendorName} at ${winner.vendorEmail}`);
    } catch (emailErr) {
        console.error(`[FINALIZE] Email failed:`, emailErr);
        emitRunEvent(runId, {
            type: 'update_activity',
            payload: {
                id: emailActivityId,
                updates: {
                    status: 'error',
                    description: `Failed to send email: ${(emailErr as Error).message}`,
                },
            },
        });
    }

    const finalStatus = winner.vendorEmail ? 'awaiting_invoice' : 'complete';
    await prisma.run.update({ where: { id: runId }, data: { status: finalStatus } });

    // Emit final stage + services so frontend shows completion
    resetServices(runId);
    emitRunEvent(runId, { type: 'stage_change', payload: { stage: 'complete' } });

    console.log(`[FINALIZE] Run ${runId} → ${finalStatus}`);
}
