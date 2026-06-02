/**
 * ARGUS Design Fidelity Analyzer (Sprint 2 — D9: Design Fidelity)
 *
 * Compares a live page's computed CSS against Figma design tokens and verifies
 * that Figma-specified components exist in the DOM. Requires pre-fetched figmaData
 * (from src/adapters/figma.js) — analysis is skipped if figmaData is null.
 *
 * Detections:
 *   design_token_mismatch    — warning — CSS custom property value differs from Figma token
 *   design_component_missing — warning — Figma-specified component selector not found in DOM
 *   design_fidelity_summary  — info    — counts of mismatches and missing components
 *
 * The registry integration skips analysis when route.figmaData is absent, so
 * routes without a figmaFrameUrl have zero overhead.
 */

import { registerExpensive } from '../registry.js';
import { unwrapEval }        from './mcp-client.js';
import { childLogger }       from './logger.js';

const logger = childLogger('design-fidelity');

// ── In-page comparison script ─────────────────────────────────────────────────
// Injected via evaluate_script. Reads :root CSS custom properties and checks
// element presence. Returns JSON: { tokenMismatches, missingComponents }.
//
// Receives figmaDataJson as the function argument string — the script is a
// closure so we interpolate it at call time via template literal.

function buildFidelityScript(figmaData) {
  const figmaJson = JSON.stringify(figmaData);
  return `() => {
  var figma = ${figmaJson};
  var result = { tokenMismatches: [], missingComponents: [] };
  var rootStyle = getComputedStyle(document.documentElement);

  // Compare CSS custom properties against Figma token values
  var tokens = figma.tokens || {};
  for (var name in tokens) {
    if (!Object.prototype.hasOwnProperty.call(tokens, name)) continue;
    var expected = String(tokens[name]).trim();
    var actual   = rootStyle.getPropertyValue(name).trim();
    if (!actual) continue; // token not declared on this page — skip
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      result.tokenMismatches.push({ token: name, expected: expected, actual: actual });
    }
  }

  // Verify Figma-specified components exist in the DOM
  var components = figma.components || [];
  for (var i = 0; i < components.length; i++) {
    var comp = components[i];
    if (!document.querySelector(comp.selector)) {
      result.missingComponents.push({ name: comp.name, selector: comp.selector });
    }
  }

  return JSON.stringify(result);
}`;
}

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
 * Analyse design-to-implementation fidelity for a single page.
 *
 * @param {object}      browser    - CdpBrowserAdapter
 * @param {string}      url        - Fully-qualified URL to analyse
 * @param {object|null} figmaData  - { tokens, components, frame } from figma-adapter
 * @returns {Promise<object[]>} Array of design fidelity finding objects
 */
export async function analyzeDesignFidelity(browser, url, figmaData) {
  if (!figmaData) return [];

  const findings = [];

  // Navigate and settle
  try {
    await browser.navigate(url);
    await browser.waitFor({ state: 'networkidle' }).catch(() => {});
    await new Promise(r => setTimeout(r, 400));
  } catch {
    return findings;
  }

  // Run in-page comparison
  let result;
  try {
    const script = buildFidelityScript(figmaData);
    const raw    = await browser.evaluate(script);
    result = parseJson(raw);
  } catch (err) {
    logger.warn(`[ARGUS] design-fidelity: comparison script failed for ${url}: ${err.message}`);
    return findings;
  }
  if (!result) return findings;

  const { tokenMismatches = [], missingComponents = [] } = result;

  // design_token_mismatch — one finding per mismatched token
  for (const { token, expected, actual } of tokenMismatches) {
    findings.push({
      type:     'design_token_mismatch',
      token,
      expected,
      actual,
      message:  `Design token mismatch: "${token}" is "${actual}" but Figma specifies "${expected}"`,
      severity: 'warning',
      url,
    });
  }

  // design_component_missing — one finding per missing component
  for (const { name, selector } of missingComponents) {
    findings.push({
      type:     'design_component_missing',
      component: name,
      selector,
      message:  `Figma component "${name}" (selector: "${selector}") not found in DOM`,
      severity: 'warning',
      url,
    });
  }

  // design_fidelity_summary — always emitted when figmaData is present
  findings.push({
    type:               'design_fidelity_summary',
    tokenMismatches:    tokenMismatches.length,
    missingComponents:  missingComponents.length,
    frameName:          figmaData.frame?.name ?? '',
    message:            `Design fidelity: ${tokenMismatches.length} token mismatch(es), ${missingComponents.length} missing component(s)`,
    severity:           'info',
    url,
  });

  return findings;
}

// ── Self-registration ─────────────────────────────────────────────────────────
// Only runs when the route has pre-fetched figmaData attached by the orchestrator.
registerExpensive({
  name: 'design-fidelity',
  analyze: (browser, url, route) => {
    if (!route?.figmaData) return [];
    return analyzeDesignFidelity(browser, url, route.figmaData);
  },
});
