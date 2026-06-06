/**
 * ARGUS Deep Accessibility Analyzer (Sprint 4 — A12)
 *
 * Extends Argus accessibility coverage via two mechanisms:
 *
 * 1. axe-core injection — runs the full axe-core ruleset (80+ rules) against
 *    the live page, covering WCAG 2.x Level A/AA violations not caught by the
 *    existing snapshot-analyzer or keyboard-analyzer.
 *
 * 2. Color blind simulation — transforms page element colors using protanopia
 *    and deuteranopia CVD matrices, then checks WCAG AA contrast ratios under
 *    each simulated palette. Flags elements that look fine to full-color vision
 *    but fail for users with red-green color deficiencies.
 *
 * Findings emitted:
 *   a11y_axe_violation      — axe-core violation; severity mapped from impact
 *                             (critical→critical, serious/moderate→warning, minor→info)
 *   a11y_colorblind_risk    — element fails WCAG AA contrast (4.5:1) under
 *                             protanopia or deuteranopia simulation
 *   a11y_deep_summary       — info, always emitted with violation counts by impact
 *
 * Deduplication: findings already emitted by snapshot-analyzer
 * (a11y_missing_name, a11y_missing_form_label, heading_level_skip) are
 * suppressed to avoid double-reporting the same issue.
 *
 * Requires axe-core >= 4.12 (npm dependency).
 */

import fs                    from 'fs';
import path                  from 'path';
import { createRequire }     from 'module';
import { fileURLToPath }     from 'url';
import { registerExpensive } from '../registry.js';
import { unwrapEval }        from './mcp-client.js';
import { childLogger }       from './logger.js';
import { thresholds }        from '../config/targets.js';

const logger = childLogger('a11y-deep');

// ── axe-core source (injected into the page at runtime) ───────────────────────
const _require = createRequire(import.meta.url);
const AXE_MIN_PATH = _require.resolve('axe-core/axe.min.js');
const AXE_SOURCE   = fs.readFileSync(AXE_MIN_PATH, 'utf8');
// Serialize once — used in every evaluate call
const AXE_SOURCE_JSON = JSON.stringify(AXE_SOURCE);

// ── Thresholds ─────────────────────────────────────────────────────────────────
const CONTRAST_AA        = thresholds.a11y?.contrastAA        ?? 4.5;   // WCAG AA normal text
const MAX_AXE_VIOLATIONS = thresholds.a11y?.maxAxeViolations  ?? 50;    // cap per run

// ── Axe impact → Argus severity ───────────────────────────────────────────────
function axeSeverity(impact) {
  if (impact === 'critical')                return 'critical';
  if (impact === 'serious' || impact === 'moderate') return 'warning';
  return 'info';
}

// ── Axe-core rule IDs already covered by snapshot/keyboard analyzers ─────────
// Suppress these to avoid double-reporting.
const ALREADY_COVERED = new Set([
  'label',                  // → a11y_missing_form_label
  'button-name',            // partially → a11y_missing_name (SVG buttons)
  'heading-order',          // → heading_level_skip
  'aria-required-children', // → aria_expanded_no_controls
  'landmark-unique',        // → a11y_duplicate_landmark
]);

// ── In-browser color-blind simulation script ───────────────────────────────────
// Returns an array of { selector, colorType, contrastRatio, fg, bg }
const COLORBLIND_SCRIPT = `() => {
  // CVD transformation matrices (simplified Machado et al. 2009)
  var CVD = {
    protanopia:  [[0.567,0.433,0],[0.558,0.442,0],[0,0.242,0.758]],
    deuteranopia:[[0.625,0.375,0],[0.7,0.3,0],[0,0.3,0.7]],
  };

  function parseRgb(str) {
    var m = (str || '').match(/rgb[a]?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : null;
  }

  function simulateCvd(rgb, matrix) {
    var r = rgb[0]/255, g = rgb[1]/255, b = rgb[2]/255;
    return [
      Math.round((matrix[0][0]*r + matrix[0][1]*g + matrix[0][2]*b) * 255),
      Math.round((matrix[1][0]*r + matrix[1][1]*g + matrix[1][2]*b) * 255),
      Math.round((matrix[2][0]*r + matrix[2][1]*g + matrix[2][2]*b) * 255),
    ];
  }

  function luminance(rgb) {
    return rgb.map(function(c) {
      var v = c / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }).reduce(function(sum, v, i) { return sum + v * [0.2126,0.7152,0.0722][i]; }, 0);
  }

  function contrastRatio(a, b) {
    var la = luminance(a), lb = luminance(b);
    var lighter = Math.max(la, lb), darker = Math.min(la, lb);
    return (lighter + 0.05) / (darker + 0.05);
  }

  var issues = [];
  var seen = new Set();

  var elements = document.querySelectorAll('p,h1,h2,h3,h4,h5,h6,a,button,label,span,li,td,th');
  for (var i = 0; i < Math.min(elements.length, 200); i++) {
    var el = elements[i];
    var style = window.getComputedStyle(el);
    var fgRgb = parseRgb(style.color);
    var bgRgb = parseRgb(style.backgroundColor);
    if (!fgRgb || !bgRgb) continue;
    // Skip transparent backgrounds
    if (bgRgb[0] === 0 && bgRgb[1] === 0 && bgRgb[2] === 0 &&
        style.backgroundColor.includes('rgba(0, 0, 0, 0')) continue;

    var sel = el.tagName.toLowerCase() +
              (el.id ? '#' + el.id : '') +
              (el.className && typeof el.className === 'string' ?
               '.' + el.className.trim().split(/\\s+/)[0] : '');

    for (var type in CVD) {
      var key = sel + '|' + type;
      if (seen.has(key)) continue;
      var simFg = simulateCvd(fgRgb, CVD[type]);
      var simBg = simulateCvd(bgRgb, CVD[type]);
      var cr = contrastRatio(simFg, simBg);
      if (cr < 4.5) {
        seen.add(key);
        issues.push({
          selector: sel,
          colorType: type,
          contrastRatio: Math.round(cr * 100) / 100,
          fg: 'rgb(' + fgRgb.join(',') + ')',
          bg: 'rgb(' + bgRgb.join(',') + ')',
        });
      }
    }
  }
  return JSON.stringify(issues);
}`;

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Run axe-core + color blind simulation against a loaded page.
 *
 * @param {object} browser - CdpBrowserAdapter
 * @param {string} url     - Page URL (already loaded by caller or navigate here)
 * @returns {Promise<object[]>}
 */
