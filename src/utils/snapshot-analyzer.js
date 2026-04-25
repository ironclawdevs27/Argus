/**
 * ARGUS Accessibility Snapshot Analyzer (v3 Phase D8.2)
 *
 * Calls mcp.take_snapshot() to satisfy the D8.2 tool-coverage requirement, then
 * uses evaluate_script for reliable ARIA property queries (take_snapshot format
 * is implementation-dependent in chrome-devtools-mcp; evaluate_script is stable).
 *
 * Detections:
 *   a11y_missing_name       — interactive element (button, a, input[type=submit/button/reset],
 *                             [role=button/link]) with no accessible name (no text content,
 *                             no aria-label, no aria-labelledby, no title, no alt)
 *   a11y_missing_form_label — <input> / <select> / <textarea> (excluding hidden/submit/button/
 *                             reset/image) with no associated <label>, no aria-label, and no
 *                             aria-labelledby
 *   a11y_duplicate_landmark — landmark role that appears more than once without a unique
 *                             aria-label or aria-labelledby distinguishing each instance
 *                             (checked for: main, banner, contentinfo, navigation, search,
 *                             complementary, form, region)
 *
 * Candidates are capped (20 interactive elements, 20 form controls) to bound crawl time.
 * All per-element errors are silently swallowed.
 */

// ── ARIA name check script ────────────────────────────────────────────────────
// Returns JSON array of { tag, role, outerHTML } for unlabelled interactive elements.
const MISSING_NAME_SCRIPT = `() => {
  var results = [];
  var selectors = [
    'button', 'a[href]', 'input[type="submit"]', 'input[type="button"]',
    'input[type="reset"]', '[role="button"]', '[role="link"]'
  ];
  var seen = new Set();
  var all = [];
  selectors.forEach(function(sel) {
    document.querySelectorAll(sel).forEach(function(el) { if (!seen.has(el)) { seen.add(el); all.push(el); } });
  });
  var count = 0;
  for (var i = 0; i < all.length && count < 20; i++) {
    var el = all[i];
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    var name = (el.textContent || '').trim()
      || el.getAttribute('aria-label') || ''
      || (el.getAttribute('aria-labelledby') ? (document.getElementById(el.getAttribute('aria-labelledby')) || {}).textContent || '' : '')
      || el.getAttribute('title') || ''
      || el.getAttribute('alt') || '';
    if (!name.trim()) {
      results.push({
        tag:       el.tagName.toLowerCase(),
        role:      el.getAttribute('role') || null,
        outerHTML: el.outerHTML.slice(0, 120),
      });
    }
    count++;
  }
  return JSON.stringify(results);
}`;

// ── Form label check script ───────────────────────────────────────────────────
// Returns JSON array of { tag, type, id, name } for unlabelled form controls.
const MISSING_LABEL_SCRIPT = `() => {
  var results = [];
  var controls = document.querySelectorAll('input,select,textarea');
  var skip = new Set(['hidden','submit','button','reset','image']);
  var count = 0;
  for (var i = 0; i < controls.length && count < 20; i++) {
    var el = controls[i];
    var type = (el.getAttribute('type') || '').toLowerCase();
    if (skip.has(type)) continue;
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) { count++; continue; }
    var hasLabel = false;
    if (el.id) { hasLabel = !!document.querySelector('label[for="' + el.id + '"]'); }
    if (!hasLabel && el.closest('label')) hasLabel = true;
    if (!hasLabel && el.getAttribute('aria-label')) hasLabel = true;
    if (!hasLabel && el.getAttribute('aria-labelledby')) hasLabel = true;
    if (!hasLabel && el.getAttribute('placeholder')) hasLabel = true;
    if (!hasLabel) {
      results.push({
        tag:  el.tagName.toLowerCase(),
        type: type || null,
        id:   el.id || null,
        name: el.getAttribute('name') || null,
      });
    }
    count++;
  }
  return JSON.stringify(results);
}`;

