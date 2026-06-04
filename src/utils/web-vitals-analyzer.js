/**
 * ARGUS Web Vitals Analyzer (Sprint 9 — Advanced Performance Metrics)
 *
 * Captures Core Web Vitals and performance metrics directly via the browser
 * Performance API. Unlike Lighthouse, this works in headless Chrome — metrics
 * are always available in CI without requiring a non-headless browser.
 *
 * Metrics captured:
 *   LCP  — Largest Contentful Paint (PerformanceObserver, buffered)
 *   CLS  — Cumulative Layout Shift   (PerformanceObserver, buffered)
 *   FCP  — First Contentful Paint    (getEntriesByType('paint'))
 *   TTI  — Time to Interactive       (NavigationTiming.domInteractive)
 *   TTFB — Time to First Byte        (NavigationTiming.responseStart)
 *
 * Bundle / resource monitoring:
 *   perf_bundle_large     — JS file > 500 KB (warning) or > 2 MB (critical)
 *   perf_bundle_large_css — CSS file > 150 KB (warning)
 *
 * Findings emitted:
 *   perf_lcp           — warning ≥2500ms, critical ≥4000ms
 *   perf_cls           — warning ≥0.1,    critical ≥0.25
 *   perf_fcp           — warning ≥1800ms, critical ≥3000ms
 *   perf_tti           — warning ≥3500ms, critical ≥7300ms
 *   perf_bundle_large  — warning / critical per JS/CSS size thresholds
 *   perf_vitals_summary — info, always emitted when analysis runs
 */

import { registerExpensive } from '../registry.js';
import { unwrapEval }        from './mcp-client.js';
import { childLogger }       from './logger.js';
import { thresholds }        from '../config/targets.js';

const logger = childLogger('web-vitals');

// ── Thresholds ────────────────────────────────────────────────────────────────
// Core Web Vitals "Needs Improvement" / "Poor" boundaries (Google 2024)
const LCP_WARN  = thresholds.perf?.LCP  ?? 2500; // ms
const LCP_CRIT  = 4000;                           // ms
const CLS_WARN  = thresholds.perf?.CLS  ?? 0.1;
const CLS_CRIT  = 0.25;
const FCP_WARN  = 1800;  // ms
const FCP_CRIT  = 3000;  // ms
const TTI_WARN  = 3500;  // ms  (domInteractive)
const TTI_CRIT  = 7300;  // ms

const JS_WARN_BYTES  = 500  * 1024; // 500 KB
const JS_CRIT_BYTES  = 2000 * 1024; // 2 MB
const CSS_WARN_BYTES = 150  * 1024; // 150 KB

// ── In-browser measurement script ────────────────────────────────────────────
// Async — awaits PerformanceObserver callbacks for LCP/CLS (buffered entries
// are delivered synchronously on observe(), so the setTimeout fallbacks are
// safety nets only).
const VITALS_SCRIPT = `async () => {
  var result = {
    lcp: null, cls: null, fcp: null,
    tti: null, ttfb: null, domComplete: null,
    resources: [],
  };

  // ── Navigation Timing ───────────────────────────────────────────────────────
  var navEntries = performance.getEntriesByType('navigation');
  if (navEntries.length > 0) {
    var nav = navEntries[0];
    result.ttfb        = Math.round(nav.responseStart);
    result.tti         = Math.round(nav.domInteractive);
    result.domComplete = Math.round(nav.domComplete);
  }

  // ── FCP (synchronous — available in paint entries buffer) ──────────────────
  var paintEntries = performance.getEntriesByType('paint');
  for (var i = 0; i < paintEntries.length; i++) {
    if (paintEntries[i].name === 'first-contentful-paint') {
      result.fcp = Math.round(paintEntries[i].startTime);
      break;
    }
  }

  // ── LCP (PerformanceObserver with buffered:true) ───────────────────────────
  await new Promise(function(resolve) {
    try {
      var lcpObs = new PerformanceObserver(function(list) {
        var entries = list.getEntries();
        if (entries.length > 0) {
          result.lcp = Math.round(entries[entries.length - 1].startTime);
        }
        lcpObs.disconnect();
        resolve();
      });
      lcpObs.observe({ type: 'largest-contentful-paint', buffered: true });
      setTimeout(resolve, 150); // fallback if no LCP entries
    } catch (e) { resolve(); }
  });

  // ── CLS (PerformanceObserver with buffered:true) ───────────────────────────
  var clsScore = 0;
  await new Promise(function(resolve) {
    try {
      var clsObs = new PerformanceObserver(function(list) {
        var entries = list.getEntries();
        for (var j = 0; j < entries.length; j++) {
          if (!entries[j].hadRecentInput) clsScore += entries[j].value;
        }
        clsObs.disconnect();
        resolve();
      });
      clsObs.observe({ type: 'layout-shift', buffered: true });
      setTimeout(resolve, 150);
    } catch (e) { resolve(); }
  });
  result.cls = Math.round(clsScore * 1000) / 1000;

  // ── Resource Timing — JS / CSS bundles ────────────────────────────────────
  var pageOrigin;
  try { pageOrigin = new URL(window.location.href).origin; } catch (e) { pageOrigin = ''; }
  var resEntries = performance.getEntriesByType('resource');
  for (var k = 0; k < resEntries.length; k++) {
    var r = resEntries[k];
    if (!r.name) continue;
    var pathname = r.name.split('?')[0];
    var ext = pathname.split('.').pop().toLowerCase();
    if (ext !== 'js' && ext !== 'css') continue;
    var size = r.transferSize || r.encodedBodySize || 0;
    if (size === 0) continue; // cached or CORS opaque — skip
    var isThirdParty = false;
    try { isThirdParty = new URL(r.name).origin !== pageOrigin; } catch (e) {}
    result.resources.push({
      url: r.name,
      ext: ext,
      sizeBytes: size,
      durationMs: Math.round(r.duration),
      isThirdParty: isThirdParty,
    });
  }

  return JSON.stringify(result);
}`;

