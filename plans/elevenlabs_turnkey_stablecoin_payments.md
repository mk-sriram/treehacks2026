# Agentic Payment via ElevenLabs Tool Calling

## How it works

```
Round 3 Confirmation Call
  → Agent confirms deal terms with seller on the phone
  → Agent calls `send_payment` server tool (webhook → our Next.js API)
  → Backend sends invoice email via AgentMail
  → Backend mocks USDC payment to seller's wallet
  → Returns confirmation to agent
  → Agent tells seller: "Payment sent. Invoice ID is X. TX hash is Y."
```

---

## Architecture

```
┌─────────────────────┐     tool call      ┌──────────────────────────────────┐
│  ElevenLabs Agent    │ ─────────────────→ │  POST /api/tools/send-payment    │
│  (Confirmation Call) │                    │  (Next.js API route)             │
│                      │ ←───────────────── │                                  │
│  reads back result   │    JSON response   │  1. Create invoice               │
└─────────────────────┘                    │  2. Send email via AgentMail     │
                                           │  3. Mock USDC payment            │
                                           │  4. Return {invoice_id, tx_hash} │
                                           └──────────────────────────────────┘
```

---

## What was built

### 1. Server Tool Endpoint: `POST /api/tools/send-payment`

File: `src/app/api/tools/send-payment/route.ts`

**Request body** (sent by ElevenLabs agent):
```json
{
  "amount": "1500.00",
  "vendor_name": "Formosa Advanced Materials",
  "wallet_address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  "item": "carbon fiber sheets",
  "quantity": "500",
  "run_id": "...",
  "vendor_id": "..."
}
```

**Response** (agent reads this back to the seller):
```json
{
  "status": "confirmed",
  "invoice_id": "INV-1739612345-A1B2",
  "amount_usdc": "1500.00",
  "chain": "Base",
  "token": "USDC",
  "wallet_address": "0xd8dA...6045",
  "tx_hash": "0x3f8a...c92d",
  "email_sent": true,
  "message": "Payment of $1500 USDC has been sent to wallet 0xd8dA...6045 on Base network. Invoice ID: INV-1739612345-A1B2."
}
```

### 2. Dynamic Variables (passed to confirmation agent)

Updated in `src/lib/finalize.ts` — the confirmation agent now receives:
- `seller_wallet_address` — the mock wallet address for USDC payment
- `total_amount` — unit price × quantity
- `next_step` — instructs the agent to offer payment via USDC

These are available in the agent prompt via `{{seller_wallet_address}}`, `{{total_amount}}`, etc.

---

## ElevenLabs Dashboard Setup

### Step 1: Add the Server Tool to the Confirmation Agent

1. Go to **ElevenLabs Dashboard** → **Agents** → select your **Confirmation Agent** (`agent_7101khg5f9sze81rttxjaww06acw`)
2. Click **Tools** tab → **Add Tool** → select **Server (Webhook)**
3. Configure:

| Field | Value |
|-------|-------|
| **Tool Name** | `send_payment` |
| **Description** | Send a USDC payment to the seller's wallet address and generate an invoice. Call this tool after confirming the deal terms with the seller. |
| **Method** | `POST` |
| **URL** | `https://YOUR_TUNNEL_URL/api/tools/send-payment` |
| **Headers** | (none needed for MVP, or add `Authorization: Bearer YOUR_SECRET`) |

4. Add **Body Parameters** (these are what the agent fills in from context):

| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| `amount` | `string` | Total payment amount in USD, e.g. "1500.00" | Yes |
| `vendor_name` | `string` | Name of the seller/vendor being paid | Yes |
| `wallet_address` | `string` | Seller's wallet address for USDC payment. Use the value from {{seller_wallet_address}} | Yes |
| `item` | `string` | The item being purchased | No |
| `quantity` | `string` | Number of units | No |
| `run_id` | `string` | The procurement run ID from {{run_id}} | No |
| `vendor_id` | `string` | The vendor ID from {{vendor_id}} | No |

5. Click **Save**

### Step 2: Update the Confirmation Agent's System Prompt

Add this to the system prompt (or update the existing instructions):

```
PAYMENT INSTRUCTIONS:
- After confirming the deal terms with the seller, tell them you will now process the payment.
- Call the `send_payment` tool with:
  - amount: the total agreed amount ({{total_amount}})
  - vendor_name: {{vendor_name}}
  - wallet_address: {{seller_wallet_address}}
  - item: {{item}}
  - quantity: {{quantity}}
  - run_id: {{run_id}}
  - vendor_id: {{vendor_id}}
- After the tool returns, read back:
  - The payment status ("confirmed")
  - The invoice ID
  - That payment was sent via USDC on Base network
  - Mention a confirmation email will follow
- If the tool fails, tell the seller you'll process payment manually and follow up via email.
```

### Step 3: Set the URL to your tunnel

When running locally with cloudflared:
```bash
# Your tunnel URL from quick-tunnel.sh, e.g.:
# https://abc-def-123.trycloudflare.com/api/tools/send-payment
```

Set this as the tool URL in the ElevenLabs dashboard.

---

## Testing

### Test the endpoint directly:
```bash
curl -X POST http://localhost:3000/api/tools/send-payment \
  -H "Content-Type: application/json" \
  -d '{
    "amount": "1500.00",
    "vendor_name": "Test Vendor",
    "wallet_address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "item": "carbon fiber sheets",
    "quantity": "500"
  }'
```

Expected response:
```json
{
  "status": "confirmed",
  "invoice_id": "INV-...",
  "amount_usdc": "1500.00",
  "chain": "Base",
  "token": "USDC",
  "wallet_address": "0xd8dA...6045",
  "tx_hash": "0x...",
  "email_sent": false,
  "message": "Payment of $1500 USDC has been sent to wallet 0xd8dA...6045 on Base network..."
}
```

### Test via a live call:
1. Start your Next.js dev server + cloudflared tunnel
2. Trigger a full procurement run (or use the test-finalize endpoint)
3. When the confirmation call happens, the agent should:
   - Confirm the deal
   - Call `send_payment`
   - Read back the payment confirmation

---

## Files changed

| File | Change |
|------|--------|
| `src/app/api/tools/send-payment/route.ts` | **NEW** — Server tool endpoint for ElevenLabs |
| `src/lib/finalize.ts` | Added `seller_wallet_address`, `total_amount` dynamic variables |
| `plans/elevenlabs_turnkey_stablecoin_payments.md` | Rewritten with actual implementation |

---

## Production upgrades (later)

- Replace mock tx hash with real Turnkey/USDC transfer
- Add bearer token auth to the tool endpoint
- Add HMAC signature verification for ElevenLabs webhooks
- Store invoices in Postgres instead of in-memory
- Use real wallet addresses from vendor onboarding
