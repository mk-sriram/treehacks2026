// AgentMail client — sends price confirmation emails to vendors
// and provides inbox management for receiving invoice replies.
//
// Flow:
//   1. After negotiation completes and a vendor is selected (finalizeSummary),
//      we send a confirmation email with the agreed pricing.
//   2. The vendor replies with an invoice (or confirmation).
//   3. Our webhook at /api/webhooks/agentmail processes incoming replies.

import { AgentMailClient } from 'agentmail';
import { prisma } from './db';
import { emitRunEvent } from './events';

// ─── Singleton client ────────────────────────────────────────────────

const globalForAgentMail = globalThis as unknown as { __agentMailClient: AgentMailClient };

function createClient(): AgentMailClient {
    const apiKey = process.env.AGENTMAIL_API_KEY;
    if (!apiKey) {
        console.warn('[AGENTMAIL] AGENTMAIL_API_KEY not set — email features disabled');
    }
    return new AgentMailClient({ apiKey: apiKey ?? '' });
}

export const agentMailClient: AgentMailClient =
    globalForAgentMail.__agentMailClient ?? (globalForAgentMail.__agentMailClient = createClient());

// ─── Inbox management ────────────────────────────────────────────────

/**
 * Get or create the agent's inbox for sending/receiving procurement emails.
 * Uses AGENTMAIL_INBOX_ID env var if set, otherwise creates a new inbox.
 */
export async function getOrCreateInbox(): Promise<string> {
    const existingInboxId = process.env.AGENTMAIL_INBOX_ID;
    if (existingInboxId) {
        console.log(`[AGENTMAIL] Using existing inbox: ${existingInboxId}`);
        return existingInboxId;
    }

    console.log(`[AGENTMAIL] Creating new inbox...`);
    const inbox = await agentMailClient.inboxes.create({
        username: 'procurement-agent',
        displayName: 'Procurement Agent',
    });
    console.log(`[AGENTMAIL] Inbox created: ${inbox.inboxId}`);
    return inbox.inboxId;
}

// ─── Email sending ───────────────────────────────────────────────────

export interface ConfirmationEmailParams {
    runId: string;
    vendorId: string;
    vendorName: string;
    vendorEmail: string;
    item: string;
    quantity: string;
    // Final negotiated (or initial) price
    unitPrice: number;
    // Negotiation context — null if only R1
    originalPrice: number | null;    // R1 price before negotiation
    wasNegotiated: boolean;          // true if R2 call happened
    savingsPercent: number | null;   // % saved from R1 → R2
    // Deal terms from the final offer
    leadTimeDays: number | null;
    shipping: string | null;
    terms: string | null;
    moq: string | null;
}

/**
 * Send a price confirmation email to the winning vendor,
 * requesting them to reply with an invoice.
 */
export async function sendConfirmationEmail(params: ConfirmationEmailParams): Promise<{
    messageId: string;
    threadId: string;
}> {
    const apiKey = process.env.AGENTMAIL_API_KEY;
    if (!apiKey) {
        console.warn('[AGENTMAIL] AGENTMAIL_API_KEY not set — skipping confirmation email');
        throw new Error('AGENTMAIL_API_KEY not configured');
    }

    const inboxId = await getOrCreateInbox();
    const { text, html } = formatConfirmationEmail(params);

    // HARDCODE: Always send to mksriram24@gmail.com for testing
    const actualRecipient = 'mksriram24@gmail.com';
    console.log(`[AGENTMAIL] Sending confirmation email to ${actualRecipient} (vendor: ${params.vendorName}, original email: ${params.vendorEmail})...`);

    const response = await agentMailClient.inboxes.messages.send(inboxId, {
        to: [actualRecipient],
        subject: `Purchase Order Confirmation — ${params.item} (${params.quantity} units)`,
        text,
        html,
    });

    console.log(`[AGENTMAIL] Email sent — messageId=${response.messageId}, threadId=${response.threadId}`);

    // Store the email metadata so we can correlate webhook replies
    // We use the Run's metadata or a separate tracking mechanism
    await prisma.run.update({
        where: { id: params.runId },
        data: {
            status: 'awaiting_invoice',
        },
    });

    return {
        messageId: response.messageId,
        threadId: response.threadId,
    };
}

// ─── Email formatting ────────────────────────────────────────────────

