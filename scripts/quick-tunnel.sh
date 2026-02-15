#!/usr/bin/env bash
#
# quick-tunnel.sh — start cloudflared tunnel + auto-configure ElevenLabs webhook
# Usage: ./scripts/quick-tunnel.sh
#
# Requires: .env.local with ELEVENLABS_API_KEY
# No account needed — uses cloudflare's free quick tunnel

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Load .env.local
if [ -f "$PROJECT_DIR/.env.local" ]; then
  set -a
  source "$PROJECT_DIR/.env.local"
  set +a
fi

if [ -z "${ELEVENLABS_API_KEY:-}" ]; then
  echo "❌ ELEVENLABS_API_KEY not found in .env.local"
  exit 1
fi

echo "🚇 Starting cloudflared tunnel on localhost:3000..."
echo "   (No account needed — it generates a temporary URL)"
echo ""

# Check if cloudflared is installed, install if not
if ! command -v cloudflared &> /dev/null; then
  echo "📦 Installing cloudflared via Homebrew..."
  brew install cloudflared
fi

# Start cloudflared and capture the URL
# cloudflared prints the URL to stderr
TUNNEL_LOG=$(mktemp)
cloudflared tunnel --url http://localhost:3000 2>"$TUNNEL_LOG" &
TUNNEL_PID=$!

# Wait for the URL to appear in the log
echo "⏳ Waiting for tunnel URL..."
TUNNEL_URL=""
for i in $(seq 1 30); do
  TUNNEL_URL=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1 || true)
  if [ -n "$TUNNEL_URL" ]; then
    break
  fi
  sleep 1
done

if [ -z "$TUNNEL_URL" ]; then
  echo "❌ Failed to get tunnel URL after 30 seconds"
  kill $TUNNEL_PID 2>/dev/null || true
  cat "$TUNNEL_LOG"
  exit 1
fi

WEBHOOK_URL="$TUNNEL_URL/api/webhooks/elevenlabs"
echo ""
echo "✅ Tunnel active: $TUNNEL_URL"
echo "📞 Webhook URL:   $WEBHOOK_URL"
echo ""

# Configure ElevenLabs webhook via API (two-step process)
echo "🔧 Configuring ElevenLabs webhook..."

# Step 1: Delete any existing webhooks (clean slate)
EXISTING=$(curl -s "https://api.elevenlabs.io/v1/workspace/webhooks" \
  -H "xi-api-key: $ELEVENLABS_API_KEY")
OLD_IDS=$(echo "$EXISTING" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    for w in data.get('webhooks', []):
        print(w.get('webhook_id', ''))
except: pass
" 2>/dev/null)

for OLD_ID in $OLD_IDS; do
  if [ -n "$OLD_ID" ]; then
    curl -s -X DELETE "https://api.elevenlabs.io/v1/workspace/webhooks/$OLD_ID" \
      -H "xi-api-key: $ELEVENLABS_API_KEY" > /dev/null 2>&1
    echo "   🗑  Deleted old webhook $OLD_ID"
  fi
done

# Step 2: Create a new webhook with the tunnel URL
CREATE_RESPONSE=$(curl -s -X POST "https://api.elevenlabs.io/v1/workspace/webhooks" \
  -H "xi-api-key: $ELEVENLABS_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"settings\": {
      \"auth_type\": \"hmac\",
      \"hmac_secret\": \"procure-agent-webhook-$(date +%s)\",
      \"name\": \"ProcureAgent Tunnel\",
      \"webhook_url\": \"$WEBHOOK_URL\",
      \"events\": [\"post_call_transcription\"]
    }
  }")

WEBHOOK_ID=$(echo "$CREATE_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('webhook_id',''))" 2>/dev/null)

if [ -z "$WEBHOOK_ID" ]; then
  echo "⚠️  Failed to create webhook — may need manual setup"
  echo "   Response: $CREATE_RESPONSE"
  echo ""
  echo "   Go to: https://elevenlabs.io/app/conversational-ai/settings"
  echo "   and set the Post-Call Transcription webhook URL to:"
  echo "   $WEBHOOK_URL"
else
  # Step 3: Assign webhook ID to workspace settings
  ASSIGN_RESPONSE=$(curl -s -X PATCH "https://api.elevenlabs.io/v1/convai/settings" \
    -H "xi-api-key: $ELEVENLABS_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{
      \"webhooks\": {
        \"post_call_webhook_id\": \"$WEBHOOK_ID\",
        \"events\": [\"transcript\"],
        \"send_audio\": false
      }
    }")
  echo "✅ ElevenLabs webhook configured to: $WEBHOOK_URL"
  echo "   Webhook ID: $WEBHOOK_ID"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Tunnel is running. Press Ctrl+C to stop."
echo "  Tunnel PID: $TUNNEL_PID"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Cleanup on exit
cleanup() {
  echo ""
  echo "🛑 Shutting down tunnel..."
  kill $TUNNEL_PID 2>/dev/null || true
  rm -f "$TUNNEL_LOG"
  echo "Done."
}
trap cleanup EXIT

# Wait for tunnel process
wait $TUNNEL_PID
