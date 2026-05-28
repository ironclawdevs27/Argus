#!/usr/bin/env node
/**
 * Argus MCP Server (v9.2.9)
 *
 * Exposes Argus as an MCP server so Claude (or any MCP client) can call
 * argus_audit, argus_audit_full, argus_compare, and argus_last_report
 * directly from a conversation without using the CLI.
 *
 * Architecture: MCP-inside-MCP
 *   Claude (MCP client)
 *     → Argus MCP Server (this file)
 *       → chrome-devtools-mcp client (mcp-client.js)
 *         → Chrome (CDP)
 *
 * Registration: add to .mcp.json as "argus" server.
 * Run standalone: node src/mcp-server.js
 */

import { Server }              from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs   from 'fs';
import path from 'path';

import { createMcpClient }                    from './utils/mcp-client.js';
import { crawlRouteCheap, runCrawl }          from './orchestration/crawl-and-report.js';
import { runComparison }                      from './orchestration/env-comparison.js';
import { WatchSession }                       from './orchestration/watch-mode.js';
import { CdpBrowserAdapter }                  from './adapters/browser.js';

const REPORTS_DIR = path.resolve(process.cwd(), 'reports');

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'argus_audit',
    description: 'Fast QA audit on a URL via Chrome DevTools Protocol. Runs 8 analyzers in one pass: JS errors, unhandled rejections, network failures (4xx/5xx), API frequency loops, CSS cascade issues, SEO violations, security header checks, and accessibility. Returns { findings: [{severity, type, message, url}], summary: {critical, warning, info} }. Use for CI smoke tests and pre-deploy gates. For Lighthouse scoring and memory leak detection, use argus_audit_full. Requires Chrome running with --remote-debugging-port=9222.',
    inputSchema: {
      type: 'object',
      properties: {
        url:      { type: 'string',  description: 'Full URL to audit, including protocol and path (e.g. http://localhost:3000/checkout). Must be reachable by the running Chrome instance.' },
        critical: { type: 'boolean', description: 'When true, console.error calls are escalated to critical severity. Set true for business-critical routes (login, checkout, dashboard) where any error is a blocker.', default: false },
      },
      required: ['url'],
    },
  },
  {
    name: 'argus_audit_full',
    description: 'Deep QA audit — extends argus_audit with Lighthouse performance/accessibility scoring, responsive layout checks across 4 viewports (320/768/1280/1920px), memory leak detection via heap snapshot, hover-state regression detection, and accessibility tree snapshot. Returns full JSON report with findings by severity, Lighthouse scores, and layout overflow details. Use when argus_audit passes clean but visual or performance regressions are suspected. Requires Chrome running with --remote-debugging-port=9222.',
    inputSchema: {
      type: 'object',
      properties: {
        url:      { type: 'string',  description: 'Full URL to audit, including protocol and path (e.g. https://example.com/dashboard). Must be reachable by the running Chrome instance.' },
        critical: { type: 'boolean', description: 'When true, console.error calls are escalated to critical severity. Set true for business-critical routes (login, checkout, dashboard) where any error is a blocker.', default: false },
      },
      required: ['url'],
    },
  },
  {
    name: 'argus_compare',
    description: 'Diffs dev vs staging environments side-by-side. Navigates both URLs, captures screenshots, and runs the full analyzer suite on each, then surfaces regressions — findings present in staging but not dev, or with changed severity. Returns { regressions: [{type, devSeverity, stagingSeverity}], screenshots, summary }. Run before promoting a build to staging to catch environment-specific bugs. Set TARGET_DEV_URL and TARGET_STAGING_URL env vars before starting the server; omit TARGET_STAGING_URL to run CSS-analysis-only mode.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'argus_last_report',
    description: 'Returns the most recent Argus JSON report from the reports/ directory. Report includes a findings array and severity summary (critical/warning/info counts). Returns { "error": "No reports found in reports/" } when no audits have been run yet. Use to retrieve prior results without re-running a scan, or to pipe findings into another analysis tool.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'argus_watch_snapshot',
    description: 'Snapshots the currently open Chrome tab without navigating — captures console errors, network failures (4xx/5xx), CORS blocks, and auth failures in one poll. Returns { findings: [{severity, type, message, url}], newConsole, newNetwork }. Use during active development to inspect what is happening on the current page without running a full audit. Requires Chrome on --remote-debugging-port=9222 with a page already open.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Optional base URL to attribute findings to (default: TARGET_DEV_URL env var). Does not navigate — reads the currently open Chrome tab.' },
      },
    },
  },
  {
    name: 'argus_get_context',
    description: 'Captures everything currently broken on the open Chrome tab and formats it as a diagnostic context for Claude to read and suggest fixes. Does NOT navigate — reads the live tab state after user interactions, in authenticated sessions, or mid-flow. Returns { summary, url, timestamp, critical_issues, warnings, js_errors, network_failures, console_errors, recent_requests } where summary is a plain-English description of what is broken. Use when the app is stuck, throwing errors, or behaving unexpectedly — run this, then paste the output to Claude and ask for fixes. Requires Chrome on --remote-debugging-port=9222.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Optional base URL to attribute findings to (default: TARGET_DEV_URL env var). Does not navigate — inspects the currently open Chrome tab.' },
      },
    },
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

