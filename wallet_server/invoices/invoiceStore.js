/**
 * In-memory invoice store.
 * Each invoice: { invoice_id, buyer_email, amount, status, created_at }
 */

const invoices = new Map();
let counter = 0;

function nextInvoiceId() {
  counter += 1;
  return `INV-${String(counter).padStart(4, '0')}`;
}

/**
 * Create a new invoice and store it.
 * @param {string} buyerEmail
 * @param {number} amount
 * @returns {object} The created invoice record.
 */
function createInvoice(buyerEmail, amount) {
  const invoice = {
    invoice_id: nextInvoiceId(),
    buyer_email: buyerEmail,
    amount,
    status: 'pending',
    created_at: new Date().toISOString(),
  };
  invoices.set(invoice.invoice_id, invoice);
  console.log(`[invoiceStore] Created ${invoice.invoice_id} — $${amount} from ${buyerEmail}`);
  return invoice;
}

/**
 * Look up an invoice by ID.
 * @param {string} invoiceId
 * @returns {object|undefined}
 */
function getInvoice(invoiceId) {
  return invoices.get(invoiceId);
}

/**
 * Mark an invoice as paid.
 * @param {string} invoiceId
 * @returns {object|null} Updated invoice, or null if not found.
 */
function markPaid(invoiceId) {
  const inv = invoices.get(invoiceId);
  if (!inv) return null;
  inv.status = 'paid';
  console.log(`[invoiceStore] ${invoiceId} marked as paid`);
  return inv;
}

/**
 * Return all invoices as an array (for debugging / listing).
 */
function listInvoices() {
  return Array.from(invoices.values());
}

module.exports = { createInvoice, getInvoice, markPaid, listInvoices };
