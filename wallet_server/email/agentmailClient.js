/**
 * Thin wrapper around the AgentMail REST API.
 * Only implements the subset we need: reply to a message.
 */

const AGENTMAIL_BASE = 'https://api.agentmail.to/v0';

/**
 * Reply to an inbound message via AgentMail.
 *
 * @param {object} opts
 * @param {string} opts.inboxId   — AgentMail inbox ID (or address).
 * @param {string} opts.messageId — The message_id to reply to (from webhook payload).
 * @param {string} opts.text      — Plain-text reply body.
 * @param {string} [opts.html]    — Optional HTML reply body.
 * @returns {Promise<object>}     — AgentMail response ({ message_id, thread_id }).
 */
async function replyToMessage({ inboxId, messageId, text, html }) {
  const apiKey = process.env.AGENTMAIL_API_KEY;
  if (!apiKey) throw new Error('AGENTMAIL_API_KEY is not set');

  const url = `${AGENTMAIL_BASE}/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}/reply`;

  const body = { text };
  if (html) body.html = html;

  console.log(`[agentmail] Replying to message ${messageId} in inbox ${inboxId}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error(`[agentmail] Reply failed (${res.status}):`, errBody);
    throw new Error(`AgentMail reply failed: ${res.status} — ${errBody}`);
  }

  const data = await res.json();
  console.log(`[agentmail] Reply sent — message_id=${data.message_id}, thread_id=${data.thread_id}`);
  return data;
}

module.exports = { replyToMessage };
