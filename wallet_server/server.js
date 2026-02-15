/**
 * x402-compatible dummy wallet server (local dev only).
 * Accepts x402-style payment requests, validates structure, logs payments,
 * simulates confirmation, returns deterministic success/failure.
 * No blockchain or real settlement.
 */

require('dotenv').config();
const http = require('http');

const PORT = Number(process.env.PORT) || 4020;

// In-memory payment log (for local dev inspection)
const paymentLog = [];
let paymentCounter = 0;

function nextPaymentId() {
  paymentCounter += 1;
  return `pay-${Date.now()}-${paymentCounter}`;
}

/**
 * Build a 402 Payment Required response body (x402-style).
 */
function paymentRequiredBody() {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: '84532',
        payTo: '0x0000000000000000000000000000000000000001',
        maxAmountRequired: '1000000',
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        description: 'Dummy wallet server (local dev)',
        extra: {
          facilitatorUrl: null,
          name: 'wallet-server',
        },
      },
    ],
    error: null,
  };
}

/**
 * Validate decoded payment payload (minimal structure for dummy server).
 */
function validatePaymentPayload(obj) {
  if (!obj || typeof obj !== 'object') return { valid: false, error: 'Payload must be an object' };
  if (typeof obj.x402Version !== 'number') return { valid: false, error: 'Missing or invalid x402Version' };
  if (typeof obj.scheme !== 'string') return { valid: false, error: 'Missing or invalid scheme' };
  if (typeof obj.network !== 'string') return { valid: false, error: 'Missing or invalid network' };
  if (obj.payload != null && typeof obj.payload !== 'object') return { valid: false, error: 'payload must be an object if present' };
  return { valid: true };
}

/**
 * Parse PAYMENT-SIGNATURE header (Base64-encoded JSON).
 */
function decodePaymentSignature(headerValue) {
  if (!headerValue || typeof headerValue !== 'string') return null;
  try {
    const raw = Buffer.from(headerValue.trim(), 'base64').toString('utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Build a simulated settlement response (for PAYMENT-RESPONSE header).
 */
function settlementResponse(paymentId) {
  return {
    status: 'settled',
    paymentId,
    txHash: `0xdummy-${paymentId}`,
    timestamp: new Date().toISOString(),
  };
}

function sendJson(res, statusCode, body) {
  res.setHeader('Content-Type', 'application/json');
  res.statusCode = statusCode;
  res.end(JSON.stringify(body));
}

function send402(res, body) {
  res.setHeader('Content-Type', 'application/json');
  res.statusCode = 402;
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  // CORS: allow local dev from any origin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, PAYMENT-SIGNATURE');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const path = url.pathname;

  // GET /health
  if (req.method === 'GET' && path === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // POST /payment — x402 payment endpoint
  if (req.method === 'POST' && path === '/payment') {
    const paymentSignature = req.headers['payment-signature'];

    if (!paymentSignature) {
      send402(res, paymentRequiredBody());
      return;
    }

    const payload = decodePaymentSignature(paymentSignature);
    if (payload === null) {
      sendJson(res, 400, { ok: false, error: 'Invalid PAYMENT-SIGNATURE: must be Base64-encoded JSON' });
      return;
    }

    const { valid, error } = validatePaymentPayload(payload);
    if (!valid) {
      sendJson(res, 400, { ok: false, error: error || 'Invalid payment payload' });
      return;
    }

    const paymentId = nextPaymentId();
    const entry = {
      paymentId,
      receivedAt: new Date().toISOString(),
      x402Version: payload.x402Version,
      scheme: payload.scheme,
      network: payload.network,
      payload: payload.payload,
    };
    paymentLog.push(entry);
    console.log('[wallet-server] Payment received:', paymentId, payload.scheme, payload.network);

    const settlement = settlementResponse(paymentId);
    const paymentResponseB64 = Buffer.from(JSON.stringify(settlement), 'utf8').toString('base64');
    res.setHeader('PAYMENT-RESPONSE', paymentResponseB64);
    sendJson(res, 200, { ok: true, paymentId, txHash: settlement.txHash });
    return;
  }

  // 404
  sendJson(res, 404, { ok: false, error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`[wallet-server] x402 dummy wallet listening on http://localhost:${PORT}`);
  console.log('[wallet-server] GET /health — health check');
  console.log('[wallet-server] POST /payment — x402 payment (no header → 402; with PAYMENT-SIGNATURE → validate & 200)');
});
