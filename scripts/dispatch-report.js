/**
 * One-shot dispatcher: reads the latest error report JSON and sends it to Slack.
 * Run: node scripts/dispatch-report.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { WebClient } from '@slack/web-api';

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

const CHANNELS = {
  critical: process.env.SLACK_CHANNEL_CRITICAL,
  warning:  process.env.SLACK_CHANNEL_WARNINGS,
  info:     process.env.SLACK_CHANNEL_DIGEST,
};

const SEVERITY_EMOJI = { critical: '🔴', warning: '🟡', info: '🔵' };

async function uploadScreenshot(filePath, channelId) {
  if (!filePath || !fs.existsSync(filePath)) return;
  const fileBuffer = fs.readFileSync(filePath);
  try {
    const { upload_url, file_id } = await slack.files.getUploadURLExternal({
      filename: path.basename(filePath),
      length: fileBuffer.length,
    });
    const res = await fetch(upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: fileBuffer,
    });
    if (!res.ok) throw new Error(`Upload PUT failed: ${res.status}`);
    await slack.files.completeUploadExternal({
      files: [{ id: file_id, title: path.basename(filePath) }],
      channel_id: channelId,
    });
    console.log(`[dispatch] Screenshot uploaded: ${path.basename(filePath)}`);
  } catch (err) {
    console.warn(`[dispatch] Screenshot upload failed: ${err.message}`);
  }
}

async function postReport({ severity, title, description, url, screenshotPath }) {
  const channelId = CHANNELS[severity];
  if (!channelId) return;

  const emoji = SEVERITY_EMOJI[severity] ?? '⚪';
  const label = severity.charAt(0).toUpperCase() + severity.slice(1);

  // Upload screenshot first (appears in channel as a file post above the message)
  if (screenshotPath) await uploadScreenshot(screenshotPath, channelId);

  // Post the text message (no slack_file image block — avoids invalid_blocks error)
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${emoji} [${label}] ${title}`, emoji: true },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: description.length > 3000 ? description.slice(0, 2997) + '...' : description },
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `*URL:* ${url}  |  *Detected:* <!date^${Math.floor(Date.now() / 1000)}^{date_short_pretty} at {time}|${new Date().toISOString()}>`,
      }],
    },
    { type: 'divider' },
    {
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
    },
  ];

  try {
    const result = await slack.chat.postMessage({
      channel: channelId,
      text: `[${severity.toUpperCase()}] ${title} — ${url}`,
      blocks,
    });
    console.log(`[dispatch] Posted [${severity}] to ${channelId}: ${result.ts}`);
  } catch (err) {
    console.error(`[dispatch] Failed to post [${severity}]:`, err.message);
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.resolve(__dirname, '../reports');

// Find the latest report JSON
const reportFiles = fs.readdirSync(REPORTS_DIR)
  .filter(f => f.startsWith('error-report-') && f.endsWith('.json'))
  .sort()
  .reverse();

if (reportFiles.length === 0) {
  console.error('[dispatch] No report files found in', REPORTS_DIR);
  process.exit(1);
}

const reportPath = path.join(REPORTS_DIR, reportFiles[0]);
console.log('[dispatch] Loading report:', reportPath);
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

const allErrors = report.routes.flatMap(r =>
  r.errors.map(e => ({ ...e, routeName: r.route, screenshot: r.screenshot }))
);

const criticals = allErrors.filter(e => e.severity === 'critical');
const warnings  = allErrors.filter(e => e.severity === 'warning');
const infos     = allErrors.filter(e => e.severity === 'info');

console.log(`[dispatch] ${criticals.length} critical, ${warnings.length} warnings, ${infos.length} info`);

// ── Criticals: one message per route (grouped), with the route screenshot ──────
const criticalsByRoute = {};
for (const err of criticals) {
  if (!criticalsByRoute[err.routeName]) criticalsByRoute[err.routeName] = { errors: [], screenshot: err.screenshot };
  criticalsByRoute[err.routeName].errors.push(err);
}

for (const [routeName, { errors, screenshot }] of Object.entries(criticalsByRoute)) {
  const screenshotPath = screenshot ? path.resolve(__dirname, '..', screenshot) : null;
  const description = errors.map(e => `• *[${e.type}]* ${e.message}`).join('\n');
  await postReport({
    severity: 'critical',
    title: `${errors.length} critical issue(s) on ${routeName}`,
    description,
    url: errors[0].url,
    screenshotPath,
  });
}

// ── Warnings: one batched message ─────────────────────────────────────────────
if (warnings.length > 0) {
  const firstScreenshot = report.routes.find(r => r.screenshot)?.screenshot ?? null;
  const screenshotPath = firstScreenshot ? path.resolve(__dirname, '..', firstScreenshot) : null;
  await postReport({
    severity: 'warning',
    title: `${warnings.length} warning(s) — localhost:3000 crawl`,
    description: warnings.map(e => `• *[${e.routeName}]* ${e.message}`).join('\n'),
    url: report.baseUrl,
    screenshotPath,
  });
}

// ── Info digest ────────────────────────────────────────────────────────────────
await postReport({
  severity: 'info',
  title: `Argus crawl digest — localhost:3000 (${new Date(report.generatedAt).toLocaleString()})`,
  description: [
    `*Summary:* ${report.summary.total} findings across ${report.routes.length} routes`,
    `🔴 ${report.summary.critical} critical  🟡 ${report.summary.warning} warnings  🔵 ${report.summary.info} info`,
    '',
    ...infos.map(e => `• *[${e.routeName}]* ${e.message}`),
  ].join('\n'),
  url: report.baseUrl,
  screenshotPath: null,
});

console.log('[dispatch] Done.');
