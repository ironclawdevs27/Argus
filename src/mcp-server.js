#!/usr/bin/env node
/**
 * Argus MCP Server (v9.2.3)
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

const REPORTS_DIR = path.resolve(process.cwd(), 'reports');

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'argus_audit',
    description: 'Run a fast QA audit on a URL. Detects JavaScript errors, unhandled promise rejections, network failures (4xx/5xx), API frequency loops, CSS cascade issues, SEO problems, security vulnerabilities, content quality issues, and accessibility violations. Returns findings as JSON grouped by severity (critical/warning/info).',
    inputSchema: {
      type: 'object',
      properties: {
        url:      { type: 'string',  description: 'Full URL to audit (e.g. http://localhost:3000/checkout)' },
        critical: { type: 'boolean', description: 'Treat this route as critical — console errors become critical severity', default: false },
      },
      required: ['url'],
    },
  },
  {
    name: 'argus_audit_full',
    description: 'Run a deep QA pass on a URL using all analyzers — Lighthouse performance/accessibility scoring, responsive layout checks across mobile/tablet/desktop viewports, memory leak detection via heap snapshot, hover-state bug detection, and accessibility tree snapshot. Returns a full JSON report with findings grouped by severity.',
    inputSchema: {
      type: 'object',
      properties: {
        url:      { type: 'string',  description: 'Full URL to audit (e.g. https://example.com/dashboard)' },
        critical: { type: 'boolean', description: 'Mark this route as critical — console errors are escalated to critical severity', default: false },
      },
      required: ['url'],
    },
  },
  {
    name: 'argus_compare',
    description: 'Snapshot and diff two environments (dev vs staging) side-by-side. Navigates both URLs, captures screenshots, runs the full analyzer suite on each, then diffs the findings to surface regressions — things that appear in staging but not dev, or changed severity. Configure the two target URLs via TARGET_DEV_URL and TARGET_STAGING_URL environment variables before starting the server.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'argus_last_report',
    description: 'Return the most recent Argus JSON report from the reports/ directory.',
    inputSchema: { type: 'object', properties: {} },
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
  { name: 'argus', version: '9.2.5' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    switch (req.params.name) {
      case 'argus_audit':       return await handleAudit(req.params.arguments ?? {});
      case 'argus_audit_full':  return await handleAuditFull(req.params.arguments ?? {});
      case 'argus_compare':     return await handleCompare();
      case 'argus_last_report': return await handleLastReport();
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
