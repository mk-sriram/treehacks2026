# x402 Wallet Server — Implementation Plan

## Purpose

Standalone dummy wallet/payment receiver for local development. Implements x402-style HTTP payment flow: validate structure, log payments, simulate confirmation, return deterministic responses. No blockchain or real settlement.

## Architecture

- **Process**: Single Node.js HTTP server; no shared code with the main Next.js app.
- **Port**: Configurable via `PORT` (default `4020`).
- **State**: In-memory only — received payments appended to a log array; no database.
- **Stack**: Node.js with built-in `http` module; optional `dotenv` for env config.

## Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check; returns `200` and `{ "ok": true }`. |
| `POST` | `/payment` | x402-style payment endpoint (see below). |

### POST /payment — x402 Flow

1. **Request without `PAYMENT-SIGNATURE`**  
   - Response: **402 Payment Required** with JSON body describing payment requirements (e.g. `x402Version`, `accepts` with scheme, network, maxAmountRequired, payTo). Simulates “this resource requires payment.”

2. **Request with `PAYMENT-SIGNATURE`**  
   - Header value: Base64-encoded JSON (x402 payment payload).  
   - Server decodes payload, validates minimal structure (e.g. `x402Version`, `scheme`, `network`, `payload` with authorization/signature).  
   - If invalid: **400** with error message.  
   - If valid: log payment to in-memory store, return **200** with optional `PAYMENT-RESPONSE` header (Base64-encoded settlement response) and JSON body `{ "ok": true, "paymentId": "..." }`.

## Validation Logic

- Decode `PAYMENT-SIGNATURE` from Base64; must be valid JSON.
- Required top-level fields: `x402Version` (number), `scheme` (string), `network` (string).
- Required nested structure: `payload` object; if present, `payload.authorization` and `payload.signature` (or equivalent) accepted as optional for dummy validation.
- Reject on decode failure, missing required fields, or non-object payload; return 400 with a short error message.

## Data Flow

```
Client                          Wallet Server
   |                                  |
   |  POST /payment (no header)       |
   | --------------------------------->
   |  402 + Payment Required JSON     |
   | <---------------------------------
   |                                  |
   |  POST /payment                   |
   |  PAYMENT-SIGNATURE: <base64>     |
   | --------------------------------->
   |  validate → log → 200 +          |
   |  PAYMENT-RESPONSE (optional)     |
   | <---------------------------------
```

## Deterministic Behaviour

- Same valid payload always results in 200 (no randomness in success/failure).
- Payment IDs can be timestamp-based or sequential for traceability in logs.
- No external calls; no real verification or settlement.

## Environment

- `PORT` — HTTP listen port (default `4020`).
- No API keys or secrets required for the dummy server.