// ── JSON parse helper ─────────────────────────────────────────────────────────
function parseJson(raw) {
  try {
    const str = unwrapEval(raw);
    if (typeof str === 'object' && str !== null) return str;
    return JSON.parse(str);
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Capture Web Vitals and performance metrics for a single page.
 *
 * Navigates fresh so timing data starts from scratch on each run.
 *
 * @param {object} browser  - CdpBrowserAdapter
 * @param {string} url      - Fully-qualified URL to analyse
 * @returns {Promise<object[]>} Array of performance finding objects
 */
export async function analyzeWebVitals(browser, url) {
  const findings = [];

  // Navigate fresh — timing APIs measure from navigation start
  try {
    await browser.navigate(url);
    await browser.waitFor({ state: 'networkidle' }).catch(() => {});
    // Let PerformanceObserver callbacks settle after networkidle
    await new Promise(r => setTimeout(r, 1200));
  } catch {
    return findings;
  }

  let data;
  try {
    const raw = await browser.evaluate(VITALS_SCRIPT);
    data = parseJson(raw);
  } catch (err) {
    logger.warn(`[ARGUS] web-vitals: measurement script failed for ${url}: ${err.message}`);
    return findings;
  }
  if (!data) return findings;

  const { lcp, cls, fcp, tti, ttfb, resources = [] } = data;

  // ── LCP ───────────────────────────────────────────────────────────────────
  if (lcp !== null) {
    const sev = lcp >= LCP_CRIT ? 'critical' : lcp >= LCP_WARN ? 'warning' : 'info';
    if (sev !== 'info') {
      findings.push({
        type: 'perf_lcp', value: lcp, threshold: LCP_WARN,
        message: `LCP ${lcp}ms — threshold ${LCP_WARN}ms (warning) / ${LCP_CRIT}ms (critical)`,
        severity: sev, url,
      });
    }
  }

  // ── CLS ───────────────────────────────────────────────────────────────────
  if (cls !== null && cls >= CLS_WARN) {
    const sev = cls >= CLS_CRIT ? 'critical' : 'warning';
    findings.push({
      type: 'perf_cls', value: cls, threshold: CLS_WARN,
      message: `CLS ${cls} — threshold ${CLS_WARN} (warning) / ${CLS_CRIT} (critical)`,
      severity: sev, url,
    });
  }

  // ── FCP ───────────────────────────────────────────────────────────────────
  if (fcp !== null && fcp >= FCP_WARN) {
    const sev = fcp >= FCP_CRIT ? 'critical' : 'warning';
    findings.push({
      type: 'perf_fcp', value: fcp, threshold: FCP_WARN,
      message: `FCP ${fcp}ms — threshold ${FCP_WARN}ms (warning) / ${FCP_CRIT}ms (critical)`,
      severity: sev, url,
    });
  }

  // ── TTI ───────────────────────────────────────────────────────────────────
  if (tti !== null && tti >= TTI_WARN) {
    const sev = tti >= TTI_CRIT ? 'critical' : 'warning';
    findings.push({
      type: 'perf_tti', value: tti, threshold: TTI_WARN,
      message: `TTI (domInteractive) ${tti}ms — threshold ${TTI_WARN}ms (warning) / ${TTI_CRIT}ms (critical)`,
      severity: sev, url,
    });
  }

  // ── Bundle sizes ──────────────────────────────────────────────────────────
  for (const r of resources) {
    const kb = Math.round(r.sizeBytes / 1024);
    if (r.ext === 'js') {
      if (r.sizeBytes >= JS_WARN_BYTES) {
        const sev = r.sizeBytes >= JS_CRIT_BYTES ? 'critical' : 'warning';
        findings.push({
          type: 'perf_bundle_large', ext: 'js', sizeKb: kb,
          resourceUrl: r.url, durationMs: r.durationMs, isThirdParty: r.isThirdParty,
          message: `JS bundle ${kb}KB — threshold ${JS_WARN_BYTES / 1024}KB (warning) / ${JS_CRIT_BYTES / 1024}KB (critical): ${r.url}`,
          severity: sev, url,
        });
      }
    } else if (r.ext === 'css' && r.sizeBytes >= CSS_WARN_BYTES) {
      findings.push({
        type: 'perf_bundle_large', ext: 'css', sizeKb: kb,
        resourceUrl: r.url, durationMs: r.durationMs, isThirdParty: r.isThirdParty,
        message: `CSS bundle ${kb}KB — threshold ${CSS_WARN_BYTES / 1024}KB (warning): ${r.url}`,
        severity: 'warning', url,
      });
    }
  }

  // ── Summary — always emitted ──────────────────────────────────────────────
  findings.push({
    type:          'perf_vitals_summary',
    lcp:           lcp ?? null,
    cls:           cls ?? null,
    fcp:           fcp ?? null,
    tti:           tti ?? null,
    ttfb:          ttfb ?? null,
    bundleCount:   resources.length,
    message: `Web Vitals: LCP=${lcp ?? 'N/A'}ms CLS=${cls ?? 'N/A'} FCP=${fcp ?? 'N/A'}ms TTI=${tti ?? 'N/A'}ms TTFB=${ttfb ?? 'N/A'}ms`,
    severity:      'info',
    url,
  });

  return findings;
}

// ── Self-registration ─────────────────────────────────────────────────────────
registerExpensive({
  name: 'web-vitals',
  analyze: (browser, url) => analyzeWebVitals(browser, url),
});
