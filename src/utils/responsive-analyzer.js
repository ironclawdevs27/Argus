/**
 * ARGUS Responsive Analyzer (v3 Phase A6)
 *
 * Checks layout at four breakpoints: 375, 768, 1024, 1440 px
 *   - Horizontal overflow at ≤768 px → critical; at wider viewports → warning
 *   - Touch target size < 44×44 px at 375 px → warning
 *
 * Must be called as a standalone function — NOT inside crawlFixture/crawlRoute.
 * Viewport changes would corrupt subsequent tests if called mid-pipeline.
 * The function always restores the viewport to 1280×900 before returning.
 */

const BREAKPOINTS = [
  { width: 375,  height: 812,  label: 'mobile'  },
  { width: 768,  height: 1024, label: 'tablet'  },
  { width: 1024, height: 768,  label: 'laptop'  },
  { width: 1440, height: 900,  label: 'desktop' },
];

const RESTORE_VIEWPORT = { width: 1280, height: 900 };

/**
 * Injected into the page to detect horizontal overflow.
 *
 * Uses clientWidth (visual viewport, excludes scrollbar) rather than window.innerWidth
 * (layout viewport). With Chrome mobile emulation the layout viewport can be 952 px
 * (legacy mobile default) even when the visual viewport is 375 px — clientWidth
 * always reflects the correct visual width.
 *
 * Returns JSON string for safe serialisation through the MCP transport.
 */
export const OVERFLOW_CHECK_SCRIPT = `() => JSON.stringify({
  overflows: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth
})`;

/**
 * Injected into the page at 375px to find interactive elements smaller than 44×44 px.
 * Excludes hidden inputs and zero-size elements (e.g. display:none).
 */
export const TOUCH_TARGET_SCRIPT = `() => {
  var sel = 'button, a[href], input:not([type=hidden]), select, textarea, [role="button"], [onclick]';
  var MIN = 44;
  var small = [];
  Array.prototype.forEach.call(document.querySelectorAll(sel), function(el) {
    var r = el.getBoundingClientRect();
    var w = Math.round(r.width);
    var h = Math.round(r.height);
    if ((w > 0 || h > 0) && (w < MIN || h < MIN)) {
      small.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        className: (el.className || '').slice(0, 60),
        width: w,
        height: h,
        text: (el.innerText || el.value || '').slice(0, 40).trim()
      });
    }
  });
  return JSON.stringify(small);
}`;

/**
 * Parse an evaluate_script result that should be a JSON object.
 * Handles pre-parsed object, { result: ... } wrapper, or raw JSON string.
 */
function parseEvalObject(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const inner = raw.result !== undefined ? raw.result : raw;
    if (typeof inner === 'object' && !Array.isArray(inner)) return inner;
    if (typeof inner === 'string') {
      try { return JSON.parse(inner); } catch { return null; }
    }
  }
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return null;
}

/**
 * Parse an evaluate_script result that should be a JSON array.
 */