function formatConfirmationEmail(params: ConfirmationEmailParams): { text: string; html: string } {
    const priceStr = `$${params.unitPrice.toFixed(2)}/unit`;
    const leadTimeStr = params.leadTimeDays != null ? `${params.leadTimeDays} days` : 'TBD';
    const shippingStr = params.shipping ?? 'TBD';
    const termsStr = params.terms ?? 'Standard terms';
    const moqStr = params.moq ?? 'N/A';

    // Build negotiation context strings
    let negotiationLine = '';
    let negotiationHtml = '';
    if (params.wasNegotiated && params.originalPrice != null && params.savingsPercent != null) {
        negotiationLine = `\nNote: This reflects our agreed price of ${priceStr}, negotiated down from $${params.originalPrice.toFixed(2)}/unit (${params.savingsPercent}% reduction).`;
        negotiationHtml = `
      <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px; padding: 12px 16px; margin: 16px 0;">
        <p style="margin: 0; color: #166534; font-size: 14px;">
          <strong>Negotiated Price:</strong> ${priceStr} 
          <span style="color: #6b7280; text-decoration: line-through; margin-left: 8px;">$${params.originalPrice.toFixed(2)}/unit</span>
          <span style="background: #dcfce7; color: #166534; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; margin-left: 8px;">${params.savingsPercent}% savings</span>
        </p>
      </div>`;
    }

    const text = `Dear ${params.vendorName},

Thank you for your time during our recent call${params.wasNegotiated ? 's' : ''}. We are pleased to confirm the following order details as discussed:

ORDER SUMMARY
─────────────
Item:            ${params.item}
Quantity:        ${params.quantity} units
Unit Price:      ${priceStr}
MOQ:             ${moqStr}
Lead Time:       ${leadTimeStr}
Shipping:        ${shippingStr}
Payment Terms:   ${termsStr}
${negotiationLine}

We would like to proceed with this order. Please reply to this email with a formal invoice at your earliest convenience so we can arrange payment.

If any of the above details need adjustment, please let us know and we will work through the changes promptly.

Best regards,
Procurement Agent`;

    const html = `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a1a2e; line-height: 1.6; }
    .container { max-width: 600px; margin: 0 auto; padding: 24px; }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 24px; border-radius: 8px 8px 0 0; }
    .header h1 { margin: 0; font-size: 20px; font-weight: 600; }
    .header p { margin: 4px 0 0; opacity: 0.9; font-size: 14px; }
    .body { background: #ffffff; border: 1px solid #e2e8f0; border-top: none; padding: 24px; border-radius: 0 0 8px 8px; }
    .order-table { width: 100%; border-collapse: collapse; margin: 16px 0; }
    .order-table td { padding: 10px 12px; border-bottom: 1px solid #f1f5f9; }
    .order-table td:first-child { font-weight: 600; color: #64748b; width: 140px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; }
    .order-table td:last-child { color: #1e293b; font-size: 15px; }
    .footer { margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2e8f0; color: #94a3b8; font-size: 13px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Purchase Order Confirmation</h1>
      <p>${params.item} — ${params.quantity} units</p>
    </div>
    <div class="body">
      <p>Dear <strong>${params.vendorName}</strong>,</p>
      <p>Thank you for your time during our recent call${params.wasNegotiated ? 's' : ''}. We are pleased to confirm the following order details as discussed:</p>
      ${negotiationHtml}
      <table class="order-table">
        <tr><td>Item</td><td>${params.item}</td></tr>
        <tr><td>Quantity</td><td>${params.quantity} units</td></tr>
        <tr><td>Unit Price</td><td><strong>${priceStr}</strong></td></tr>
        <tr><td>MOQ</td><td>${moqStr}</td></tr>
        <tr><td>Lead Time</td><td>${leadTimeStr}</td></tr>
        <tr><td>Shipping</td><td>${shippingStr}</td></tr>
        <tr><td>Payment Terms</td><td>${termsStr}</td></tr>
      </table>

      <p>We would like to proceed with this order. <strong>Please reply to this email with a formal invoice</strong> at your earliest convenience so we can arrange payment.</p>
      
      <p>If any of the above details need adjustment, please let us know and we will work through the changes promptly.</p>

      <div class="footer">
        <p>Best regards,<br><strong>Procurement Agent</strong></p>
      </div>
    </div>
  </div>
</body>
</html>`;

    return { text, html };
}
