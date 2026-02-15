# x402 Wallet Server (Dummy)

Standalone x402-compatible dummy wallet server for **local development only**. It validates payment request structure, logs received payments, and returns deterministic success/failure. No blockchain or real settlement.

This server is **isolated** from the main app: it runs as a separate process and does not modify any existing project files.

## Requirements

- Node.js 18+
- No API keys or secrets

## Quick Start

```bash
cd wallet_server
npm install
npm start
```

Server listens on **http://localhost:4020** by default.

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `4020`  | HTTP listen port |

Optional: create a `.env` file in `wallet_server/`:

```env
PORT=4020
```

## API

### `GET /health`

Health check.

- **Response:** `200` — `{ "ok": true }`

### `POST /payment` (x402-style)

**1. Request without payment (simulate “payment required”)**

- No `PAYMENT-SIGNATURE` header.
- **Response:** `402 Payment Required` with JSON body describing payment requirements (e.g. `x402Version`, `accepts` with scheme, network, payTo, maxAmountRequired).

**2. Request with payment**

- Header: `PAYMENT-SIGNATURE: <Base64-encoded JSON>` (x402 payment payload).
- Payload must be valid JSON with at least: `x402Version` (number), `scheme` (string), `network` (string). Optional: `payload` (object).
- **Valid:** `200` with optional `PAYMENT-RESPONSE` header (Base64-encoded settlement) and body `{ "ok": true, "paymentId": "...", "txHash": "..." }`. Payment is logged in memory.
- **Invalid:** `400` with `{ "ok": false, "error": "..." }`.

## Example (curl)

```bash
# 402 when no payment provided
curl -s -X POST http://localhost:4020/payment

# Successful payment (minimal valid payload)
PAYLOAD='{"x402Version":1,"scheme":"exact","network":"84532","payload":{"authorization":{},"signature":"0x00"}}'
SIG=$(echo -n "$PAYLOAD" | base64)
curl -s -X POST http://localhost:4020/payment -H "PAYMENT-SIGNATURE: $SIG"
```

## Implementation Plan

See [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) for architecture, routes, validation logic, and data flow.
