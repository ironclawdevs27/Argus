#!/usr/bin/env node
/**
 * ARGUS HTML Report Generator — D7.1
 *
 * Converts the latest (or a specified) JSON report into a single self-contained
 * report.html with screenshots inlined as base64 data URIs. Styled to match the
 * Argus brand (argus-qa.com): #5E0ED7 accent, ring+dot logo, Inter / JetBrains
 * Mono type. Fonts load from Google Fonts when online and fall back to a system
 * stack offline, so the report still renders cleanly with no network — the only
 * hard requirement (inlined screenshots) is met regardless.
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
import { childLogger } from './logger.js';
import { redactReport } from './sensitivity-classifier.js';

const logger = childLogger('html-reporter');

/**
 * Aegis (Step 7): decide whether an HTML report crosses the trust boundary and must be
 * redacted. The default LOCALLY-opened report keeps 100% fidelity; a hosted/shared report
 * (CI artifact, shared link) is projected through redactForEgress. Precedence:
 *   ARGUS_REDACT_SENSITIVE=0 → never (global opt-out) · opts.external → always ·
 *   ARGUS_REDACT_HTML=1 → always · ARGUS_REDACT_HTML=0 → never · else default ON under CI.
 * @param {{ external?: boolean }} [opts]
 * @returns {boolean}
 */
function shouldRedactHtml(opts = {}) {
  if (process.env.ARGUS_REDACT_SENSITIVE === '0') return false;
  if (opts.external === true) return true;
  if (process.env.ARGUS_REDACT_HTML === '1') return true;
  if (process.env.ARGUS_REDACT_HTML === '0') return false;
  return process.env.CI === 'true' || process.env.CI === '1';
}

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.resolve(__dirname, '../../reports');

// ── Brand ───────────────────────────────────────────────────────────────────
const ACCENT = '#5E0ED7';

// ── Severity helpers ──────────────────────────────────────────────────────────

const SEV = {
  critical: { cls: 'critical', label: 'CRITICAL' },
  warning:  { cls: 'warning',  label: 'WARNING'  },
  info:     { cls: 'info',     label: 'INFO'     },
};

function sevOf(sev) {
  return SEV[sev] ? sev : 'info';
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeHref(url) {
  const s = String(url ?? '');
  return /^https?:\/\//i.test(s) ? esc(s) : '#';
}

// ── Logo (ring + dot — replicates landing/public/favicon.svg) ──────────────────

function logoSvg(size = 34, ring = '#7b3fe4', dot = '#9b6cf2') {
  return `<svg class="logo" viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true">
    <circle cx="16" cy="16" r="14" fill="none" stroke="${ring}" stroke-width="2.5"/>
    <circle cx="16" cy="16" r="5" fill="${dot}"/>
  </svg>`;
}

// ── Screenshot embedding ──────────────────────────────────────────────────────

function imgTag(filePath, alt = 'Screenshot', style = '') {
  if (!filePath) return '';
  try {
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(filePath).slice(1).toLowerCase() || 'png';
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
    return `<img class="shot" src="data:${mime};base64,${buf.toString('base64')}" alt="${esc(alt)}" style="${style}">`;
  } catch {
    return `<p class="shot-missing">Screenshot not found: ${esc(path.basename(filePath))}</p>`;
  }
}

// ── Finding renderer ──────────────────────────────────────────────────────────

function renderFinding(e) {
  const sev  = sevOf(e.severity);
  const type = esc(e.type ?? 'unknown');
  const msg  = esc(e.message ?? e.description ?? (e.requestUrl ? `HTTP ${e.status ?? '?'} ${e.requestUrl}` : ''));
  const flaky = e.flaky ? ' <span class="tag tag-flaky">⚡ flaky</span>' : '';
  const isNew = e.isNew  ? ' <span class="tag tag-new">★ new</span>'    : '';
  return `
    <div class="finding ${sev}">
      <div class="finding-head">
        <span class="chip ${sev}">${SEV[sev].label}</span>
        <code class="type">${type}</code>
        ${flaky}${isNew}
      </div>
      <div class="finding-msg">${msg}</div>
      ${e.requestUrl ? `<div class="finding-url">${esc(e.requestUrl)}</div>` : ''}
    </div>`;
}

// ── Route card ────────────────────────────────────────────────────────────────

function renderRoute(route) {
  const errors    = route.errors ?? [];
  const criticals = errors.filter(e => e.severity === 'critical');
  const warnings  = errors.filter(e => e.severity === 'warning');
  const infos     = errors.filter(e => e.severity === 'info');

  const state = criticals.length > 0 ? 'critical'
    : warnings.length > 0 ? 'warning'
    : 'ok';

  // Summary pill row
  const pills = [
    criticals.length > 0 ? `<span class="pill critical">${criticals.length} critical</span>` : '',
    warnings.length  > 0 ? `<span class="pill warning">${warnings.length} warning</span>`   : '',
    infos.length     > 0 ? `<span class="pill info">${infos.length} info</span>`            : '',
    errors.length   === 0 ? `<span class="pill ok">✓ clean</span>`                          : '',
  ].filter(Boolean).join(' ');

  // Screenshot
  const shot = imgTag(route.screenshot, `${route.route} screenshot`);

  // Responsive screenshots grid
  let responsiveGrid = '';
  if (route.responsiveScreenshots && Object.keys(route.responsiveScreenshots).length > 0) {
    const viewports = Object.entries(route.responsiveScreenshots)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([vp, fp]) => `
        <figure class="vp">
          <figcaption>${esc(String(vp))}px</figcaption>
          ${imgTag(fp, `${route.route} at ${vp}px`, 'width:100%')}
        </figure>`).join('');
    responsiveGrid = `
      <div class="route-block">
        <h4 class="block-title">Responsive snapshots</h4>
        <div class="vp-grid">${viewports}</div>
      </div>`;
  }

  // Findings list
  const findingRows = errors.length > 0
    ? errors.map(renderFinding).join('')
    : `<p class="all-clear">✓ No issues detected on this route.</p>`;

  return `
  <article class="route ${state}">
    <header class="route-head">
      <div class="route-id">
        <span class="dot ${state}"></span>
        <div>
          <h3 class="route-name">${esc(route.route)}</h3>
          <a class="route-url" href="${safeHref(route.url)}">${esc(route.url)}</a>
        </div>
      </div>
      <div class="pills">${pills}</div>
    </header>
    <div class="route-body">
      ${shot ? `<div class="route-block">${shot}</div>` : ''}
      ${responsiveGrid}
      <div class="route-block">
        <h4 class="block-title">Findings</h4>
        ${findingRows}
      </div>
    </div>
  </article>`;
}

