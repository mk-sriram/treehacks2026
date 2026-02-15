/**
 * Wallet Server — Mock B2B vendor invoice system.
 *
 * Email-driven workflow:
 *   1. Buyer sends email with "Amount: <number>" to an AgentMail inbox.
 *   2. AgentMail webhook (POST /webhook/agentmail) triggers invoice creation.
 *   3. Server replies via AgentMail with invoice + mock wallet address.
 *   4. Client calls POST /initiate-payment to simulate settlement.
 *
 * No blockchain. No real wallet. Deterministic mock responses.
 */

require('dotenv').config();

const express = require('express');
const webhookRoutes = require('./routes/webhookRoutes');
const paymentRoutes = require('./routes/paymentRoutes');

const app = express();
const PORT = Number(process.env.PORT) || 4020;

// --- Middleware ---
app.use(express.json());

// CORS for local dev
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (_req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// --- Routes ---
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.use(webhookRoutes);
app.use(paymentRoutes);

// --- 404 fallback ---
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`[wallet-server] Listening on http://localhost:${PORT}`);
  console.log('[wallet-server] Routes:');
  console.log('  GET  /health             — health check');
  console.log('  POST /webhook/agentmail  — AgentMail inbound email webhook');
  console.log('  POST /initiate-payment   — simulate payment for an invoice');
  console.log('  GET  /invoices           — list all invoices (debug)');
});
