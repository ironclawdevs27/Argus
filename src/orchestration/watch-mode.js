/**
 * Argus Watch Mode — passive browser monitoring.
 *
 * Instead of navigating to URLs itself, Argus connects to whatever page is
 * already open in Chrome and polls list_console_messages / list_network_requests
 * at a configurable interval, reporting new errors in real time.
 *
 * Usage (production):
 *   npm run watch
 *   # or: node src/orchestration/watch-mode.js
 *
 * The WatchSession class is exported separately so the test harness can drive
 * individual poll() calls without running the interval loop.
 *
 * Environment variables:
 *   ARGUS_WATCH_INTERVAL_MS  — poll interval in ms (default: 1000)
 *   TARGET_DEV_URL           — base URL to monitor (default: http://localhost:3000)
 *   ARGUS_WATCH_UI_PORT      — port for the live web dashboard (default: 3002)
 */

import fs   from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { createMcpClient } from '../utils/mcp-client.js';
import { childLogger } from '../utils/logger.js';

const logger = childLogger('watch-mode');
import { CdpBrowserAdapter } from '../adapters/browser.js';
import {
  analyzeSecurityConsole,
  analyzeSecurityNetwork,
} from '../utils/security-analyzer.js';
import { postBugReport }      from './slack-notifier.js';
import { isSlackConfigured }  from '../utils/slack-guard.js';
import { generateHtmlReport } from '../utils/html-reporter.js';
import {
  parseConsoleMsgResponse,
  parseNetworkReqResponse,
} from '../utils/mcp-parsers.js';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.resolve(__dirname, '../../reports');

