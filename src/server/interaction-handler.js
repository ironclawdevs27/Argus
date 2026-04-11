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

  // Handle each action type asynchronously
  if (actionId === 'acknowledge') {
    await acknowledgeMessage(messageTs, channelId, userName);
  } else if (actionId === 'retest') {
    await handleRetestAction({ action, messageTs, channelId, userName });
  }
  // 'view_page' is a URL button — Slack handles it client-side, no server action needed
}

/**
 * Handle the "Retest" button click.
 * Triggers a new test run and posts result as thread reply.
 */
async function handleRetestAction({ action, messageTs, channelId, userName }) {
  let parsedValue;
  try {
    parsedValue = JSON.parse(action.value ?? '{}');
  } catch {
    parsedValue = {};
  }

  const targetUrl = parsedValue.url;
  if (!targetUrl) return;

  let mcp;
  try {
    mcp = await createMcpClient();

    const originalDevUrl = process.env.TARGET_DEV_URL;
    process.env.TARGET_DEV_URL = targetUrl;

    const report = await runCrawl(mcp, [{ path: '', name: 'Retest', critical: true, waitFor: null }], targetUrl);
    process.env.TARGET_DEV_URL = originalDevUrl;

    const passed = report.summary.critical === 0;
    const details =
      `URL: ${targetUrl}\n` +
      `Triggered by: @${userName}\n` +
      `Critical: ${report.summary.critical} | Warnings: ${report.summary.warning} | Info: ${report.summary.info}`;

    await postRetestResult(messageTs, channelId, passed ? 'pass' : 'fail', details);
  } catch (err) {
    console.error('[ARGUS] Retest interaction failed:', err.message);
    await postRetestResult(messageTs, channelId, 'fail', `Error: ${err.message}`);
  } finally {
    mcp?.close?.();
  }
}
