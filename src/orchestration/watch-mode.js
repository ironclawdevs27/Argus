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
 *   ARGUS_WATCH_INTERVAL_MS  — poll interval in ms (default: 3000)
 *   TARGET_DEV_URL           — base URL to monitor (default: http://localhost:3000)
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { createMcpClient } from '../utils/mcp-client.js';
import {
  analyzeSecurityConsole,
  analyzeSecurityNetwork,
} from '../utils/security-analyzer.js';
import { postBugReport }      from './slack-notifier.js';
import { isSlackConfigured }  from '../utils/slack-guard.js';
import { generateHtmlReport } from '../utils/html-reporter.js';
import { normalizeArray }     from '../utils/flow-runner.js';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.resolve(__dirname, '../../reports');

// ── Text-format parsers ─────────────────────────────────────────────────────────
// chrome-devtools-mcp@latest returns list_console_messages / list_network_requests
// as human-readable markdown text rather than JSON.  These parsers extract
// structured objects so the rest of the pipeline can work normally.

/**
 * Parse the text response from list_console_messages.
 * Format: "msgid=N [level] text (N args)\n..."
 * @param {any} raw - Raw value returned by the MCP tool
 * @returns {object[]}
 */
function parseConsoleMsgResponse(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'object') return normalizeArray(raw);
  if (typeof raw !== 'string') return [];
  const msgs = [];
  const re = /msgid=(\d+)\s+\[(\w+)\]\s+(.*?)(?:\s+\(\d+\s+args?\))?$/gm;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const [, msgid, rawLevel, text] = m;
    const level = rawLevel === 'warn' ? 'warning' : rawLevel.toLowerCase();
    msgs.push({ _msgid: Number(msgid), level, text, message: text });
  }
  return msgs;
}

/**
 * Parse the text response from list_network_requests.
 * Format: "reqid=N METHOD URL [STATUS]\n..."
 * @param {any} raw - Raw value returned by the MCP tool
 * @returns {object[]}
 */
function parseNetworkReqResponse(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'object') return normalizeArray(raw);
  if (typeof raw !== 'string') return [];
  const reqs = [];
  const re = /reqid=(\d+)\s+(\w+)\s+(\S+)\s+\[(\d+)\]/gm;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const [, reqid, method, url, statusStr] = m;
    const status = parseInt(statusStr, 10);
    reqs.push({ _reqid: Number(reqid), method, url, status, statusCode: status });
  }
  return reqs;
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
  r.requestId ?? `${r.method ?? 'GET'}::${r.url ?? ''}::${r.status ?? r.statusCode ?? 0}`;

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
  constructor(mcp, baseUrl) {
    this._mcp        = mcp;
    this._baseUrl    = baseUrl;
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
    const allConsole = parseConsoleMsgResponse(await this._mcp.list_console_messages({}));
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
    const allNetwork = parseNetworkReqResponse(await this._mcp.list_network_requests({}));
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
  const pollIntervalMs  = parseInt(process.env.ARGUS_WATCH_INTERVAL_MS ?? '3000', 10);

  const mcp     = await createMcpClient();
  const session = new WatchSession(mcp, target);

  console.log('\n[ARGUS WATCH] ─────────────────────────────────────────────────');
  console.log(`[ARGUS WATCH] Passive monitoring — ${target}`);
  console.log(`[ARGUS WATCH] Polling every ${pollIntervalMs}ms. Press Ctrl+C to stop.`);
  console.log('[ARGUS WATCH] ─────────────────────────────────────────────────\n');

  const badge = (severity) =>
    severity === 'critical' ? '✗ CRIT' :
    severity === 'warning'  ? '! WARN' : 'i INFO';

  const doPoll = async () => {
    try {
      const { findings } = await session.poll();
      if (findings.length === 0) return;

      console.log(`\n[ARGUS WATCH] ${new Date().toLocaleTimeString()} — ${findings.length} new finding(s):`);
      for (const f of findings) {
        console.log(`  [${badge(f.severity)}] [${f.type}] ${f.message}`);
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
          }).catch(e => console.warn('[ARGUS WATCH] Slack post failed:', e.message));
        }
      }
    } catch (err) {
      console.warn('[ARGUS WATCH] Poll error:', err.message);
    }
  };

  // First poll fires immediately, then on interval
  await doPoll();
  const interval = setInterval(doPoll, pollIntervalMs);

  process.on('SIGINT', async () => {
    clearInterval(interval);
    const all = session.getAllFindings();

    console.log(`\n[ARGUS WATCH] Stopped. Total findings: ${all.length}`);

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
        console.log(`[ARGUS WATCH] HTML report written → ${htmlPath}`);
      } catch (e) {
        console.warn('[ARGUS WATCH] HTML report failed:', e.message);
      }
    } else {
      console.log('[ARGUS WATCH] No issues detected during this session. ✓');
    }

    try { await mcp.close(); } catch { /* ignore */ }
    process.exit(0);
  });
}

// ── CLI invocation ─────────────────────────────────────────────────────────────

// Run when invoked directly: node src/orchestration/watch-mode.js [url]
if (process.argv[1]?.endsWith('watch-mode.js')) {
  runWatchMode(process.argv[2]).catch(err => {
    console.error('[ARGUS WATCH] Fatal:', err.message);
    process.exit(1);
  });
}
