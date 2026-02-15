# Wallet Server — Mock B2B Vendor Invoice System

Email-driven invoice workflow for local development. Uses [AgentMail](https://www.agentmail.to/) for email handling. No blockchain, no real wallet — purely simulated settlement.

## How It Works

```
Buyer sends email             AgentMail                 wallet_server
  "Amount: 250000"   ───►  webhook fires  ───►  POST /webhook/agentmail
  to vendor inbox                                   │
                                                    ├─ parse amount
                                                    ├─ create invoice (INV-0001, pending)
                                                    ├─ reply via AgentMail API:
                                                    │    "Invoice: $250,000"
                                                    │    "Wallet Address: 0xMock..."
                                                    │    "Invoice ID: INV-0001"
                                                    ▼
                                                  invoice stored in memory

Agent / client       ───────────────────────►  POST /initiate-payment
  { "invoice_id": "INV-0001" }                     │
                                                    ├─ find invoice
                                                    ├─ mark status = "paid"
                                                    ▼
                                                  { status: "confirmed", ... }
```

## Requirements

- Node.js 18+
- An [AgentMail](https://console.agentmail.to/) account and API key
- A public URL for the webhook (use [ngrok](https://ngrok.com/) for local dev)

## Quick Start

```bash
cd wallet_server
npm install
```

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

Start the server:

```bash
npm start
```

Server listens on **http://localhost:4020** by default.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `4020` | HTTP listen port |
| `AGENTMAIL_API_KEY` | **Yes** | — | AgentMail API bearer token |
| `AGENTMAIL_INBOX_ID` | **Yes** | — | Inbox ID or address (e.g. `vendor@agentmail.to`) |
| `MOCK_WALLET_ADDRESS` | No | `0xMockTaiwanVendorWallet123` | Wallet address in invoice replies |

## Setting Up the AgentMail Webhook

1. Expose your local server publicly (e.g. with ngrok):

```bash
ngrok http 4020
```

2. Register the webhook with AgentMail (via their API or dashboard):

```bash
curl -X POST https://api.agentmail.to/v0/webhooks \
  -H "Authorization: Bearer $AGENTMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://YOUR_NGROK_URL/webhook/agentmail",
    "event_types": ["message.received"]
  }'
```

3. AgentMail will now POST to `/webhook/agentmail` whenever an email arrives at your inbox.

## API Reference

### `GET /health`

Health check.

**Response:** `200` — `{ "ok": true }`

### `POST /webhook/agentmail`

AgentMail webhook endpoint. Receives `message.received` events.

**Expected email body format:**

```
Amount: 250000
```

**Behaviour:**
- Parses `Amount: <number>` from the email body.
- Creates an invoice (`INV-XXXX`, status `pending`).
- Replies to the sender via AgentMail with invoice details and mock wallet address.
- Returns `200` with `{ "ok": true, "invoice_id": "INV-0001" }`.

**Errors:**
- `400` if amount cannot be parsed or sender is missing.
- `500` if AgentMail reply fails.

### `POST /initiate-payment`

Simulate payment for an invoice.

**Request body:**

```json
{ "invoice_id": "INV-0001" }
```

**Responses:**

- `200` (confirmed):

```json
{
  "status": "confirmed",
  "invoice_id": "INV-0001",
  "amount": "250000",
  "wallet": "0xMockTaiwanVendorWallet123"
}
```

- `200` (already paid):

```json
{
  "status": "already_paid",
  "invoice_id": "INV-0001",
  "amount": "250000",
  "wallet": "0xMockTaiwanVendorWallet123",
  "message": "This invoice has already been paid."
}
```

- `404` — invoice not found.

### `GET /invoices`

List all invoices (debug/inspection).

**Response:** `200` — array of invoice objects.

## Testing Manually

### 1. Simulate a webhook (no real email needed)

```bash
curl -X POST http://localhost:4020/webhook/agentmail \
  -H "Content-Type: application/json" \
  -d '{
    "type": "event",
    "event_type": "message.received",
    "event_id": "evt_test123",
    "message": {
      "inbox_id": "YOUR_INBOX_ID",
      "message_id": "msg_test123",
      "from": [{ "email": "buyer@example.com" }],
      "to": [{ "email": "vendor@agentmail.to" }],
      "subject": "Purchase Order",
      "text": "Hi, please invoice us.\n\nAmount: 250000\n\nThanks",
      "created_at": "2026-02-14T12:00:00Z"
    }
  }'
```

### 2. Check invoices

```bash
curl http://localhost:4020/invoices
```

### 3. Simulate payment

```bash
curl -X POST http://localhost:4020/initiate-payment \
  -H "Content-Type: application/json" \
  -d '{ "invoice_id": "INV-0001" }'
```

## Project Structure

```
wallet_server/
  ├── server.js                 # Express app, mounts routes
  ├── package.json
  ├── .env.example
  ├── routes/
  │     ├── webhookRoutes.js    # POST /webhook/agentmail
  │     └── paymentRoutes.js    # POST /initiate-payment, GET /invoices
  ├── email/
  │     └── agentmailClient.js  # AgentMail API wrapper (reply to message)
  └── invoices/
        └── invoiceStore.js     # In-memory invoice store + ID generator
```