function parseEvalArray(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'object') {
    const inner = raw.result !== undefined ? raw.result : raw.value;
    if (Array.isArray(inner)) return inner;
    if (typeof inner === 'string') {
      try { const p = JSON.parse(inner); return Array.isArray(p) ? p : []; } catch { return []; }
    }
    const vals = Object.values(raw);
    if (vals.length === 1 && Array.isArray(vals[0])) return vals[0];
    return [];
  }
  if (typeof raw === 'string') {
    try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

/**
 * Build the emulate viewport string for chrome-devtools-mcp's emulate tool.
 * Format: '<width>x<height>x<dpr>[,mobile][,touch]'
 * mobile+touch enables Emulation.setDeviceMetricsOverride with mobile=true.
 * After emulation, window.innerWidth reflects the legacy layout viewport (~952px),
 * NOT the device width. Use document.documentElement.clientWidth for the actual
 * visual viewport width (see OVERFLOW_CHECK_SCRIPT and its comment above).
 */
function viewportString(width, height) {
  const mobile = width <= 768 ? ',mobile,touch' : '';
  return `${width}x${height}x1${mobile}`;
}

/**
 * Analyse a URL at four responsive breakpoints.
 *
 * Uses mcp.emulate({ viewport }) rather than resize_page because resize_page only
 * resizes the browser window — it does not update the CSS viewport that JS reads
 * via window.innerWidth. emulate() calls Emulation.setDeviceMetricsOverride which
 * properly sets both the layout viewport and window.innerWidth.
 *
 * @param {object} mcp - MCP tool interface (emulate, navigate_page, evaluate_script, take_screenshot)
 * @param {string} url - Page URL to analyse
 * @returns {Promise<{ findings: object[], screenshots: object }>}
 *   findings — array of responsive bug entries (same shape as crawlRoute errors)
 *   screenshots — map of "WIDTHxHEIGHT" → base64 PNG data
 */
export async function analyzeResponsive(mcp, url) {
  const findings    = [];
  const screenshots = {};

  for (const bp of BREAKPOINTS) {
    try {
      await mcp.emulate({ viewport: viewportString(bp.width, bp.height) });
      await mcp.navigate_page({ url });
      await new Promise(r => setTimeout(r, 1000));

      // ── Overflow check ──────────────────────────────────────────────────
      try {
        const raw         = await mcp.evaluate_script({ function: OVERFLOW_CHECK_SCRIPT });
        const overflowData = parseEvalObject(raw);

        if (overflowData?.overflows) {
          const isMobile = bp.width <= 768;
          findings.push({
            type:        'responsive_overflow',
            viewport:    bp.width,
            label:       bp.label,
            scrollWidth: overflowData.scrollWidth,
            clientWidth: overflowData.clientWidth,
            message:     `Horizontal overflow at ${bp.width}px (${bp.label}): scrollWidth ${overflowData.scrollWidth}px > viewport ${overflowData.clientWidth}px`,
            severity:    isMobile ? 'critical' : 'warning',
            url,
          });
        }
      } catch (err) {
        console.warn(`[ARGUS] Overflow check failed at ${bp.width}px: ${err.message}`);
      }

      // ── Touch target check — at 375 px (mobile) and 768 px (tablet) ──────
      if (bp.width === 375 || bp.width === 768) {
        try {
          const raw         = await mcp.evaluate_script({ function: TOUCH_TARGET_SCRIPT });
          const smallTargets = parseEvalArray(raw);

          if (smallTargets.length > 0) {
            findings.push({
              type:     'responsive_small_touch_target',
              viewport:  bp.width,
              label:     bp.label,
              count:     smallTargets.length,
              targets:   smallTargets.slice(0, 10),
              message:   `${smallTargets.length} interactive element(s) smaller than 44×44 px at ${bp.width}px (${bp.label}): ${
                smallTargets.map(t => `<${t.tag}${t.id ? '#' + t.id : ''}> ${t.width}×${t.height}px`).join(', ')
              }`,
              severity:  'warning',
              url,
            });
          }
        } catch (err) {
          console.warn(`[ARGUS] Touch target check failed at ${bp.width}px: ${err.message}`);
        }
      }

      // ── Screenshot ──────────────────────────────────────────────────────
      try {
        const shot = await mcp.take_screenshot({ format: 'png' });
        if (shot?.data) screenshots[`${bp.width}x${bp.height}`] = shot.data;
      } catch { /* screenshots are optional */ }

    } catch (err) {
      console.warn(`[ARGUS] Responsive analysis failed at ${bp.width}px: ${err.message}`);
    }
  }

  // ── Always restore viewport ─────────────────────────────────────────────
  try {
    await mcp.emulate({ viewport: viewportString(RESTORE_VIEWPORT.width, RESTORE_VIEWPORT.height) });
  } catch { /* best-effort restore */ }

  return { findings, screenshots };
}
