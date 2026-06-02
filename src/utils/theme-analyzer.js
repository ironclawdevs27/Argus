/**
 * ARGUS Theme Analyzer (Sprint 1 — A7: Theme & Dark Mode)
 *
 * Detects dark mode support gaps and theme consistency issues by:
 *   1. Scanning all stylesheets for @media (prefers-color-scheme: dark) rules
 *   2. Collecting :root CSS custom properties in light mode
 *   3. Emulating dark mode via CDP, re-collecting custom properties
 *   4. Flagging properties whose value does not change between modes
 *
 * Detections:
 *   theme_no_dark_mode  — info    — no @media (prefers-color-scheme: dark) rule anywhere
 *   theme_static_var    — warning — CSS custom property identical in light + dark mode
 *   theme_summary       — info    — summary: dark mode supported/not, var count, screenshot taken
 */

import { registerExpensive } from '../registry.js';
import { unwrapEval }        from './mcp-client.js';
import { childLogger }       from './logger.js';

const logger = childLogger('theme-analyzer');

// ── Page script ────────────────────────────────────────────────────────────────
// Injected via evaluate_script. Scans stylesheets and :root custom properties.
// Returns JSON: { hasDarkModeQuery, rootVars }
const THEME_SCAN_SCRIPT = `() => {
  var result = { hasDarkModeQuery: false, rootVars: {} };

  // Scan all stylesheets for @media (prefers-color-scheme: dark) rules
  var sheets = Array.from(document.styleSheets);
  for (var s = 0; s < sheets.length; s++) {
    try {
      var rules = Array.from(sheets[s].cssRules || []);
      for (var r = 0; r < rules.length; r++) {
        var rule = rules[r];
        if (rule.type === 4 /* MEDIA_RULE */) {
          var cond = rule.conditionText || (rule.media && rule.media.mediaText) || '';
          if (cond.indexOf('prefers-color-scheme') !== -1 && cond.indexOf('dark') !== -1) {
            result.hasDarkModeQuery = true;
          }
        }
      }
    } catch (e) { /* cross-origin stylesheet — skip */ }
  }

  // Collect all CSS custom properties declared on :root
  var rootStyle = getComputedStyle(document.documentElement);
  for (var i = 0; i < rootStyle.length; i++) {
    var prop = rootStyle.item(i);
    if (prop.charAt(0) === '-' && prop.charAt(1) === '-') {
      result.rootVars[prop] = rootStyle.getPropertyValue(prop).trim();
    }
  }

  return JSON.stringify(result);
}`;

// Names suggesting a color/theme token — only these are flagged as static vars
const COLOR_VAR_RE = /color|bg|background|text|foreground|surface|fill|stroke|border|shadow|ring|accent|primary|secondary|muted|card|popover|input|destructive/i;

// ── JSON parse helper ──────────────────────────────────────────────────────────
function parseJson(raw) {
  try {
    const str = unwrapEval(raw);
    if (typeof str === 'object' && str !== null) return str;
    return JSON.parse(str);
  } catch {
    return null;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Analyse theme and dark mode support for a single page.
 *
 * @param {object} browser - CdpBrowserAdapter
 * @param {string} url     - Fully-qualified URL to analyse
 * @returns {Promise<object[]>} Array of theme finding objects
 */
export async function analyzeTheme(browser, url) {
  const findings = [];

  // Navigate and settle
  try {
    await browser.navigate(url);
    await browser.waitFor({ state: 'networkidle' }).catch(() => {});
    await new Promise(r => setTimeout(r, 400));
  } catch {
    return findings;
  }

  // ── Light mode scan ──────────────────────────────────────────────────────────
  let lightData;
  try {
    const raw = await browser.evaluate(THEME_SCAN_SCRIPT);
    lightData = parseJson(raw);
  } catch (err) {
    logger.warn(`[ARGUS] theme-analyzer: light scan failed for ${url}: ${err.message}`);
    return findings;
  }
  if (!lightData) return findings;

  const lightVars  = lightData.rootVars ?? {};
  const varCount   = Object.keys(lightVars).length;

  // ── Detection 1: no dark mode media query ────────────────────────────────────
  if (!lightData.hasDarkModeQuery) {
    findings.push({
      type:    'theme_no_dark_mode',
      message: 'No @media (prefers-color-scheme: dark) rule detected — page has no dark mode support',
      severity: 'info',
      url,
    });
  }

  // ── Dark mode emulation + comparison ────────────────────────────────────────
  let darkData = null;
  try {
    await browser.emulateColorScheme('dark');
    await new Promise(r => setTimeout(r, 300));
    const raw = await browser.evaluate(THEME_SCAN_SCRIPT);
    darkData = parseJson(raw);
  } catch (err) {
    logger.debug(`[ARGUS] theme-analyzer: dark mode emulation skipped for ${url}: ${err.message}`);
  } finally {
    try { await browser.emulateColorScheme('light'); } catch { /* restore best-effort */ }
  }

  // ── Detection 2: CSS custom properties that don't adapt to dark mode ─────────
  if (darkData && lightData.hasDarkModeQuery) {
    const darkVars    = darkData.rootVars ?? {};
    const staticVars  = [];

    for (const [name, lightVal] of Object.entries(lightVars)) {
      const darkVal = darkVars[name];
      if (darkVal !== undefined && darkVal === lightVal && COLOR_VAR_RE.test(name)) {
        staticVars.push(name);
      }
    }

    if (staticVars.length > 0) {
      const preview = staticVars.slice(0, 3).join(', ');
      const extra   = staticVars.length > 3 ? ` (+${staticVars.length - 3} more)` : '';
      findings.push({
        type:     'theme_static_var',
        vars:     staticVars.slice(0, 10),
        count:    staticVars.length,
        message:  `${staticVars.length} color custom propert${staticVars.length === 1 ? 'y does' : 'ies do'} not change between light and dark mode: ${preview}${extra}`,
        severity: 'warning',
        url,
      });
    }
  }

  // ── Summary finding ──────────────────────────────────────────────────────────
  findings.push({
    type:        'theme_summary',
    hasDarkMode: lightData.hasDarkModeQuery,
    rootVarCount: varCount,
    darkEmulated: darkData !== null,
    message:     `Theme: ${lightData.hasDarkModeQuery ? 'dark mode supported' : 'no dark mode'}, ${varCount} CSS custom propert${varCount === 1 ? 'y' : 'ies'} on :root`,
    severity:    'info',
    url,
  });

  return findings;
}

// ── Self-registration ─────────────────────────────────────────────────────────
registerExpensive({
  name: 'theme',
  analyze: (browser, url) => analyzeTheme(browser, url),
});