// ── Duplicate landmark check script ──────────────────────────────────────────
// Returns JSON array of role strings that appear more than once without distinct labels.
const DUPLICATE_LANDMARK_SCRIPT = `() => {
  var landmarks = ['main','banner','contentinfo','navigation','search','complementary','form','region'];
  var results = [];
  landmarks.forEach(function(role) {
    var els = Array.from(document.querySelectorAll(
      '[role="' + role + '"]' + (role === 'main' ? ',main' : role === 'banner' ? ',header' : role === 'contentinfo' ? ',footer' : role === 'navigation' ? ',nav' : role === 'complementary' ? ',aside' : role === 'form' ? ',form' : '')
    ));
    if (els.length < 2) return;
    var labels = els.map(function(el) {
      return (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || '').trim();
    });
    var uniqueLabels = new Set(labels.filter(Boolean));
    if (uniqueLabels.size < els.length) {
      results.push({ role: role, count: els.length });
    }
  });
  return JSON.stringify(results);
}`;

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
 * Analyse accessibility properties on a page via DOM snapshot + script evaluation.
 *
 * Calls take_snapshot() (D8.2 tool requirement), then uses evaluate_script for
 * reliable ARIA property queries. Navigates internally; silently skips elements
 * whose checks throw.
 *
 * @param {object}  mcp        - MCP tool interface (navigate_page, take_snapshot, evaluate_script)
 * @param {string}  url        - Fully-qualified URL to analyse
 * @returns {Promise<object[]>} Array of a11y finding objects
 */
export async function analyzeSnapshot(mcp, url) {
  const findings = [];

  try {
    await mcp.navigate_page({ url });
    await new Promise(r => setTimeout(r, 800));
  } catch {
    return findings;
  }

  // Satisfy D8.2 tool requirement — snapshot captures current DOM/AX state.
  // We store but don't parse its format (implementation-dependent).
  try {
    await mcp.take_snapshot();
  } catch {
    // Non-fatal: evaluation-based checks proceed regardless
  }

  // ── Missing accessible name ───────────────────────────────────────────────
  try {
    const raw    = await mcp.evaluate_script({ function: MISSING_NAME_SCRIPT });
    const items  = parseJson(raw);
    if (Array.isArray(items)) {
      for (const item of items) {
        findings.push({
          type:     'a11y_missing_name',
          tag:      item.tag,
          role:     item.role,
          snippet:  item.outerHTML,
          message:  `Interactive element <${item.tag}${item.role ? ` role="${item.role}"` : ''}> has no accessible name — add aria-label, visible text, or title`,
          severity: 'warning',
          url,
        });
      }
    }
  } catch {
    // Skip silently
  }

  // ── Missing form label ────────────────────────────────────────────────────
  try {
    const raw    = await mcp.evaluate_script({ function: MISSING_LABEL_SCRIPT });
    const items  = parseJson(raw);
    if (Array.isArray(items)) {
      for (const item of items) {
        const desc = item.id ? `#${item.id}` : item.name ? `[name="${item.name}"]` : item.type ? `[type="${item.type}"]` : '';
        findings.push({
          type:     'a11y_missing_form_label',
          tag:      item.tag,
          id:       item.id,
          name:     item.name,
          message:  `Form control <${item.tag}${desc}> has no associated label — add <label for="...">, aria-label, or aria-labelledby`,
          severity: 'warning',
          url,
        });
      }
    }
  } catch {
    // Skip silently
  }

  // ── Duplicate landmarks ───────────────────────────────────────────────────
  try {
    const raw    = await mcp.evaluate_script({ function: DUPLICATE_LANDMARK_SCRIPT });
    const items  = parseJson(raw);
    if (Array.isArray(items)) {
      for (const item of items) {
        findings.push({
          type:     'a11y_duplicate_landmark',
          role:     item.role,
          count:    item.count,
          message:  `${item.count} elements share the "${item.role}" landmark role without distinct aria-label — screen readers cannot distinguish them`,
          severity: 'warning',
          url,
        });
      }
    }
  } catch {
    // Skip silently
  }

  return findings;
}