async function withMcp(fn) {
  const mcp = await createMcpClient();
  try {
    return await fn(mcp);
  } finally {
    try { mcp.close(); } catch { /* ignore — process already gone */ }
  }
}

// ── Tool handlers ─────────────────────────────────────────────────────────────

async function handleAudit({ url, critical = false }) {
  return withMcp(async (mcp) => {
    const parsed  = new URL(url);
    const route   = { path: parsed.pathname + parsed.search + parsed.hash, name: 'audit', critical };
    const findings = await crawlRouteCheap(route, parsed.origin, mcp);
    return { content: [{ type: 'text', text: JSON.stringify(findings, null, 2) }] };
  });
}

async function handleAuditFull({ url, critical = false }) {
  return withMcp(async (mcp) => {
    const parsed = new URL(url);
    const report = await runCrawl(
      mcp,
      [{ path: parsed.pathname + parsed.search + parsed.hash, name: 'audit', critical }],
      parsed.origin,
    );
    return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
  });
}

async function handleCompare() {
  return withMcp(async (mcp) => {
    const report = await runComparison(mcp);
    return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
  });
}

async function handleWatchSnapshot({ url } = {}) {
  return withMcp(async (mcp) => {
    const browser = new CdpBrowserAdapter(mcp);
    const baseUrl = url ?? process.env.TARGET_DEV_URL ?? 'http://localhost:3000';
    const session = new WatchSession(browser, baseUrl);
    const result  = await session.poll();
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });
}

async function handleGetContext({ url } = {}) {
  return withMcp(async (mcp) => {
    const browser = new CdpBrowserAdapter(mcp);
    const baseUrl = url ?? process.env.TARGET_DEV_URL ?? 'http://localhost:3000';
    const session = new WatchSession(browser, baseUrl);
    const { findings, newConsole, newNetwork } = await session.poll();

    const critical = findings.filter(f => f.severity === 'critical');
    const warnings  = findings.filter(f => f.severity === 'warning');

    let summary;
    if (critical.length === 0 && warnings.length === 0) {
      summary = `No issues detected on ${baseUrl} — console and network are clean.`;
    } else if (critical.length > 0) {
      summary = `${critical.length} critical issue${critical.length > 1 ? 's' : ''} + ${warnings.length} warning${warnings.length !== 1 ? 's' : ''} detected on ${baseUrl}. Focus on critical issues first.`;
    } else {
      summary = `${warnings.length} warning${warnings.length !== 1 ? 's' : ''} detected on ${baseUrl}. No critical errors.`;
    }

    const context = {
      summary,
      url:              baseUrl,
      timestamp:        new Date().toISOString(),
      critical_issues:  critical,
      warnings,
      js_errors:        findings.filter(f => f.type === 'js-error' || f.type === 'unhandled-rejection'),
      network_failures: findings.filter(f => f.type === 'network-error' || f.type === 'cors-error' || f.type === 'auth-error'),
      console_errors:   newConsole.filter(m => m.level === 'error' || m.level === 'warning'),
      recent_requests:  newNetwork.slice(-20),
    };

    return { content: [{ type: 'text', text: JSON.stringify(context, null, 2) }] };
  });
}

async function handleLastReport() {
  if (!fs.existsSync(REPORTS_DIR)) {
    return { content: [{ type: 'text', text: '{"error":"No reports found in reports/"}' }] };
  }
  const files = fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    return { content: [{ type: 'text', text: '{"error":"No reports found in reports/"}' }] };
  }
  const latest = files
    .map(f => ({ f, mt: fs.statSync(path.join(REPORTS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mt - a.mt)[0].f;
  const json = fs.readFileSync(path.join(REPORTS_DIR, latest), 'utf8');
  return { content: [{ type: 'text', text: json }] };
}

// ── Server bootstrap ──────────────────────────────────────────────────────────

const server = new Server(
  { name: 'argus', version: '9.2.9' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    switch (req.params.name) {
      case 'argus_audit':       return await handleAudit(req.params.arguments ?? {});
      case 'argus_audit_full':  return await handleAuditFull(req.params.arguments ?? {});
      case 'argus_compare':     return await handleCompare();
      case 'argus_last_report':     return await handleLastReport();
      case 'argus_watch_snapshot':  return await handleWatchSnapshot(req.params.arguments ?? {});
      case 'argus_get_context':     return await handleGetContext(req.params.arguments ?? {});
      default: throw new Error(`Unknown tool: ${req.params.name}`);
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