// ── Live dashboard ─────────────────────────────────────────────────────────────

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Argus Watch Dashboard</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0d0d0d; color: #e0e0e0; font-family: 'Segoe UI', system-ui, sans-serif; min-height: 100vh; }
  header { background: #111; border-bottom: 1px solid #1e1e1e; padding: 14px 24px; display: flex; align-items: center; gap: 12px; }
  .pulse-dot { width: 10px; height: 10px; border-radius: 50%; background: #5E0ED7; flex-shrink: 0;
    animation: pulse 1.8s ease-in-out infinite; }
  @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.4;transform:scale(1.3)} }
  .header-text { flex: 1; }
  .header-text h1 { font-size: 15px; font-weight: 600; color: #fff; letter-spacing: .02em; }
  .header-text small { font-size: 11px; color: #666; }
  .pills { display: flex; gap: 8px; flex-wrap: wrap; padding: 16px 24px; }
  .pill { font-size: 12px; font-weight: 600; padding: 4px 12px; border-radius: 999px; letter-spacing: .04em; }
  .pill-critical { background: #3a0e0e; color: #f87171; border: 1px solid #7f1d1d; }
  .pill-warning  { background: #2e2200; color: #fbbf24; border: 1px solid #78350f; }
  .pill-info     { background: #1a0b33; color: #a78bfa; border: 1px solid #4c1d95; }
  .pill-clear    { background: #0b2718; color: #34d399; border: 1px solid #064e3b; }
  .status-bar { font-size: 11px; padding: 4px 24px 12px; color: #555; }
  .status-bar.error { color: #f87171; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  thead th { background: #161616; color: #888; font-weight: 600; text-align: left;
    padding: 10px 16px; border-bottom: 1px solid #222; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
  tbody tr { border-bottom: 1px solid #181818; transition: background .15s; }
  tbody tr:hover { background: #151515; }
  td { padding: 10px 16px; vertical-align: top; }
  .sev { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 4px; white-space: nowrap; }
  .sev-critical { background: #3a0e0e; color: #f87171; }
  .sev-warning  { background: #2e2200; color: #fbbf24; }
  .sev-info     { background: #1a0b33; color: #a78bfa; }
  .type-cell { color: #9ca3af; font-size: 12px; font-family: monospace; white-space: nowrap; }
  .msg-cell  { color: #d1d5db; word-break: break-word; max-width: 480px; }
  .empty-row td { text-align: center; color: #444; padding: 40px; font-size: 13px; }
  .table-wrap { padding: 0 24px 24px; overflow-x: auto; }
</style>
</head>
<body>
<header>
  <div class="pulse-dot" id="dot"></div>
  <div class="header-text">
    <h1 id="target">Argus Watch</h1>
    <small id="lastPoll">Connecting…</small>
  </div>
</header>
<div class="pills" id="pills"></div>
<div class="status-bar" id="status"></div>
<div class="table-wrap">
  <table>
    <thead><tr><th>Severity</th><th>Type</th><th>Message</th></tr></thead>
    <tbody id="tbody"></tbody>
  </table>
</div>
<script>
  const SEV_ORDER = { critical: 0, warning: 1, info: 2 };

  function renderPills(findings) {
    const counts = { critical: 0, warning: 0, info: 0 };
    for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
    const pills = document.getElementById('pills');
    if (findings.length === 0) {
      pills.innerHTML = '<span class="pill pill-clear">All clear</span>';
      return;
    }
    let html = '';
    if (counts.critical) html += \`<span class="pill pill-critical">\${counts.critical} Critical</span>\`;
    if (counts.warning)  html += \`<span class="pill pill-warning">\${counts.warning} Warning</span>\`;
    if (counts.info)     html += \`<span class="pill pill-info">\${counts.info} Info</span>\`;
    pills.innerHTML = html;
  }

  function renderTable(findings) {
    const sorted = [...findings].sort((a, b) =>
      (SEV_ORDER[a.severity] ?? 3) - (SEV_ORDER[b.severity] ?? 3));
    const tbody = document.getElementById('tbody');
    if (sorted.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="3">No findings yet</td></tr>';
      return;
    }
    tbody.innerHTML = sorted.map(f => {
      const sc = 'sev-' + (f.severity || 'info');
      const msg = (f.message || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const typ = (f.type || '').replace(/&/g,'&amp;');
      return \`<tr>
        <td><span class="sev \${sc}">\${f.severity ?? 'info'}</span></td>
        <td class="type-cell">\${typ}</td>
        <td class="msg-cell">\${msg}</td>
      </tr>\`;
    }).join('');
  }

  async function poll() {
    try {
      const res = await fetch('/data');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      document.getElementById('target').textContent = 'Argus Watch — ' + (data.target || '');
      document.getElementById('lastPoll').textContent = 'Last poll: ' + new Date(data.lastPoll).toLocaleTimeString();
      document.getElementById('dot').style.background = '#5E0ED7';
      document.getElementById('status').textContent = '';
      document.getElementById('status').className = 'status-bar';
      renderPills(data.findings || []);
      renderTable(data.findings || []);
    } catch (e) {
      document.getElementById('status').textContent = 'Connection lost — ' + e.message;
      document.getElementById('status').className = 'status-bar error';
      document.getElementById('dot').style.background = '#555';
    }
  }

  poll();
  setInterval(poll, 2000);
</script>
</body>
</html>`;

/**
 * Start the live web dashboard HTTP server.
 *
 * @param {() => object[]} getFindings  — callback that returns current findings array
 * @param {string}         target       — the URL being monitored (shown in header)
 * @param {number}         port         — TCP port to listen on (default 3002)
 * @returns {http.Server}
 */
function startDashboard(getFindings, target, port) {
  const server = http.createServer((req, res) => {
    if (req.url === '/data' || req.url?.startsWith('/data?')) {
      const payload = JSON.stringify({
        target,
        lastPoll: new Date().toISOString(),
        findings: getFindings(),
      });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(payload);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(DASHBOARD_HTML);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    logger.info(`[ARGUS WATCH] Dashboard → http://localhost:${port}`);
  });

  return server;
}

// ── Deduplication key generators ───────────────────────────────────────────────
// Two messages/requests are considered "the same" if their keys match. This
// prevents re-reporting errors that were already captured in a previous poll.
//
// Content-based keys (not ID-based) are intentional: msgid/reqid can reset
// after navigation, which would cause ID-based dedup to suppress new findings
// on a freshly loaded page if a prior page had the same IDs.

const consoleKey = (m) =>
  `${(m.level ?? m.type ?? 'log').toLowerCase()}::${(m.text ?? m.message ?? '').slice(0, 200)}`;

const networkKey = (r) =>
  `${r.method ?? 'GET'}::${r.url ?? ''}::${r.status ?? r.statusCode ?? 0}`;

// ── Classifiers ────────────────────────────────────────────────────────────────

function classifyConsoleMsg(msg, url) {
  const level = (msg.level ?? msg.type ?? '').toLowerCase();
  if (level === 'error' || level === 'exception' || level === 'jsexception') {
    return {
      type: 'console',
      severity: 'warning',
      message: msg.text ?? msg.message ?? '(empty)',
      url,
      source: msg.source ?? null,
    };
  }
  if (level === 'warning' || level === 'warn') {
    return {
      type: 'console_warning',
      severity: 'info',
      message: msg.text ?? msg.message ?? '(empty)',
      url,
      source: msg.source ?? null,
    };
  }
  return null;
}

function classifyNetworkReq(req, url) {
  const status = req.status ?? req.statusCode ?? 0;
  const reqUrl  = req.url ?? '';

  if (status === 401 || status === 403) {
    return {
      type: status === 401 ? 'network_auth_error' : 'network_forbidden',
      severity: 'critical',
      message: `HTTP ${status} — ${reqUrl}`,
      url: reqUrl,
      status,
    };
  }
  if (status === 404) {
    return {
      type: 'network_not_found',
      severity: 'warning',
      message: `HTTP 404 — ${reqUrl}`,
      url: reqUrl,
      status,
    };
  }
  if (status >= 500) {
    return {
      type: 'network_server_error',
      severity: 'critical',
      message: `HTTP ${status} — ${reqUrl}`,
      url: reqUrl,
      status,
    };
  }
  // CORS / net::ERR_* failures surface as failed requests with no status
  if (req.failed || req.error) {
    const err = (req.error ?? req.errorText ?? '').toLowerCase();
    if (err.includes('cors') || err.includes('blocked') || err.includes('cross-origin')) {
      return {
        type: 'cors_error',
        severity: 'critical',
        message: `CORS blocked — ${reqUrl}`,
        url: reqUrl,
      };
    }
    if (reqUrl) {
      return {
        type: 'network_failed',
        severity: 'warning',
        message: `Request failed — ${reqUrl}${req.error ? ': ' + req.error : ''}`,
        url: reqUrl,
      };
    }
  }
  return null;
}

// ── WatchSession ───────────────────────────────────────────────────────────────

/**
 * WatchSession tracks state between polls (seen console keys, seen network keys,
 * accumulated findings). It does NOT own the mcp client — the caller manages
 * the client lifecycle.
 *
 * Exported so the test harness can call poll() in isolation without running
 * the interval-based runWatchMode() entry point.
 */
export class WatchSession {
  constructor(browser, baseUrl) {
    this._browser     = browser;
    this._baseUrl     = baseUrl;
    this._seenConsole = new Set();
    this._seenNetwork = new Set();
    this._allFindings = [];
  }

  /**
   * Run one poll cycle.
   *
   * @returns {{ findings: object[], newConsole: object[], newNetwork: object[] }}
   *   findings    — only the NEW findings detected this poll (not previously seen)
   *   newConsole  — raw new console messages (for caller inspection)
   *   newNetwork  — raw new network requests (for caller inspection)
   */
  async poll() {
    const findings = [];

    // ── Console ──────────────────────────────────────────────────────────────
    const allConsole = await this._browser.listConsole();
    const newConsole = allConsole.filter(m => {
      const k = consoleKey(m);
      if (this._seenConsole.has(k)) return false;
      this._seenConsole.add(k);
      return true;
    });

    for (const msg of newConsole) {
      const f = classifyConsoleMsg(msg, this._baseUrl);
      if (f) findings.push(f);
    }

    // ── Network ──────────────────────────────────────────────────────────────
    const allNetwork = await this._browser.listNetwork();
    const newNetwork = allNetwork.filter(r => {
      const k = networkKey(r);
      if (this._seenNetwork.has(k)) return false;
      this._seenNetwork.add(k);
      return true;
    });

    for (const req of newNetwork) {
      const f = classifyNetworkReq(req, this._baseUrl);
      if (f) findings.push(f);
    }

    // ── Security surface (reuses existing analyzers) ──────────────────────────
    findings.push(...analyzeSecurityConsole(newConsole, this._baseUrl));
    findings.push(...analyzeSecurityNetwork(newNetwork, this._baseUrl));

    this._allFindings.push(...findings);
    return { findings, newConsole, newNetwork };
  }

  /** All findings accumulated across every poll() call so far. */
  getAllFindings() {
    return [...this._allFindings];
  }
}

// ── Production entry point ─────────────────────────────────────────────────────

/**
 * Start the watch loop. Polls on ARGUS_WATCH_INTERVAL_MS interval, prints new
 * findings to the terminal, posts to Slack if configured, and on Ctrl+C writes
 * a final HTML report.
 *
 * @param {string} [baseUrl] — URL to attribute findings to (does not navigate)
 */
export async function runWatchMode(baseUrl) {
  const target          = baseUrl ?? process.env.TARGET_DEV_URL ?? 'http://localhost:3000';
  const pollIntervalMs  = parseInt(process.env.ARGUS_WATCH_INTERVAL_MS ?? '1000', 10);

  const mcp     = await createMcpClient();
  const browser = new CdpBrowserAdapter(mcp);
  const session = new WatchSession(browser, target);

  logger.info('\n[ARGUS WATCH] ─────────────────────────────────────────────────');
  logger.info(`[ARGUS WATCH] Passive monitoring — ${target}`);
  logger.info(`[ARGUS WATCH] Polling every ${pollIntervalMs}ms. Press Ctrl+C to stop.`);
  logger.info('[ARGUS WATCH] ─────────────────────────────────────────────────\n');

  const uiPort   = parseInt(process.env.ARGUS_WATCH_UI_PORT ?? '3002', 10);
  const dashServer = startDashboard(() => session.getAllFindings(), target, uiPort);

  const badge = (severity) =>
    severity === 'critical' ? '✗ CRIT' :
    severity === 'warning'  ? '! WARN' : 'i INFO';

  const doPoll = async () => {
    try {
      const { findings } = await session.poll();
      if (findings.length === 0) return;

      logger.info(`\n[ARGUS WATCH] ${new Date().toLocaleTimeString()} — ${findings.length} new finding(s):`);
      for (const f of findings) {
        logger.info(`  [${badge(f.severity)}] [${f.type}] ${f.message}`);
      }

      if (isSlackConfigured()) {
        const bySeverity = { critical: [], warning: [], info: [] };
        for (const f of findings) {
          (bySeverity[f.severity] ?? bySeverity.info).push(f);
        }
        for (const [sev, group] of Object.entries(bySeverity)) {
          if (group.length === 0) continue;
          await postBugReport({
            severity: sev,
            title: `[Watch] ${group.length} ${sev} finding(s) — ${target}`,
            description: group.map(f => `• *[${f.type}]* ${f.message}`).join('\n'),
            url: target,
            screenshotPath: null,
            details: { findings: group, source: 'watch-mode' },
          }).catch(e => logger.warn('[ARGUS WATCH] Slack post failed:', e.message));
        }
      }
    } catch (err) {
      logger.warn('[ARGUS WATCH] Poll error:', err.message);
    }
  };

  // First poll fires immediately, then on interval
  await doPoll();
  const interval = setInterval(doPoll, pollIntervalMs);

  process.on('SIGINT', async () => {
    clearInterval(interval);
    try { dashServer.close(); } catch { /* ignore */ }
    const all = session.getAllFindings();

    logger.info(`\n[ARGUS WATCH] Stopped. Total findings: ${all.length}`);

    if (all.length > 0) {
      try {
        fs.mkdirSync(REPORTS_DIR, { recursive: true });
        const reportJson = {
          baseUrl:     target,
          generatedAt: new Date().toISOString(),
          summary: {
            total:    all.length,
            critical: all.filter(f => f.severity === 'critical').length,
            warning:  all.filter(f => f.severity === 'warning').length,
            info:     all.filter(f => f.severity === 'info').length,
          },
          routes: [{ route: 'watch', url: target, errors: all }],
          flows:  [],
        };
        const jsonPath = path.join(REPORTS_DIR, 'watch-report.json');
        fs.writeFileSync(jsonPath, JSON.stringify(reportJson, null, 2), 'utf8');
        const htmlPath = generateHtmlReport(jsonPath);
        logger.info(`[ARGUS WATCH] HTML report written → ${htmlPath}`);
      } catch (e) {
        logger.warn('[ARGUS WATCH] HTML report failed:', e.message);
      }
    } else {
      logger.info('[ARGUS WATCH] No issues detected during this session. ✓');
    }

    try { await browser.close(); } catch { /* ignore */ }
    process.exit(0);
  });
}

// ── CLI invocation ─────────────────────────────────────────────────────────────

// Run when invoked directly: node src/orchestration/watch-mode.js [url]
if (process.argv[1]?.endsWith('watch-mode.js')) {
  runWatchMode(process.argv[2]).catch(err => {
    logger.error('[ARGUS WATCH] Fatal:', err.message);
    process.exit(1);
  });
}
