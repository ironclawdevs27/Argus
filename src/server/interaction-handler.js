/**
 * ARGUS Interaction Handler
 *
 * Handles Slack Block Kit button interactions:
 *   - "Acknowledge" button → updates the original message with an acknowledged badge
 *   - "Retest" button → triggers a new test run and posts results as thread reply
 *
 * Configure in Slack App:
 *   Interactivity & Shortcuts → Request URL: https://your-server.com/slack/interactions
 */

import { verifySlackSignature } from './slash-command-handler.js';
import { acknowledgeMessage, postRetestResult } from '../orchestration/slack-notifier.js';
import { createMcpClient } from '../utils/mcp-client.js';
import { runCrawl } from '../orchestration/crawl-and-report.js';

/**
 * Handle POST /slack/interactions
 * @param {object} req - Express request
 * @param {object} res - Express response
 */
export async function handleInteraction(req, res) {
  if (!verifySlackSignature(req)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let payload;
  try {
    // Slack sends interactions as URL-encoded JSON in the `payload` field
    payload = JSON.parse(req.body.payload);
  } catch {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const { type, actions, message, channel, user } = payload;

  if (type !== 'block_actions' || !actions?.length) {
    return res.status(200).send(); // Unrecognised interaction — ack and ignore
  }

  const action = actions[0];
  const actionId = action.action_id;
  const messageTs = message?.ts;
  const channelId = channel?.id;
  const userName = user?.name ?? user?.username ?? 'unknown';

  // Acknowledge the interaction immediately (Slack requires < 3s)
  res.status(200).send();

  // GAP-85: channelId is required for all follow-up Slack posts. Missing means the payload
  // is from an unsupported interaction type — ack it (above) but skip async processing.
  if (!channelId) {
    console.warn('[ARGUS] Interaction missing channel.id — cannot dispatch response');
    return;
  }

  // GAP-39: Wrap post-response async work in try/catch. The response is already committed
  // at this point, so any throws escape Express's error handler and become unhandled
  // promise rejections — which crash the server in Node 15+.
  try {
    if (actionId === 'acknowledge') {
      await acknowledgeMessage(messageTs, channelId, userName);
    } else if (actionId === 'retest') {
      await handleRetestAction({ action, messageTs, channelId, userName });
    }
    // 'view_page' is a URL button — Slack handles it client-side, no server action needed
  } catch (err) {
    console.error('[ARGUS] Interaction post-response error:', err.message);
  }
}

/**
 * Handle the "Retest" button click.
 * Triggers a new test run and posts result as thread reply.
 */
async function handleRetestAction({ action, messageTs, channelId, userName }) {
  let parsedValue;
  try {
    parsedValue = JSON.parse(action.value ?? '{}');
  } catch (e) {
    // GAP-96: Log the raw value and error so we can diagnose malformed action payloads.
    console.warn('[ARGUS] Failed to parse action.value:', action.value, e.message);
    parsedValue = {};
  }

  // GAP-81: Validate targetUrl is a string starting with http — parsedValue.url could be
  // a number or boolean from a crafted payload, which passes the truthy check but breaks
  // downstream string operations and URL construction in runCrawl.
  const targetUrl = parsedValue.url;
  if (typeof targetUrl !== 'string' || !targetUrl.startsWith('http')) return;

  let mcp;
  try {
    mcp = await createMcpClient();

    // GAP-34 + GAP-40: Do NOT mutate process.env.TARGET_DEV_URL — concurrent retests share
    // the same Node.js process env and would corrupt each other's URLs. Pass targetUrl directly.
    const report = await runCrawl(mcp, [{ path: '', name: 'Retest', critical: true, waitFor: null }], targetUrl);

    const passed = report.summary.critical === 0;
    const details =
      `URL: ${targetUrl}\n` +
      `Triggered by: @${userName}\n` +
      `Critical: ${report.summary.critical} | Warnings: ${report.summary.warning} | Info: ${report.summary.info}`;

    await postRetestResult(messageTs, channelId, passed ? 'pass' : 'fail', details);
  } catch (err) {
    // GAP-37: Log full error server-side; redact from the thread reply.
    console.error('[ARGUS] Retest interaction failed:', err);
    await postRetestResult(messageTs, channelId, 'fail', 'Error: check server logs for details');
  } finally {
    mcp?.close?.();
  }
}
