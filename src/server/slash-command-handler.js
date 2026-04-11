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

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

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

  const { command, text, channel_id, user_name, response_url } = req.body;

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

  // Run the test asynchronously
  runRetestAsync({ targetUrl, channelId: channel_id, responseUrl: response_url, requestedBy: user_name });
}

/**
 * Run a retest for a specific URL and post results back to Slack.
 * Runs after the 200 response is already sent.
 */
async function runRetestAsync({ targetUrl, channelId, responseUrl, requestedBy }) {
  let mcp;
  try {
    mcp = await createMcpClient();

    // Override the base URL for this run
    const originalDevUrl = process.env.TARGET_DEV_URL;
    process.env.TARGET_DEV_URL = targetUrl;

    // Import config and temporarily override routes to just this one URL
    const { routes } = await import('../config/targets.js');
    const singleRoute = [{ path: '', name: 'Retest', critical: true, waitFor: null }];

    const report = await runCrawl(mcp, singleRoute, targetUrl);
    process.env.TARGET_DEV_URL = originalDevUrl;

    const { summary } = report;
    const passed = summary.critical === 0;
    const emoji = passed ? '✅' : '❌';
    const status = passed ? 'PASSED' : 'FAILED';

    // Post follow-up to channel
    await slack.chat.postMessage({
      channel: channelId,
      text: `${emoji} *Retest ${status}* for \`${targetUrl}\`\n` +
        `Requested by @${requestedBy}\n` +
        `Critical: ${summary.critical} | Warnings: ${summary.warning} | Info: ${summary.info}`,
    });

    if (!passed) {
      // Detailed bug reports already dispatched to #bugs-critical by runCrawl
      await slack.chat.postMessage({
        channel: channelId,
        text: `↑ Full bug reports sent to <#${process.env.SLACK_CHANNEL_CRITICAL}>`,
      });
    }
  } catch (err) {
    console.error('[ARGUS] Retest failed:', err.message);
    await slack.chat.postMessage({
      channel: channelId,
      text: `⚠️ *Retest error* for \`${targetUrl}\`: ${err.message}`,
    }).catch(() => {});
  } finally {
    mcp?.close?.();
  }
}
