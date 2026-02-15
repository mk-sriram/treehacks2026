/**
 * POST /api/tools/send-payment
 *
 * ElevenLabs Server Tool — zero params needed.
 * The agent just triggers this webhook. All data (winner, price, vendor name)
 * is already in the DB from resolveWinner().
 */

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { resolveWinner } from '@/lib/finalize';
import { emitRunEvent, activateService, deactivateService } from '@/lib/events';

const MOCK_WALLET = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

function mockTxHash(): string {
    const c = '0123456789abcdef';
    let h = '0x';
    for (let i = 0; i < 64; i++) h += c[Math.floor(Math.random() * c.length)];
    return h;
}

function mockInvoiceId(): string {
    return `INV-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

export async function POST(req: Request) {
    console.log(`[SEND-PAYMENT] Tool call received`);

    try {
        // ElevenLabs requires at least one body param — we just ignore it
        await req.json().catch(() => ({}));

        // Find the active run — it's in round 3 or sending_confirmation
        const activeRun = await prisma.run.findFirst({
            where: { status: { in: ['calling_round_3', 'sending_confirmation', 'summarizing'] } },
            orderBy: { updatedAt: 'desc' },
        });

        if (!activeRun) {
            return NextResponse.json({ error: 'No active run found' }, { status: 404 });
        }

        const runId = activeRun.id;
        const spec = activeRun.parsedSpec as { item: string; quantity: string };

        // Get the winner — already resolved from offers in DB
        const { winner } = await resolveWinner(runId);

        if (!winner || winner.finalPrice == null) {
            return NextResponse.json({ error: 'No winning offer found' }, { status: 404 });
        }

        const vendorName = winner.vendorName;
        const amount = winner.finalPrice;
        const qtyNum = parseFloat(spec.quantity) || 1;
        const totalAmount = amount * qtyNum;
        const invoiceId = mockInvoiceId();
        const txHash = mockTxHash();
        const walletShort = `${MOCK_WALLET.slice(0, 6)}...${MOCK_WALLET.slice(-4)}`;
        const txShort = `${txHash.slice(0, 10)}...${txHash.slice(-4)}`;

        // STEP 1: Email activity
        const emailId = `email-${Date.now()}`;
        emitRunEvent(runId, {
            type: 'activity',
            payload: {
                id: emailId,
                type: 'email',
                title: `Sending invoice to ${vendorName}`,
                description: `Invoice ${invoiceId} for $${totalAmount.toLocaleString()} (${spec.quantity} x $${amount}/unit)...`,
                timestamp: new Date(),
                status: 'running',
                tool: 'agentmail',
            },
        });

        await new Promise(r => setTimeout(r, 800));

        emitRunEvent(runId, {
            type: 'update_activity',
            payload: { id: emailId, updates: { status: 'done', description: `Invoice ${invoiceId} sent to ${vendorName}.` } },
        });

        // STEP 2: Payment activity — lights up "Visa B2B + Coinbase"
        const payId = `pay-${Date.now()}`;
        activateService(runId, 'payment');

        emitRunEvent(runId, {
            type: 'activity',
            payload: {
                id: payId,
                type: 'payment',
                title: `Processing USDC payment`,
                description: `Sending $${totalAmount.toLocaleString()} USDC to ${walletShort} on Base...`,
                timestamp: new Date(),
                status: 'running',
                tool: 'visa-b2b',
            },
        });

        emitRunEvent(runId, {
            type: 'stage_change',
            payload: { stage: 'paying_deposit' },
        });

        await new Promise(r => setTimeout(r, 1500));

        emitRunEvent(runId, {
            type: 'update_activity',
            payload: { id: payId, updates: { status: 'done', description: `$${totalAmount.toLocaleString()} USDC sent to ${walletShort} on Base. TX: ${txShort}.` } },
        });

        deactivateService(runId, 'payment');

        // STEP 3: Payment confirmation activity — mirrors the agentmail confirmation style
        const confirmId = `pay-confirm-${Date.now()}`;
        emitRunEvent(runId, {
            type: 'activity',
            payload: {
                id: confirmId,
                type: 'payment',
                title: `Payment confirmed to ${vendorName}`,
                description: `$${totalAmount.toLocaleString()} USDC sent on Base. TX: ${txShort}. Invoice ${invoiceId}.`,
                timestamp: new Date(),
                status: 'done',
                tool: 'visa-b2b',
            },
        });

        // Payment overlay
        emitRunEvent(runId, {
            type: 'payment_confirmed',
            payload: {
                amount: totalAmount,
                token: 'USDC',
                chain: 'Base',
                wallet_address: MOCK_WALLET,
                tx_hash: txHash,
                invoice_id: invoiceId,
                vendor_name: vendorName,
            },
        });

        return NextResponse.json({
            status: 'confirmed',
            invoice_id: invoiceId,
            amount_usdc: String(totalAmount),
            vendor_name: vendorName,
            wallet_address: walletShort,
            tx_hash: txShort,
            message: `Payment of $${totalAmount} USDC sent to ${vendorName} at ${walletShort} on Base. Invoice ${invoiceId}. TX: ${txShort}.`,
        });
    } catch (err: any) {
        console.error(`[SEND-PAYMENT] Error:`, err);
        return NextResponse.json({ error: err?.message ?? 'server error' }, { status: 500 });
    }
}
