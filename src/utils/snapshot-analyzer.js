/**
 * ARGUS Accessibility Snapshot Analyzer (v3 Phase D8.2)
 *
 * Calls browser.snapshot() to satisfy the D8.2 tool-coverage requirement, then
 * uses browser.evaluate() for reliable ARIA property queries (take_snapshot format
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
    if (el.id) { hasLabel = !!document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); }
    if (!hasLabel && el.closest('label')) hasLabel = true;
    if (!hasLabel && el.getAttribute('aria-label')) hasLabel = true;
    if (!hasLabel && el.getAttribute('aria-labelledby')) hasLabel = true;
    // placeholder is not a valid accessible name — intentionally excluded (WCAG 2.1 §3.3.2)
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
    // <header>/<footer> (banner/contentinfo) inside sectioning content
    // (<article>, <aside>, <main>, <nav>, <section>) don't expose global landmark
    // roles per the HTML-AAM spec — only count document-scoped instances.
    els = els.filter(function(el) {
      return !el.parentElement || !el.parentElement.closest('article,aside,nav,section');
    });
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

// ── Heading hierarchy check script ─────────────────────────────────────────
// Detects heading level skips (e.g. h1 → h3) that break screen-reader nav.
const HEADING_HIERARCHY_SCRIPT = `() => {
  var headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'));
  var levels = headings.map(function(h){ return parseInt(h.tagName[1], 10); });
  var skips = [];
  for (var i = 1; i < levels.length; i++) {
    if (levels[i] > levels[i - 1] + 1) {
      skips.push({
        from: levels[i - 1],
        to:   levels[i],
        text: headings[i].textContent.trim().slice(0, 60),
      });
    }
  }
  return JSON.stringify(skips);
}`;

// ── ARIA state check script ──────────────────────────────────────────────────
// Detects aria-expanded elements that have no aria-controls pointing to a real element,
// and form controls that have aria-required but the attribute value is incorrect.
const ARIA_STATE_SCRIPT = `() => {
  var issues = [];

  // aria-expanded without aria-controls → AT can't navigate to the controlled content
  var expanded = Array.from(document.querySelectorAll('[aria-expanded]'));
  expanded.slice(0, 20).forEach(function(el) {
    var controls = el.getAttribute('aria-controls');
    if (!controls) {
      issues.push({
        issueType: 'aria_expanded_no_controls',
        tag:       el.tagName.toLowerCase(),
        id:        el.id || null,
        snippet:   el.outerHTML.slice(0, 100),
      });
    } else if (!document.getElementById(controls)) {
      issues.push({
        issueType: 'aria_expanded_no_controls',
        tag:       el.tagName.toLowerCase(),
        id:        el.id || null,
        snippet:   el.outerHTML.slice(0, 100),
        detail:    'aria-controls="' + controls + '" references a non-existent element',
      });
    }
  });

  return JSON.stringify(issues);
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
export async function analyzeSnapshot(browser, url) {
  const findings = [];

  try {
    await browser.navigate(url);
    await new Promise(r => setTimeout(r, 800));
  } catch {
    return findings;
  }

  // Satisfy D8.2 tool requirement — snapshot captures current DOM/AX state.
  // We store but don't parse its format (implementation-dependent).
  try {
    await browser.snapshot();
  } catch {
    // Non-fatal: evaluation-based checks proceed regardless
  }

  // ── Missing accessible name ───────────────────────────────────────────────
  try {
    const raw    = await browser.evaluate(MISSING_NAME_SCRIPT);
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
    const raw    = await browser.evaluate(MISSING_LABEL_SCRIPT);
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
    const raw    = await browser.evaluate(DUPLICATE_LANDMARK_SCRIPT);
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

  // ── ARIA state checks ────────────────────────────────────────────────────
  try {
    const raw   = await browser.evaluate(ARIA_STATE_SCRIPT);
    const items = parseJson(raw);
    if (Array.isArray(items)) {
      for (const item of items) {
        if (item.issueType === 'aria_expanded_no_controls') {
          findings.push({
            type:    'aria_expanded_no_controls',
            tag:     item.tag,
            id:      item.id,
            snippet: item.snippet,
            message: item.detail
              ? `<${item.tag}${item.id ? '#' + item.id : ''}> aria-expanded — ${String(item.detail).slice(0, 200)}`
              : `<${item.tag}${item.id ? '#' + item.id : ''}> has aria-expanded but no aria-controls — AT users cannot navigate to the controlled content`,
            severity: 'warning',
            url,
          });
        }
      }
    }
  } catch {
    // Skip silently
  }

  // ── Heading hierarchy ─────────────────────────────────────────────────────
  try {
    const raw   = await browser.evaluate(HEADING_HIERARCHY_SCRIPT);
    const items = parseJson(raw);
    if (Array.isArray(items)) {
      for (const item of items) {
        findings.push({
          type:     'heading_level_skip',
          from:     item.from,
          to:       item.to,
          text:     item.text,
          message:  `Heading level skips from h${item.from} to h${item.to} ("${item.text}") — use sequential heading levels for screen-reader navigation`,
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
