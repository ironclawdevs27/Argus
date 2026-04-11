/**
 * ARGUS Phase 4: Slack Notification Dispatcher
 *
 * Posts rich Block Kit bug reports to Slack with:
 *   - Severity-based channel routing
 *   - Screenshot uploads via files.getUploadURLExternal + files.completeUploadExternal
 *   - Interactive action buttons (View Page, Acknowledge, Retest)
 *   - Threaded follow-up support
 *
 * Requires environment variables:
 *   SLACK_BOT_TOKEN        — xoxb-... token
 *   SLACK_CHANNEL_CRITICAL — channel ID for critical bugs
 *   SLACK_CHANNEL_WARNINGS — channel ID for warnings
 *   SLACK_CHANNEL_DIGEST   — channel ID for daily digest
 */

import { WebClient } from '@slack/web-api';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

const CHANNELS = {
  critical: process.env.SLACK_CHANNEL_CRITICAL,
  warning: process.env.SLACK_CHANNEL_WARNINGS,
  info: process.env.SLACK_CHANNEL_DIGEST,
};

const SEVERITY_EMOJI = {
  critical: '🔴',
  warning: '🟡',
  info: '🔵',
};

// ── File Upload (Current Slack API) ───────────────────────────────────────────

/**
 * Upload a file to Slack using the current (non-deprecated) upload API.
 * Steps: getUploadURLExternal → POST binary → completeUploadExternal
 *
 * @param {string} filePath - Absolute path to the file
 * @param {string} channelId - Channel to share the file into
 * @param {string} filename - Display filename in Slack
 * @returns {string|null} Slack file ID if successful, null on failure
 */
async function uploadFileToSlack(filePath, channelId, filename) {
  if (!filePath || !fs.existsSync(filePath)) return null;

  const fileBuffer = fs.readFileSync(filePath);
  const fileSize = fileBuffer.length;

  // Step 1: Get a pre-signed upload URL from Slack
  let uploadUrl, fileId;
  try {
    const urlResponse = await slack.files.getUploadURLExternal({
      filename,
      length: fileSize,
    });
    uploadUrl = urlResponse.upload_url;
    fileId = urlResponse.file_id;
  } catch (err) {
    console.error('[ARGUS] Failed to get Slack upload URL:', err.message);
    return null;
  }

  // Step 2: PUT the binary data to the pre-signed URL
  // Slack requires PUT here — POST silently fails and produces a broken/missing file
  try {
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: fileBuffer,
    });
    if (!response.ok) {
      console.error('[ARGUS] Slack upload POST failed:', response.status, response.statusText);
      return null;
    }
  } catch (err) {
    console.error('[ARGUS] Slack upload fetch error:', err.message);
    return null;
  }

  // Step 3: Complete the upload and share to channel
  try {
    await slack.files.completeUploadExternal({
      files: [{ id: fileId, title: filename }],
      channel_id: channelId,
    });
  } catch (err) {
    console.error('[ARGUS] Failed to complete Slack upload:', err.message);
    return null;
  }

  return fileId;
}

// ── Block Kit Message Builder ─────────────────────────────────────────────────

/**
 * Build a Slack Block Kit message payload for a bug report.
 *
 * @param {object} opts
 * @param {string} opts.severity - 'critical' | 'warning' | 'info'
 * @param {string} opts.title - Short title
 * @param {string} opts.description - Longer description / AI-generated summary
 * @param {string} opts.url - Affected URL
 * @param {string|null} opts.fileId - Slack file ID of uploaded screenshot (or null)
 * @param {object} opts.details - Raw detail object (shown as JSON in fallback)
 * @returns {object[]} Slack blocks array
 */
