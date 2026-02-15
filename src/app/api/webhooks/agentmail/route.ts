// Webhook handler for AgentMail incoming emails
// Receives notification when a vendor replies to our confirmation email
// (e.g. sending back an invoice or confirming the order).
//
// AgentMail sends a POST with the event type and message details.
// We process the reply, update the run status, and emit SSE events
// so the frontend can show the invoice was received.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { emitRunEvent } from '@/lib/events';
import { agentMailClient } from '@/lib/agentmail';

let webhookCounter = 0;
function makeActivityId() {
    webhookCounter++;
    return `am-${Date.now()}-${webhookCounter}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * POST /api/webhooks/agentmail
 *
 * AgentMail webhook sends:
 *   - message.received: a new email arrived in our inbox
 *
 * Payload shape (from AgentMail docs):
 * {
 *   "type": "message.received",
 *   "timestamp": "...",
 *   "data": {
 *     "inbox_id": "...",
 *     "message_id": "...",
 *     "thread_id": "...",
 *     "from": "vendor@example.com",
 *     "to": ["procurement-agent@agentmail.to"],
 *     "subject": "Re: Purchase Order Confirmation ...",
 *     "text": "...",
 *     "html": "...",
 *     "attachments": [...]
 *   }
 * }
 */
export async function POST(req: Request) {
    console.log(`[AGENTMAIL-WEBHOOK] Incoming webhook received`);

    try {
        const body = await req.json();
        const eventType = body.type;

        console.log(`[AGENTMAIL-WEBHOOK] Event type: ${eventType}`);

        if (eventType === 'message.received') {
            // Process asynchronously — return 200 immediately
            void processIncomingEmail(body.data).catch(err =>
                console.error('[AGENTMAIL-WEBHOOK] Background processing error:', err)
            );
            return NextResponse.json({ received: true, handled: true });
        }

        console.log(`[AGENTMAIL-WEBHOOK] Unhandled event type: ${eventType}`);
        return NextResponse.json({ received: true, handled: false });
    } catch (err: any) {
        console.error('[AGENTMAIL-WEBHOOK] Error:', err);
        return NextResponse.json({ received: true, error: err.message }, { status: 200 });
    }
}

// ─── Process incoming email (runs in background) ─────────────────────

async function processIncomingEmail(data: any) {
    const inboxId = data?.inbox_id;
    const messageId = data?.message_id;
    const threadId = data?.thread_id;
    const fromAddress = data?.from;
    const subject = data?.subject ?? '';
    const textBody = data?.text ?? '';
    const attachments = data?.attachments ?? [];

    console.log(`[AGENTMAIL-WEBHOOK] Processing email — from=${fromAddress}, subject="${subject}", attachments=${attachments.length}`);

    if (!fromAddress) {
        console.warn('[AGENTMAIL-WEBHOOK] No from address — cannot correlate to vendor');
        return;
    }

    // Try to find the vendor by matching the sender's email
    const vendor = await prisma.vendor.findFirst({
        where: {
            email: fromAddress,
        },
        include: {
            run: true,
        },
    });

    if (!vendor) {
        console.log(`[AGENTMAIL-WEBHOOK] No vendor found for email ${fromAddress} — might be unrelated`);
        return;
    }

    const runId = vendor.runId;
    console.log(`[AGENTMAIL-WEBHOOK] Matched vendor: ${vendor.name} (runId=${runId})`);

    // Fetch the full message content if needed
    let fullMessage: any = null;
    if (inboxId && messageId) {
        try {
            fullMessage = await agentMailClient.inboxes.messages.get(inboxId, messageId);
            console.log(`[AGENTMAIL-WEBHOOK] Full message fetched — text length: ${fullMessage?.text?.length ?? 0}`);
        } catch (err) {
            console.warn('[AGENTMAIL-WEBHOOK] Failed to fetch full message (non-fatal):', err);
        }
    }

    // Determine if this looks like an invoice
    const isInvoice = detectInvoice(subject, textBody, attachments);
    const hasAttachments = attachments.length > 0;

    // Emit activity event for the frontend
    const activityId = makeActivityId();
    emitRunEvent(runId, {
        type: 'activity',
        payload: {
            id: activityId,
            type: 'email',
            title: isInvoice
                ? `Invoice received from ${vendor.name}`
                : `Email reply from ${vendor.name}`,
            description: isInvoice
                ? `Invoice received${hasAttachments ? ` with ${attachments.length} attachment(s)` : ''}. Subject: "${subject}"`
                : `Vendor replied: "${subject}". ${hasAttachments ? `${attachments.length} attachment(s) included.` : 'No attachments.'}`,
            timestamp: new Date(),
            status: 'done',
            tool: 'agentmail',
        },
    });

    // If it looks like an invoice, update run status
    if (isInvoice) {
        console.log(`[AGENTMAIL-WEBHOOK] Invoice detected from ${vendor.name}!`);

        await prisma.run.update({
            where: { id: runId },
            data: { status: 'invoice_received' },
        });

        emitRunEvent(runId, {
            type: 'invoice_received',
            payload: {
                vendorName: vendor.name,
                vendorId: vendor.id,
                subject,
                hasAttachments,
                attachmentCount: attachments.length,
                messageId,
                threadId,
                receivedAt: new Date(),
            },
        });

        emitRunEvent(runId, { type: 'stage_change', payload: { stage: 'invoice_received' } });

        console.log(`[AGENTMAIL-WEBHOOK] Run ${runId} updated to invoice_received`);
    }
}

// ─── Invoice detection heuristics ────────────────────────────────────

function detectInvoice(subject: string, text: string, attachments: any[]): boolean {
    const combined = `${subject} ${text}`.toLowerCase();

    // Check for invoice-related keywords
    const invoiceKeywords = [
        'invoice',
        'inv-',
        'inv #',
        'bill',
        'payment due',
        'amount due',
        'total due',
        'purchase order',
        'po #',
        'po-',
        'remittance',
        'proforma',
        'pro forma',
        'commercial invoice',
    ];

    const hasInvoiceKeyword = invoiceKeywords.some(kw => combined.includes(kw));

    // Check for PDF/document attachments (common invoice formats)
    const invoiceExtensions = ['.pdf', '.xlsx', '.xls', '.docx', '.doc'];
    const hasInvoiceAttachment = attachments.some((a: any) => {
        const filename = (a.filename ?? a.name ?? '').toLowerCase();
        return invoiceExtensions.some(ext => filename.endsWith(ext));
    });

    return hasInvoiceKeyword || hasInvoiceAttachment;
}