// ── Flow card ─────────────────────────────────────────────────────────────────

function renderFlow(flow) {
  const status   = flow.status ?? 'unknown';
  const findings = flow.findings ?? [];
  const pass     = status === 'pass';
  const findingRows = findings.length > 0
    ? findings.map(renderFinding).join('')
    : '<p class="all-clear">✓ All assertions passed.</p>';

  return `
  <article class="route ${pass ? 'ok' : 'critical'}">
    <header class="route-head">
      <div class="route-id">
        <span class="dot ${pass ? 'ok' : 'critical'}"></span>
        <h3 class="route-name">${esc(flow.flowName ?? flow.name ?? 'Flow')}</h3>
      </div>
      <span class="pill ${pass ? 'ok' : 'critical'}">${esc(status.toUpperCase())} · ${flow.stepsCompleted ?? '?'}/${flow.totalSteps ?? '?'} steps</span>
    </header>
    <div class="route-body"><div class="route-block">${findingRows}</div></div>
  </article>`;
}

// ── Full HTML document ────────────────────────────────────────────────────────

function buildHtml(report) {
  const { generatedAt, baseUrl, summary, routes = [], flows = [] } = report;
  const runDate = new Date(generatedAt).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' });

  const crit = summary.critical ?? 0;
  const warn = summary.warning  ?? 0;
  const info = summary.info     ?? 0;
  const total = summary.total ?? (crit + warn + info);

  // Overall verdict
  const verdict = crit > 0
    ? { cls: 'critical', icon: '✕', title: `${crit} critical issue${crit === 1 ? '' : 's'} need${crit === 1 ? 's' : ''} attention`,
        sub: `${warn} warning${warn === 1 ? '' : 's'} · ${info} info · ${routes.length} route${routes.length === 1 ? '' : 's'} audited` }
    : warn > 0
    ? { cls: 'warning', icon: '!', title: `${warn} warning${warn === 1 ? '' : 's'} to review`,
        sub: `0 critical · ${info} info · ${routes.length} route${routes.length === 1 ? '' : 's'} audited` }
    : { cls: 'ok', icon: '✓', title: 'All clear — no issues detected',
        sub: `${routes.length} route${routes.length === 1 ? '' : 's'} audited · clean run` };

  const cards = [
    { k: 'total',    n: total, label: 'Total' },
    { k: 'critical', n: crit,  label: 'Critical' },
    { k: 'warning',  n: warn,  label: 'Warning' },
    { k: 'info',     n: info,  label: 'Info' },
  ].map(c => `
        <div class="card ${c.k}">
          <div class="num">${c.n}</div>
          <div class="lbl">${c.label}</div>
        </div>`).join('');

  const routeSections = routes.map(renderRoute).join('');

  const flowSection = flows.length > 0 ? `
    <h2 class="section">User Flows <span class="count">${flows.length}</span></h2>
    ${flows.map(renderFlow).join('')}` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Argus Report — ${esc(runDate)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --accent:#5E0ED7; --accent-soft:#9b6cf2; --ink:#0d0d0d;
      --bg:#f6f4fc; --card:#ffffff; --border:#ece8f7; --border-strong:#ddd5f1;
      --text:#1b1726; --muted:#6c6580;
      --crit:#dc2626; --crit-bg:#fef2f3; --crit-bd:#f4cdcd;
      --warn:#d97706; --warn-bg:#fffaeb; --warn-bd:#f3e0a8;
      --info:#2563eb; --info-bg:#eef4ff; --info-bd:#cadcfb;
      --ok:#15a34a;   --ok-bg:#eefcf3;   --ok-bd:#bce8cc;
    }
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0; color: var(--text);
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background:
        radial-gradient(1200px 480px at 100% -8%, rgba(94,14,215,.07), transparent 60%),
        radial-gradient(900px 420px at -10% 0%, rgba(94,14,215,.05), transparent 55%),
        var(--bg);
      -webkit-font-smoothing: antialiased;
    }
    a { color: inherit; text-decoration: none; }
    code, .mono { font-family: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace; }

    /* top accent line + branded header */
    .accent-line { height: 4px; background: linear-gradient(90deg, var(--accent), var(--accent-soft) 55%, #cbb4f7); }
    .topbar {
      position: relative; overflow: hidden; background: var(--ink); color: #fff;
      padding: 22px 32px; display: flex; align-items: center; justify-content: space-between;
      gap: 14px; flex-wrap: wrap;
    }
    .topbar::before { content:''; position:absolute; inset:0;
      background: radial-gradient(130% 200% at 0% 0%, rgba(94,14,215,.55), transparent 52%); }
    .topbar > * { position: relative; z-index: 1; }
    .brand { display: flex; align-items: center; gap: 13px; }
    .brand .logo-wrap { display:grid; place-items:center; width:46px; height:46px; border-radius:13px;
      background: rgba(94,14,215,.16); border: 1px solid rgba(155,108,242,.35); }
    .brand .name { font-size: 21px; font-weight: 800; letter-spacing: -.4px; line-height: 1; }
    .brand .name .dim { color: rgba(255,255,255,.5); font-weight: 600; margin-left: 2px; }
    .brand .tagline { font-size: 11.5px; color: rgba(255,255,255,.45); margin-top: 4px; letter-spacing: .2px; }
    .meta { text-align: right; font-size: 12.5px; color: rgba(255,255,255,.72); line-height: 1.7; }
    .meta .meta-url { color: var(--accent-soft); }

    .wrap { max-width: 1080px; margin: 0 auto; padding: 30px 24px 56px; }

    /* verdict banner */
    .verdict { display: flex; align-items: center; gap: 16px; padding: 18px 22px;
      border: 1px solid var(--border); border-radius: 18px; margin-bottom: 24px; background: var(--card);
      box-shadow: 0 1px 2px rgba(13,13,13,.04), 0 20px 40px -28px rgba(94,14,215,.28); }
    .verdict .v-icon { flex: 0 0 auto; width: 46px; height: 46px; border-radius: 14px; display: grid;
      place-items: center; font-size: 22px; font-weight: 800; color: #fff; }
    .verdict.ok       { border-color: var(--ok-bd); }
    .verdict.warning  { border-color: var(--warn-bd); }
    .verdict.critical { border-color: var(--crit-bd); }
    .verdict.ok       .v-icon { background: var(--ok); }
    .verdict.warning  .v-icon { background: var(--warn); }
    .verdict.critical .v-icon { background: var(--crit); }
    .verdict .v-title { font-weight: 700; font-size: 17px; letter-spacing: -.2px; }
    .verdict .v-sub { color: var(--muted); font-size: 13px; margin-top: 3px; }

    /* summary cards */
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 16px; margin-bottom: 34px; }
    .card { position: relative; overflow: hidden; background: var(--card); border: 1px solid var(--border);
      border-radius: 18px; padding: 22px 20px 20px; box-shadow: 0 1px 2px rgba(13,13,13,.04); }
    .card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 4px; }
    .card .num { font-size: 42px; font-weight: 800; letter-spacing: -1.5px; line-height: 1; }
    .card .lbl { margin-top: 8px; font-size: 11.5px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 1px; color: var(--muted); }
    .card.total::before    { background: linear-gradient(90deg, var(--accent), var(--accent-soft)); }
    .card.total .num       { color: var(--accent); }
    .card.critical::before { background: var(--crit); }
    .card.critical .num    { color: var(--crit); }
    .card.warning::before  { background: var(--warn); }
    .card.warning .num     { color: var(--warn); }
    .card.info::before     { background: var(--info); }
    .card.info .num        { color: var(--info); }

    /* section heading */
    .section { display: flex; align-items: center; gap: 10px; font-size: 16px; font-weight: 700;
      letter-spacing: -.2px; margin: 0 0 18px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
    .section::before { content: ''; width: 4px; height: 18px; border-radius: 3px;
      background: linear-gradient(180deg, var(--accent), var(--accent-soft)); }
    .section .count { font-size: 12px; font-weight: 700; color: var(--accent);
      background: rgba(94,14,215,.09); border: 1px solid rgba(94,14,215,.16);
      padding: 2px 9px; border-radius: 999px; }

    /* route card */
    .route { background: var(--card); border: 1px solid var(--border); border-radius: 18px;
      overflow: hidden; margin-bottom: 18px; box-shadow: 0 1px 2px rgba(13,13,13,.04), 0 16px 36px -30px rgba(94,14,215,.35); }
    .route-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
      flex-wrap: wrap; padding: 16px 22px; border-bottom: 1px solid var(--border); }
    .route.ok .route-head       { background: linear-gradient(180deg, var(--ok-bg), transparent); }
    .route.warning .route-head  { background: linear-gradient(180deg, var(--warn-bg), transparent); }
    .route.critical .route-head { background: linear-gradient(180deg, var(--crit-bg), transparent); }
    .route-id { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .dot { flex: 0 0 auto; width: 10px; height: 10px; border-radius: 50%; margin-top: 6px;
      box-shadow: 0 0 0 4px rgba(0,0,0,.04); }
    .dot.ok { background: var(--ok); } .dot.warning { background: var(--warn); } .dot.critical { background: var(--crit); }
    .route-name { margin: 0; font-size: 16px; font-weight: 700; letter-spacing: -.2px;
      font-family: 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace; }
    .route-url { display: inline-block; margin-top: 3px; font-size: 12px; color: var(--muted); word-break: break-all; }
    .route-url:hover { color: var(--accent); }
    .pills { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .route-body { padding: 18px 22px; }
    .route-block + .route-block { margin-top: 18px; }
    .block-title { margin: 0 0 10px; font-size: 11.5px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 1px; color: var(--muted); }

    /* pills + chips */
    .pill { font-size: 12px; font-weight: 600; padding: 3px 11px; border-radius: 999px; white-space: nowrap; }
    .pill.critical { background: var(--crit-bg); color: var(--crit); border: 1px solid var(--crit-bd); }
    .pill.warning  { background: var(--warn-bg); color: var(--warn); border: 1px solid var(--warn-bd); }
    .pill.info     { background: var(--info-bg); color: var(--info); border: 1px solid var(--info-bd); }
    .pill.ok       { background: var(--ok-bg);   color: var(--ok);   border: 1px solid var(--ok-bd); }

    /* findings */
    .finding { border: 1px solid var(--border); border-left-width: 4px; border-radius: 12px;
      padding: 12px 15px; margin: 9px 0; font-size: 13.5px; line-height: 1.55; }
    .finding.critical { background: var(--crit-bg); border-left-color: var(--crit); }
    .finding.warning  { background: var(--warn-bg); border-left-color: var(--warn); }
    .finding.info     { background: var(--info-bg); border-left-color: var(--info); }
    .finding-head { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
    .chip { font-size: 10.5px; font-weight: 700; letter-spacing: .6px; color: #fff;
      padding: 3px 8px; border-radius: 6px; white-space: nowrap; }
    .chip.critical { background: var(--crit); } .chip.warning { background: var(--warn); } .chip.info { background: var(--info); }
    .type { background: rgba(13,13,13,.06); border: 1px solid rgba(13,13,13,.05); border-radius: 6px;
      padding: 2px 7px; font-size: 12px; color: #2a2535; white-space: nowrap; }
    .tag { font-size: 11px; font-weight: 600; }
    .tag-flaky { color: var(--muted); } .tag-new { color: var(--ok); }
    .finding-msg { margin-top: 7px; color: var(--text); word-break: break-word; }
    .finding-url { margin-top: 4px; font-size: 11.5px; color: var(--muted); word-break: break-all; }
    .all-clear { margin: 6px 0; font-size: 13.5px; color: var(--ok); font-weight: 500; }

    /* screenshots */
    .shot { max-width: 100%; border-radius: 12px; border: 1px solid var(--border-strong);
      box-shadow: 0 8px 24px -18px rgba(13,13,13,.4); display: block; }
    .shot-missing { color: var(--muted); font-size: 13px; }
    .vp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
    .vp { margin: 0; text-align: center; }
    .vp figcaption { font-size: 11px; color: var(--muted); margin-bottom: 5px; font-weight: 600; }

    /* footer */
    .foot { display: flex; align-items: center; justify-content: center; gap: 9px; margin-top: 40px;
      color: var(--muted); font-size: 12.5px; }
    .foot a { color: var(--accent); font-weight: 600; }
    .foot .logo { opacity: .85; }

    @media (max-width: 560px) {
      .topbar { padding: 18px 20px; } .wrap { padding: 22px 16px 44px; }
      .meta { text-align: left; }
    }
  </style>
</head>
<body>
  <div class="accent-line"></div>
  <header class="topbar">
    <div class="brand">
      <span class="logo-wrap">${logoSvg(26)}</span>
      <div>
        <div class="name">Argus<span class="dim">Report</span></div>
        <div class="tagline">Automated QA · Chrome DevTools Protocol</div>
      </div>
    </div>
    <div class="meta">
      <div>${esc(runDate)}</div>
      <div class="meta-url">${esc(baseUrl)}</div>
    </div>
  </header>

  <div class="wrap">
    <div class="verdict ${verdict.cls}">
      <div class="v-icon">${verdict.icon}</div>
      <div>
        <div class="v-title">${esc(verdict.title)}</div>
        <div class="v-sub">${esc(verdict.sub)}</div>
      </div>
    </div>

    <div class="cards">${cards}
    </div>

    <h2 class="section">Routes <span class="count">${routes.length}</span></h2>
    ${routeSections}

    ${flowSection}

    <div class="foot">
      ${logoSvg(18, ACCENT, ACCENT)}
      <span>Generated by <strong>Argus</strong> · <a href="https://argus-qa.com">argus-qa.com</a> · ${esc(runDate)}</span>
    </div>
  </div>
</body>
</html>`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Convert a JSON report file into a self-contained HTML file.
 *
 * Reads the JSON at `reportPath`, renders the full HTML dashboard (screenshots
 * inlined as base64), and writes `report.html` alongside the source JSON.
 * Called automatically by crawl-and-report.js when Slack is not configured (D7.7).
 *
 * @param {string} reportPath - Absolute or relative path to the JSON report file
 * @param {{ external?: boolean }} [opts] - external:true forces egress redaction (hosted/shared
 *        report); default keeps full local fidelity unless ARGUS_REDACT_HTML/CI apply (shouldRedactHtml)
 * @returns {string} Absolute path to the written report.html
 */
export function generateHtmlReport(reportPath, opts = {}) {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch (err) {
    throw new Error(`[ARGUS] Failed to parse report JSON at ${reportPath}: ${err.message}`);
  }
  // Aegis egress guard (Step 7): a hosted/shared HTML report is a third-party sink (A2). When this
  // render is external, project the parsed report through redactReport BEFORE buildHtml — the
  // on-disk JSON at reportPath is left untouched (full local fidelity). The locally-opened default
  // render stays raw. fail-CLOSED is honoured via report._aegisFailClosed inside redactReport.
  if (shouldRedactHtml(opts)) report = redactReport(report, { localReportPath: reportPath });
  const html    = buildHtml(report);
  const outPath = path.join(path.dirname(path.resolve(reportPath)), 'report.html');

  fs.writeFileSync(outPath, html, 'utf8');

  const kb = Math.round(Buffer.byteLength(html, 'utf8') / 1024);
  logger.info(`[ARGUS] HTML report written: ${outPath} (${kb} KB)`);
  return outPath;
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

// Only runs when invoked directly (npm run report:html or node src/utils/html-reporter.js)
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const arg        = process.argv[2];
  const reportPath = arg ? path.resolve(arg) : findLatestReport(REPORTS_DIR);

  if (!fs.existsSync(reportPath)) {
    logger.error(`Error: report not found — ${reportPath}`);
    process.exit(1);
  }

  generateHtmlReport(reportPath);
  logger.info(`[ARGUS] Source report: ${reportPath}`);
}
