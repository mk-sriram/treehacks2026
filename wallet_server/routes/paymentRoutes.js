/**
 * Payment simulation routes.
 *
 * POST /initiate-payment  — mark an invoice as paid (mock settlement).
 * GET  /invoices           — list all invoices (debug helper).
 */

const { Router } = require('express');
const { getInvoice, markPaid, listInvoices } = require('../invoices/invoiceStore');

const router = Router();

router.post('/initiate-payment', (req, res) => {
  const { invoice_id } = req.body || {};

  if (!invoice_id || typeof invoice_id !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid invoice_id' });
  }

  const invoice = getInvoice(invoice_id);
  if (!invoice) {
    return res.status(404).json({ error: `Invoice ${invoice_id} not found` });
  }

  if (invoice.status === 'paid') {
    return res.status(200).json({
      status: 'already_paid',
      invoice_id: invoice.invoice_id,
      amount: String(invoice.amount),
      wallet: process.env.MOCK_WALLET_ADDRESS || '0xMockTaiwanVendorWallet123',
      message: 'This invoice has already been paid.',
    });
  }

  markPaid(invoice_id);

  const walletAddress = process.env.MOCK_WALLET_ADDRESS || '0xMockTaiwanVendorWallet123';
  console.log(`[payment] Invoice ${invoice_id} confirmed — $${invoice.amount} → ${walletAddress}`);

  return res.status(200).json({
    status: 'confirmed',
    invoice_id: invoice.invoice_id,
    amount: String(invoice.amount),
    wallet: walletAddress,
  });
});

router.get('/invoices', (_req, res) => {
  return res.status(200).json(listInvoices());
});

module.exports = router;
