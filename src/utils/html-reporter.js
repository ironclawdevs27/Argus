#!/usr/bin/env node
/**
 * ARGUS HTML Report Generator — D7.1
 *
 * Converts the latest (or a specified) JSON report into a single self-contained
 * report.html with screenshots inlined as base64 data URIs.  No external
 * dependencies — the output file opens correctly offline.
 *
 * Usage:
 *   node src/utils/html-reporter.js                  # auto-picks latest report
 *   node src/utils/html-reporter.js path/to/report.json
 *   npm run report:html
 *
 * Output: <reports-dir>/report.html  (overwrites on each run)
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.resolve(__dirname, '../../reports');

// ── Severity helpers ──────────────────────────────────────────────────────────

const SEV_COLOR = {
  critical: { bg: '#fef2f2', border: '#fca5a5', text: '#991b1b', badge: '#dc2626', label: 'CRITICAL' },
  warning:  { bg: '#fffbeb', border: '#fcd34d', text: '#92400e', badge: '#d97706', label: 'WARNING'  },
  info:     { bg: '#eff6ff', border: '#93c5fd', text: '#1e40af', badge: '#2563eb', label: 'INFO'     },
};

function sevStyle(sev) {
  const c = SEV_COLOR[sev] ?? SEV_COLOR.info;
  return `background:${c.bg};border-left:4px solid ${c.border};color:${c.text}`;
}

function sevBadge(sev) {
  const c = SEV_COLOR[sev] ?? SEV_COLOR.info;
  return `<span style="background:${c.badge};color:#fff;border-radius:3px;font-size:11px;font-weight:700;padding:2px 7px;letter-spacing:.5px;white-space:nowrap">${c.label}</span>`;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Screenshot embedding ──────────────────────────────────────────────────────

function imgTag(filePath, alt = 'Screenshot', style = '') {
  if (!filePath) return '';
  try {
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(filePath).slice(1).toLowerCase() || 'png';
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
    return `<img src="data:${mime};base64,${buf.toString('base64')}" alt="${esc(alt)}" style="max-width:100%;border-radius:6px;border:1px solid #e5e7eb;${style}">`;
  } catch {
    return `<p style="color:#6b7280;font-size:13px">Screenshot not found: ${esc(path.basename(filePath))}</p>`;
  }
}

// ── Finding renderer ──────────────────────────────────────────────────────────

function renderFinding(e) {
  const sev  = e.severity ?? 'info';
  const type = esc(e.type ?? 'unknown');
  const msg  = esc(e.message ?? e.description ?? (e.requestUrl ? `HTTP ${e.status ?? '?'} ${e.requestUrl}` : ''));
  const flaky = e.flaky ? ' <span style="color:#6b7280;font-size:11px">⚡ flaky</span>' : '';
  const isNew = e.isNew  ? ' <span style="color:#059669;font-size:11px">★ new</span>'  : '';
  return `
    <div style="${sevStyle(sev)};padding:10px 14px;margin:6px 0;border-radius:0 4px 4px 0;font-size:13px;line-height:1.5">
      <div style="display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap">
        ${sevBadge(sev)}
        <code style="background:rgba(0,0,0,.06);border-radius:3px;padding:1px 6px;font-size:12px;white-space:nowrap">${type}</code>
        ${flaky}${isNew}
      </div>
      <div style="margin-top:6px;word-break:break-word">${msg}</div>
      ${e.requestUrl ? `<div style="margin-top:3px;font-size:11px;opacity:.8">URL: ${esc(e.requestUrl)}</div>` : ''}
    </div>`;
}

// ── Route card ────────────────────────────────────────────────────────────────

function renderRoute(route) {
  const errors    = route.errors ?? [];
  const criticals = errors.filter(e => e.severity === 'critical');
  const warnings  = errors.filter(e => e.severity === 'warning');
  const infos     = errors.filter(e => e.severity === 'info');

  const headerColor = criticals.length > 0 ? '#dc2626'
    : warnings.length  > 0 ? '#d97706'
    : '#16a34a';
  const headerBg = criticals.length > 0 ? '#fef2f2'
    : warnings.length  > 0 ? '#fffbeb'
    : '#f0fdf4';

  // Summary pill row
  const pills = [
    criticals.length > 0 ? `<span style="background:#dc2626;color:#fff;border-radius:12px;padding:2px 10px;font-size:12px;font-weight:600">${criticals.length} critical</span>` : '',
    warnings.length  > 0 ? `<span style="background:#d97706;color:#fff;border-radius:12px;padding:2px 10px;font-size:12px;font-weight:600">${warnings.length} warning</span>`  : '',
    infos.length     > 0 ? `<span style="background:#2563eb;color:#fff;border-radius:12px;padding:2px 10px;font-size:12px;font-weight:600">${infos.length} info</span>`         : '',
    errors.length   === 0 ? `<span style="background:#16a34a;color:#fff;border-radius:12px;padding:2px 10px;font-size:12px;font-weight:600">✓ clean</span>`                      : '',
  ].filter(Boolean).join(' ');

  // Screenshot
  const shot = imgTag(route.screenshot, `${route.route} screenshot`);

  // Responsive screenshots grid
  let responsiveGrid = '';
  if (route.responsiveScreenshots && Object.keys(route.responsiveScreenshots).length > 0) {
    const viewports = Object.entries(route.responsiveScreenshots)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([vp, fp]) => `
        <div style="text-align:center">
          <div style="font-size:11px;color:#6b7280;margin-bottom:4px">${vp}px</div>
          ${imgTag(fp, `${route.route} at ${vp}px`, 'width:100%')}
        </div>`).join('');
    responsiveGrid = `
      <div style="margin-top:16px">
        <h4 style="margin:0 0 8px;font-size:13px;color:#374151">Responsive snapshots</h4>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px">${viewports}</div>
      </div>`;
  }

  // Findings list
  const findingRows = errors.length > 0
    ? errors.map(renderFinding).join('')
    : `<p style="color:#16a34a;margin:8px 0;font-size:13px">✓ No issues detected on this route.</p>`;

  return `
  <div style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:24px;box-shadow:0 1px 3px rgba(0,0,0,.06)">
    <!-- route header -->
    <div style="background:${headerBg};border-bottom:1px solid #e5e7eb;padding:14px 20px;display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:8px">
      <div>
        <h3 style="margin:0;font-size:16px;color:${headerColor}">${esc(route.route)}</h3>
        <a href="${esc(route.url)}" style="font-size:12px;color:#6b7280;word-break:break-all">${esc(route.url)}</a>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">${pills}</div>
    </div>
    <!-- route body -->
    <div style="padding:16px 20px">
      ${shot ? `<div style="margin-bottom:16px">${shot}</div>` : ''}
      ${responsiveGrid}
      <div style="margin-top:${shot || responsiveGrid ? '16px' : '0'}">
        <h4 style="margin:0 0 8px;font-size:13px;color:#374151">Findings</h4>
        ${findingRows}
      </div>
    </div>
  </div>`;
}

// ── Flow card ─────────────────────────────────────────────────────────────────

function renderFlow(flow) {
  const status   = flow.status ?? 'unknown';
  const findings = flow.findings ?? [];
  const statusColor = status === 'pass' ? '#16a34a' : '#dc2626';
  const findingRows = findings.length > 0
    ? findings.map(renderFinding).join('')
    : '<p style="color:#16a34a;margin:8px 0;font-size:13px">✓ All assertions passed.</p>';

  return `
  <div style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:16px">
    <div style="background:#f9fafb;border-bottom:1px solid #e5e7eb;padding:12px 20px;display:flex;align-items:center;justify-content:space-between">
      <span style="font-weight:600;font-size:15px">${esc(flow.flowName ?? flow.name ?? 'Flow')}</span>
      <span style="font-size:13px;font-weight:600;color:${statusColor}">${status.toUpperCase()} (${flow.stepsCompleted ?? '?'}/${flow.totalSteps ?? '?'} steps)</span>
    </div>
    <div style="padding:14px 20px">${findingRows}</div>
  </div>`;
}

// ── Full HTML document ────────────────────────────────────────────────────────

function buildHtml(report) {
  const { generatedAt, baseUrl, summary, routes = [], flows = [] } = report;
  const runDate = new Date(generatedAt).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' });

  const totalBg = summary.critical > 0 ? '#dc2626' : summary.warning > 0 ? '#d97706' : '#16a34a';

  const summaryCards = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:14px;margin-bottom:32px">
      ${[
        ['Total',    summary.total    ?? 0, '#374151', '#f3f4f6'],
        ['Critical', summary.critical ?? 0, '#991b1b', '#fef2f2'],
        ['Warning',  summary.warning  ?? 0, '#92400e', '#fffbeb'],
        ['Info',     summary.info     ?? 0, '#1e40af', '#eff6ff'],
      ].map(([label, count, color, bg]) => `
        <div style="background:${bg};border:1px solid #e5e7eb;border-radius:8px;padding:18px;text-align:center">
          <div style="font-size:32px;font-weight:700;color:${color}">${count}</div>
          <div style="font-size:12px;color:#6b7280;margin-top:4px;text-transform:uppercase;letter-spacing:.5px">${label}</div>
        </div>`).join('')}
    </div>`;

  const routeSections = routes.map(renderRoute).join('');

  const flowSection = flows.length > 0 ? `
    <h2 style="font-size:18px;color:#111827;border-bottom:2px solid #e5e7eb;padding-bottom:8px;margin:32px 0 16px">User Flows (${flows.length})</h2>
    ${flows.map(renderFlow).join('')}` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Argus Report — ${esc(runDate)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f9fafb; color: #111827; }
    a { color: inherit; }
  </style>
</head>
<body>
  <!-- top bar -->
  <div style="background:${totalBg};padding:14px 32px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
    <span style="color:#fff;font-weight:700;font-size:20px;letter-spacing:-.3px">🛡 Argus Report</span>
    <span style="color:rgba(255,255,255,.85);font-size:13px">${esc(runDate)} · ${esc(baseUrl)}</span>
  </div>

  <div style="max-width:1100px;margin:0 auto;padding:32px 24px">
    ${summaryCards}

    <h2 style="font-size:18px;color:#111827;border-bottom:2px solid #e5e7eb;padding-bottom:8px;margin:0 0 16px">Routes (${routes.length})</h2>
    ${routeSections}

    ${flowSection}

    <p style="text-align:center;font-size:12px;color:#9ca3af;margin-top:32px">Generated by <strong>Argus</strong> · ${esc(generatedAt)}</p>
  </div>
</body>
</html>`;
}

// ── CLI entry ─────────────────────────────────────────────────────────────────

function findLatestReport(dir) {
  if (!fs.existsSync(dir)) {
    throw new Error(`Reports directory not found: ${dir}\nRun "npm run crawl" first to generate a report.`);
  }
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith('error-report-') && f.endsWith('.json'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length === 0) {
    throw new Error(`No error-report-*.json files found in ${dir}\nRun "npm run crawl" first.`);
  }
  return path.join(dir, files[0].name);
}

(function main() {
  const arg        = process.argv[2];
  const reportPath = arg ? path.resolve(arg) : findLatestReport(REPORTS_DIR);

  if (!fs.existsSync(reportPath)) {
    console.error(`Error: report not found — ${reportPath}`);
    process.exit(1);
  }

  const report  = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const html    = buildHtml(report);
  const outPath = path.join(path.dirname(reportPath), 'report.html');

  fs.writeFileSync(outPath, html, 'utf8');

  const kb = Math.round(Buffer.byteLength(html, 'utf8') / 1024);
  console.log(`[ARGUS] HTML report written: ${outPath} (${kb} KB)`);
  console.log(`[ARGUS] Source report: ${reportPath}`);
})();