export async function analyzeA11yDeep(browser, url) {
  const findings = [];

  // Navigate fresh
  try {
    await browser.navigate(url);
    await browser.waitFor({ state: 'networkidle' }).catch(() => {});
    await new Promise(r => setTimeout(r, 800));
  } catch {
    return findings;
  }

  // ── 1. Inject axe-core ────────────────────────────────────────────────────
  try {
    await browser.evaluate(`() => {
      if (!window.axe) {
        const s = document.createElement('script');
        s.textContent = ${AXE_SOURCE_JSON};
        document.head.appendChild(s);
      }
      return !!window.axe;
    }`);
  } catch (err) {
    logger.warn(`[ARGUS] a11y-deep: axe-core injection failed for ${url}: ${err.message}`);
    return findings;
  }

  // ── 2. Run axe-core analysis ──────────────────────────────────────────────
  let violations = [];
  try {
    const raw = await browser.evaluate(`async () => {
      if (!window.axe) return '{"violations":[]}';
      try {
        const results = await window.axe.run(document, {
          reporter: 'v2',
          runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21a','wcag21aa','best-practice'] },
        });
        return JSON.stringify({
          violations: results.violations.map(v => ({
            id:          v.id,
            impact:      v.impact,
            description: v.description,
            helpUrl:     v.helpUrl,
            nodes:       v.nodes.slice(0, 3).map(n => ({
              target:  (n.target || []).join(', ').slice(0, 100),
              html:    (n.html || '').slice(0, 150),
              impact:  n.impact,
            })),
          })),
        });
      } catch (e) { return '{"violations":[]}'; }
    }`);

    const parsed = (() => {
      try {
        const s = unwrapEval(raw);
        return typeof s === 'object' ? s : JSON.parse(s);
      } catch { return null; }
    })();

    violations = parsed?.violations ?? [];
  } catch (err) {
    logger.warn(`[ARGUS] a11y-deep: axe.run() failed for ${url}: ${err.message}`);
  }

  // ── 3. Map violations → findings (with dedup suppression) ────────────────
  let criticalCount = 0, seriousCount = 0, moderateCount = 0, minorCount = 0;

  for (const v of violations.slice(0, MAX_AXE_VIOLATIONS)) {
    if (ALREADY_COVERED.has(v.id)) continue;

    const sev = axeSeverity(v.impact);
    if (v.impact === 'critical') criticalCount++;
    else if (v.impact === 'serious') seriousCount++;
    else if (v.impact === 'moderate') moderateCount++;
    else minorCount++;

    for (const node of (v.nodes || [{ target: '', html: '' }]).slice(0, 2)) {
      findings.push({
        type:        'a11y_axe_violation',
        axeId:       v.id,
        impact:      v.impact,
        selector:    node.target || '',
        html:        node.html || '',
        description: v.description,
        helpUrl:     v.helpUrl,
        message:     `[axe] ${v.impact}: ${v.description} — ${node.target || 'page'}`,
        severity:    sev,
        url,
      });
    }
  }

  // ── 4. Color blind simulation ─────────────────────────────────────────────
  let colorblindIssues = [];
  try {
    const raw = await browser.evaluate(COLORBLIND_SCRIPT);
    const parsed = (() => {
      try {
        const s = unwrapEval(raw);
        return typeof s === 'string' ? JSON.parse(s) : s;
      } catch { return []; }
    })();
    colorblindIssues = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    logger.warn(`[ARGUS] a11y-deep: color blind check failed for ${url}: ${err.message}`);
  }

  for (const issue of colorblindIssues.slice(0, 20)) {
    findings.push({
      type:         'a11y_colorblind_risk',
      selector:     issue.selector,
      colorType:    issue.colorType,
      contrastRatio: issue.contrastRatio,
      fg:           issue.fg,
      bg:           issue.bg,
      message:      `Color blind risk (${issue.colorType}): contrast ${issue.contrastRatio}:1 < ${CONTRAST_AA}:1 on ${issue.selector}`,
      severity:     'warning',
      url,
    });
  }

  // ── 5. Summary — always emitted ───────────────────────────────────────────
  findings.push({
    type:            'a11y_deep_summary',
    axeViolations:   violations.filter(v => !ALREADY_COVERED.has(v.id)).length,
    criticalCount,
    seriousCount,
    moderateCount,
    minorCount,
    colorblindRisks: colorblindIssues.length,
    message:         `axe-core: ${criticalCount} critical, ${seriousCount} serious, ${moderateCount} moderate, ${minorCount} minor violations; ${colorblindIssues.length} color blind contrast risks`,
    severity:        'info',
    url,
  });

  return findings;
}

// ── Self-registration ──────────────────────────────────────────────────────────
registerExpensive({
  name:    'a11y-deep',
  analyze: (browser, url) => analyzeA11yDeep(browser, url),
});
