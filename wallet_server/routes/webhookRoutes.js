/**
 * Webhook route: POST /webhook/agentmail
 *
 * Receives AgentMail "message.received" events, parses the invoice amount
 * from the email body, creates an invoice, and replies with invoice details.
 */

const { Router } = require('express');
const { createInvoice } = require('../invoices/invoiceStore');
const { replyToMessage } = require('../email/agentmailClient');

const router = Router();

/**
 * Parse "Amount: <number>" from email body text.
 * Accepts optional commas and decimals, e.g. "Amount: 250,000" or "Amount: 1500.50".
 * @param {string} text
 * @returns {number|null}
 */
function parseAmount(text) {
  if (!text) return null;
  const match = text.match(/Amount:\s*([\d,]+(?:\.\d+)?)/i);
  if (!match) return null;
  const cleaned = match[1].replace(/,/g, '');
  const num = parseFloat(cleaned);
  return Number.isFinite(num) && num > 0 ? num : null;
}

/**
 * Format a number as USD string (e.g. 250000 → "$250,000").
 */
function formatUSD(n) {
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

router.post('/webhook/agentmail', async (req, res) => {
  try {
    const event = req.body;

    // Only handle message.received
    if (!event || event.event_type !== 'message.received') {
      console.log('[webhook] Ignored event:', event?.event_type ?? 'unknown');
      return res.status(200).json({ ignored: true });
    }

    const message = event.message;
    if (!message) {
      console.warn('[webhook] message.received event missing message field');
      return res.status(400).json({ error: 'Missing message in payload' });
    }

    // Extract sender email
    const senderEmail =
      message.from?.[0]?.email ?? message.from?.[0] ?? null;
    if (!senderEmail) {
      console.warn('[webhook] Could not extract sender email');
      return res.status(400).json({ error: 'Could not determine sender email' });
    }

    // Parse amount from body
    const amount = parseAmount(message.text);
    if (amount === null) {
      console.warn(`[webhook] Could not parse amount from email body. Sender: ${senderEmail}`);
      return res.status(400).json({ error: 'Could not parse Amount from email body. Expected format: "Amount: 250000"' });
    }

    // Create invoice
    const invoice = createInvoice(senderEmail, amount);

    // Build reply
    const walletAddress = process.env.MOCK_WALLET_ADDRESS || '0xMockTaiwanVendorWallet123';
    const replyText = `Invoice: ${formatUSD(amount)}\nWallet Address: ${walletAddress}\nInvoice ID: ${invoice.invoice_id}`;
    const replyHtml = `<p><strong>Invoice:</strong> ${formatUSD(amount)}</p><p><strong>Wallet Address:</strong> ${walletAddress}</p><p><strong>Invoice ID:</strong> ${invoice.invoice_id}</p>`;

    // Reply via AgentMail (best-effort — don't fail the webhook if reply errors)
    const inboxId = message.inbox_id || process.env.AGENTMAIL_INBOX_ID;
    let replySent = false;

    if (inboxId && message.message_id) {
      try {
        await replyToMessage({
          inboxId,
          messageId: message.message_id,
          text: replyText,
          html: replyHtml,
        });
        replySent = true;
      } catch (replyErr) {
        console.warn(`[webhook] AgentMail reply failed (non-fatal): ${replyErr.message}`);
      }
    } else {
      console.warn('[webhook] No inbox_id or message_id — skipping reply');
    }

    console.log(`[webhook] Invoice ${invoice.invoice_id} created. Reply sent: ${replySent}. Buyer: ${senderEmail}`);
    return res.status(200).json({ ok: true, invoice_id: invoice.invoice_id, reply_sent: replySent });
  } catch (err) {
    console.error('[webhook] Error processing webhook:', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
