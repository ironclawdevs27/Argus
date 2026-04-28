/**
 * ARGUS Slash Command Handler
 *
 * Handles Slack slash command: /argus-retest <url>
 *
 * Flow:
 *   1. Slack POSTs to this handler with the slash command payload
 *   2. We verify the request signature (SLACK_SIGNING_SECRET)
 *   3. Respond immediately with 200 + "Running..." (Slack requires < 3s response)
 *   4. Kick off the test run asynchronously
 *   5. Post results back to the channel as a follow-up message
 *
 * Configure in Slack App:
 *   Slash Commands → /argus-retest → Request URL: https://your-server.com/slack/commands
 */

import crypto from 'crypto';
import { postBugReport } from '../orchestration/slack-notifier.js';
import { createMcpClient } from '../utils/mcp-client.js';
import { runCrawl } from '../orchestration/crawl-and-report.js';
import { WebClient } from '@slack/web-api';

// GAP-31: Lazy-initialize the Slack client so SLACK_BOT_TOKEN is read at call time,
// not at module import time (before dotenv has run).
let _slack;
function getSlack() {
  return (_slack ??= new WebClient(process.env.SLACK_BOT_TOKEN));
}

/**
 * Verify that a request genuinely came from Slack using the signing secret.
 * https://api.slack.com/authentication/verifying-requests-from-slack
 *
 * @param {object} req - Express request
 * @returns {boolean}
 */
export function verifySlackSignature(req) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) return false;

  const slackSignature = req.headers['x-slack-signature'];
  const timestamp = req.headers['x-slack-request-timestamp'];

  if (!slackSignature || !timestamp) return false;

  // Reject requests older than 5 minutes (replay attack protection)
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - parseInt(timestamp, 10)) > 300) return false;

  const sigBasestring = `v0:${timestamp}:${req.rawBody}`;
  const mySignature = 'v0=' + crypto
    .createHmac('sha256', signingSecret)
    .update(sigBasestring)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(mySignature),
    Buffer.from(slackSignature)
  );
}

/**
 * Handle POST /slack/commands
 * @param {object} req - Express request
 * @param {object} res - Express response
 */
export async function handleSlashCommand(req, res) {
  // Verify signature
  if (!verifySlackSignature(req)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const { command, text, response_url } = req.body;
  // GAP-84: Slack guarantees channel_id and user_name in slash commands, but crafted or
  // malformed POSTs may omit them. Guard explicitly so downstream interpolations are safe.
  const channel_id = req.body.channel_id;
  const user_name = req.body.user_name ?? 'unknown';
  if (!channel_id) return res.status(400).json({ error: 'Missing channel_id' });

  if (command !== '/argus-retest') {
    return res.status(400).json({ error: 'Unknown command' });
  }

  const targetUrl = (text ?? '').trim();

  if (!targetUrl) {
    return res.json({
      response_type: 'ephemeral',
      text: '⚠️ Usage: `/argus-retest <url>`\nExample: `/argus-retest https://staging.yourapp.com/checkout`',
    });
  }

  // Validate URL
  try {
    new URL(targetUrl);
  } catch {
    return res.json({
      response_type: 'ephemeral',
      text: `⚠️ Invalid URL: \`${targetUrl}\`. Please provide a full URL including protocol.`,
    });
  }

  // Respond immediately — Slack requires a response within 3 seconds
  res.json({
    response_type: 'in_channel',
    text: `🔄 *ARGUS retest started* for \`${targetUrl}\`\nRequested by @${user_name}. Results will appear here shortly...`,
  });

  // GAP-32: Attach .catch() so an unexpected rejection doesn't become an unhandled rejection
  // that crashes the server (Node 15+ terminates on unhandled rejections).
  runRetestAsync({ targetUrl, channelId: channel_id, responseUrl: response_url, requestedBy: user_name })
    .catch(err => console.error('[ARGUS] runRetestAsync unhandled:', err.message));
}

/**
 * Run a retest for a specific URL and post results back to Slack.
 * Runs after the 200 response is already sent.
 */
async function runRetestAsync({ targetUrl, channelId, responseUrl, requestedBy }) {
  let mcp;
  try {
    mcp = await createMcpClient();

    // GAP-33 + GAP-40: Do NOT mutate process.env.TARGET_DEV_URL — concurrent retests share
    // the same Node.js process env and would corrupt each other's URLs. Pass targetUrl directly.
    const singleRoute = [{ path: '', name: 'Retest', critical: true, waitFor: null }];
    const report = await runCrawl(mcp, singleRoute, targetUrl);

    const { summary } = report;
    const passed = summary.critical === 0;
    const emoji = passed ? '✅' : '❌';
    const status = passed ? 'PASSED' : 'FAILED';

    await getSlack().chat.postMessage({
      channel: channelId,
      text: `${emoji} *Retest ${status}* for \`${targetUrl}\`\n` +
        `Requested by @${requestedBy}\n` +
        `Critical: ${summary.critical} | Warnings: ${summary.warning} | Info: ${summary.info}`,
    });

    // GAP-38: Guard against SLACK_CHANNEL_CRITICAL being unset — would post "#undefined"
    if (!passed && process.env.SLACK_CHANNEL_CRITICAL) {
      await getSlack().chat.postMessage({
        channel: channelId,
        text: `↑ Full bug reports sent to <#${process.env.SLACK_CHANNEL_CRITICAL}>`,
      });
    }
  } catch (err) {
    // GAP-37: Log full error server-side; post only a generic message to Slack so internal
    // paths/stack traces/env var names are not leaked to the channel.
    console.error('[ARGUS] Retest failed:', err);
    // GAP-74: Log delivery failures — silent .catch(() => {}) meant the operator
    // had no indication when the error notification itself failed to post.
    await getSlack().chat.postMessage({
      channel: channelId,
      text: `⚠️ *Retest error* for \`${targetUrl}\` — check server logs for details`,
    }).catch(e => console.error('[ARGUS] Failed to post error notification:', e.message));
  } finally {
    mcp?.close?.();
  }
}