function buildBugReportBlocks({ severity, title, description, url, fileId, details }) {
  const emoji = SEVERITY_EMOJI[severity] ?? '⚪';
  const severityLabel = severity.charAt(0).toUpperCase() + severity.slice(1);

  const blocks = [
    // Header
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${emoji} [${severityLabel}] ${title}`,
        emoji: true,
      },
    },
    // Description
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: description.length > 3000 ? description.slice(0, 2997) + '...' : description,
      },
    },
    // URL + timestamp
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `*URL:* ${url}  |  *Detected:* <!date^${Math.floor(Date.now() / 1000)}^{date_short_pretty} at {time}|${new Date().toISOString()}>`,
        },
      ],
    },
    // Divider
    { type: 'divider' },
  ];

  // Screenshot block — uses slack_file reference so no external hosting needed
  if (fileId) {
    blocks.push({
      type: 'image',
      slack_file: { id: fileId },
      alt_text: `Screenshot for: ${title}`,
    });
    blocks.push({ type: 'divider' });
  }

  // Action buttons
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'View Page', emoji: true },
        url,
        action_id: 'view_page',
        style: severity === 'critical' ? 'danger' : 'primary',
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Acknowledge', emoji: true },
        action_id: 'acknowledge',
        value: JSON.stringify({ title, url, severity }),
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Retest', emoji: true },
        action_id: 'retest',
        value: JSON.stringify({ url, severity }),
      },
    ],
  });

  return blocks;
}

// ── Main Dispatcher ───────────────────────────────────────────────────────────

/**
 * Post a bug report to the appropriate Slack channel.
 *
 * @param {object} opts
 * @param {'critical'|'warning'|'info'} opts.severity
 * @param {string} opts.title
 * @param {string} opts.description
 * @param {string} opts.url - Affected URL
 * @param {string|null} opts.screenshotPath - Local path to screenshot file
 * @param {object} opts.details - Additional raw detail data
 * @param {string|null} opts.threadTs - If set, post as thread reply (from follow-up retest)
 * @returns {{ ts: string, channel: string }|null} Message timestamp + channel, or null on failure
 */
export async function postBugReport({ severity, title, description, url, screenshotPath, details, threadTs = null }) {
  const channelId = CHANNELS[severity];

  if (!channelId) {
    console.warn(`[ARGUS] No Slack channel configured for severity: ${severity}. Set SLACK_CHANNEL_${severity.toUpperCase()} in .env`);
    return null;
  }

  if (!process.env.SLACK_BOT_TOKEN) {
    console.warn('[ARGUS] SLACK_BOT_TOKEN not set — skipping Slack notification');
    console.log(`[ARGUS] Would post: [${severity}] ${title} → ${url}`);
    return null;
  }

  // Upload screenshot if provided
  const filename = screenshotPath ? path.basename(screenshotPath) : null;
  const fileId = screenshotPath
    ? await uploadFileToSlack(screenshotPath, channelId, filename)
    : null;

  // Build Block Kit blocks
  const blocks = buildBugReportBlocks({ severity, title, description, url, fileId, details });

  // Post message
  try {
    const result = await slack.chat.postMessage({
      channel: channelId,
      text: `[${severity.toUpperCase()}] ${title} — ${url}`, // fallback text
      blocks,
      thread_ts: threadTs ?? undefined,
    });

    console.log(`[ARGUS] Slack message posted: ${result.ts} → channel ${channelId}`);
    return { ts: result.ts, channel: channelId };
  } catch (err) {
    console.error('[ARGUS] Failed to post Slack message:', err.message);
    return null;
  }
}

/**
 * Post a retest follow-up as a thread reply to the original bug message.
 *
 * @param {string} originalTs - Timestamp of the original bug message
 * @param {string} channelId - Channel of the original message
 * @param {'pass'|'fail'} outcome
 * @param {string} details - Human-readable retest result summary
 */
export async function postRetestResult(originalTs, channelId, outcome, details) {
  if (!process.env.SLACK_BOT_TOKEN) return;

  const emoji = outcome === 'pass' ? '✅' : '❌';
  const text = `${emoji} *Retest ${outcome.toUpperCase()}*\n${details}`;

  try {
    await slack.chat.postMessage({
      channel: channelId,
      text,
      thread_ts: originalTs,
    });
  } catch (err) {
    console.error('[ARGUS] Failed to post retest reply:', err.message);
  }
}

/**
 * Update an existing Slack message (e.g., to mark a bug as acknowledged).
 *
 * @param {string} ts - Message timestamp
 * @param {string} channelId - Channel ID
 * @param {string} acknowledgingUser - Display name of acknowledging user
 */
export async function acknowledgeMessage(ts, channelId, acknowledgingUser) {
  if (!process.env.SLACK_BOT_TOKEN) return;

  try {
    // Append an acknowledged context block by updating the message
    const existing = await slack.conversations.history({
      channel: channelId,
      latest: ts,
      inclusive: true,
      limit: 1,
    });

    const msg = existing.messages?.[0];
    if (!msg) return;

    const updatedBlocks = [
      ...(msg.blocks ?? []),
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `✅ Acknowledged by *${acknowledgingUser}* at <!date^${Math.floor(Date.now() / 1000)}^{time}|now>`,
          },
        ],
      },
    ];

    await slack.chat.update({
      channel: channelId,
      ts,
      blocks: updatedBlocks,
      text: msg.text + ' [ACKNOWLEDGED]',
    });
  } catch (err) {
    console.error('[ARGUS] Failed to acknowledge message:', err.message);
  }
}
