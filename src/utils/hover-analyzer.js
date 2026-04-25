/**
 * ARGUS Hover-State Analyzer (v3 Phase D8.1)
 *
 * Uses mcp.hover() to trigger hover state on interactive elements that declare
 * dropdown or tooltip behaviour via ARIA attributes, then verifies the expected
 * DOM change occurred after the hover.
 *
 * Detections:
 *   hover_dropdown_broken — [aria-haspopup] element whose controlled popup does
 *                           not become visible (aria-expanded stays false, popup
 *                           remains display:none / visibility:hidden / opacity:0)
 *   hover_tooltip_missing — [data-tooltip] element whose tooltip is not visible
 *                           in the DOM after hover (not found or opacity:0 /
 *                           display:none)
 *
 * Candidates are capped (8 dropdowns, 5 tooltips) to keep crawl time bounded.
 * All errors are silently swallowed per-element so a single broken selector
 * cannot abort the entire analysis.
 */

// ── Discovery script ──────────────────────────────────────────────────────────
// Runs in the live page to find hover-testable candidates.
// Returns JSON array of { kind, selector, controls, tooltipId, label }.
const HOVER_CANDIDATE_SCRIPT = `() => {
  var results = [];
  function buildSelector(el) {
    if (el.id) return '#' + el.id;
    var cls = Array.from(el.classList)
      .filter(function(c) { return /^[a-zA-Z_-]/.test(c); })
      .slice(0, 2).join('.');
    var tag = el.tagName.toLowerCase();
    if (!cls) return tag;
    var matches = document.querySelectorAll(tag + '.' + cls.replace('.', '.'));
    if (matches.length === 1) return tag + '.' + cls;
    var idx = Array.from(document.querySelectorAll(tag)).indexOf(el) + 1;
    return tag + ':nth-of-type(' + idx + ')';
  }
  var popupEls = document.querySelectorAll('[aria-haspopup]');
  for (var i = 0; i < Math.min(popupEls.length, 8); i++) {
    var el = popupEls[i];
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    results.push({
      kind:     'haspopup',
      selector: buildSelector(el),
      controls: el.getAttribute('aria-controls') || null,
      label:    (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40),
    });
  }
  var tipEls = document.querySelectorAll('[data-tooltip]');
  for (var j = 0; j < Math.min(tipEls.length, 5); j++) {
    var tel = tipEls[j];
    var tr = tel.getBoundingClientRect();
    if (tr.width === 0 && tr.height === 0) continue;
    results.push({
      kind:      'tooltip',
      selector:  buildSelector(tel),
      tooltipId: tel.getAttribute('aria-describedby') || null,
      label:     tel.getAttribute('data-tooltip') || '',
    });
  }
  return JSON.stringify(results);
}`;

// ── Post-hover check — dropdown ───────────────────────────────────────────────
// After hovering an [aria-haspopup] element, checks whether:
//   (a) aria-expanded="true" is now present on any haspopup element, OR
//   (b) the controlled popup element is visually visible.
// Returns JSON { expanded: bool, popupVisible: bool }.
function popupCheckScript(controls) {
  const ctrlExpr = controls
    ? `document.getElementById(${JSON.stringify(controls)})`
    : `(document.querySelector('[role="menu"],[role="listbox"],[role="dialog"]'))`;
  return `() => {
    var expanded = document.querySelector('[aria-haspopup][aria-expanded="true"]') !== null;
    var ctrlEl   = ${ctrlExpr};
    var popupVisible = false;
    if (ctrlEl) {
      var s = window.getComputedStyle(ctrlEl);
      popupVisible = s.display !== 'none'
        && s.visibility !== 'hidden'
        && parseFloat(s.opacity) > 0.05
        && ctrlEl.offsetHeight > 0;
    }
    return JSON.stringify({ expanded: expanded, popupVisible: popupVisible });
  }`;
}

// ── Post-hover check — tooltip ────────────────────────────────────────────────
// After hovering a [data-tooltip] element, checks whether the associated
// tooltip element is visible (non-zero size, opacity > 0, not display:none).
// Returns JSON { found: bool, visible: bool }.
function tooltipCheckScript(tooltipId) {
  const tipExpr = tooltipId
    ? `document.getElementById(${JSON.stringify(tooltipId)})`
    : `document.querySelector('[role="tooltip"]')`;
  return `() => {
    var tip = ${tipExpr};
    if (!tip) tip = document.querySelector('[role="tooltip"]');
    if (!tip) return JSON.stringify({ found: false, visible: false });
    var s = window.getComputedStyle(tip);
    var visible = s.display !== 'none'
      && s.visibility !== 'hidden'
      && parseFloat(s.opacity) > 0.05
      && tip.offsetHeight > 0;
    return JSON.stringify({ found: true, visible: visible });
  }`;
}

// ── JSON parse helper ─────────────────────────────────────────────────────────
function parseJson(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const inner = raw.result !== undefined ? raw.result : raw;
    if (typeof inner === 'string') { try { return JSON.parse(inner); } catch { return null; } }
    return typeof inner === 'object' ? inner : null;
  }
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return null; } }
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Analyse hover-state behaviour for interactive elements on a page.
 *
 * Navigates to the URL, discovers hover-testable elements, hovers each one,
 * then verifies that the expected DOM change occurred. Silently skips elements
 * whose selector cannot be resolved or whose hover call throws.
 *
 * @param {object}  mcp        - MCP tool interface (navigate_page, evaluate_script, hover)
 * @param {string}  url        - Fully-qualified URL to analyse
 * @param {boolean} isCritical - Whether the route is marked critical in targets.js
 * @returns {Promise<object[]>} Array of hover-bug finding objects
 */
export async function analyzeHover(mcp, url, isCritical = false) {
  const findings = [];

  try {
    await mcp.navigate_page({ url });
    await new Promise(r => setTimeout(r, 1000));
  } catch {
    return findings;
  }

  let candidates = [];
  try {
    const raw = await mcp.evaluate_script({ function: HOVER_CANDIDATE_SCRIPT });
    const parsed = parseJson(raw);
    candidates = Array.isArray(parsed) ? parsed : [];
  } catch {
    return findings;
  }

  for (const candidate of candidates) {
    try {
      await mcp.hover({ selector: candidate.selector });
      await new Promise(r => setTimeout(r, 350));

      if (candidate.kind === 'haspopup') {
        const raw   = await mcp.evaluate_script({ function: popupCheckScript(candidate.controls) });
        const state = parseJson(raw);
        if (state && !state.expanded && !state.popupVisible) {
          findings.push({
            type:     'hover_dropdown_broken',
            selector: candidate.selector,
            label:    candidate.label,
            message:  `Hover on "${candidate.label || candidate.selector}" (aria-haspopup) did not open its dropdown — aria-expanded stayed false and controlled popup remained hidden`,
            severity: isCritical ? 'critical' : 'warning',
            url,
          });
        }
      } else if (candidate.kind === 'tooltip') {
        const raw   = await mcp.evaluate_script({ function: tooltipCheckScript(candidate.tooltipId) });
        const state = parseJson(raw);
        if (state && !state.visible) {
          findings.push({
            type:     'hover_tooltip_missing',
            selector: candidate.selector,
            label:    candidate.label,
            message:  `Hover on "${candidate.label || candidate.selector}" (data-tooltip) did not reveal a tooltip — tooltip element ${state.found ? 'exists but is hidden (opacity / display / visibility override)' : 'was not found in DOM'}`,
            severity: 'warning',
            url,
          });
        }
      }
    } catch {
      // Individual hover check failed — skip this element silently
    }
  }

  return findings;
}
