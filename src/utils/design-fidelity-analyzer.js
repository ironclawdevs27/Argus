/**
 * ARGUS Design Fidelity Analyzer (Sprint 2 — D9: Design Fidelity)
 *
 * Compares a live page's computed CSS against every property extracted by
 * src/adapters/figma.js. Requires pre-fetched figmaData — analysis is skipped
 * when figmaData is null (no figmaFrameUrl on the route).
 *
 * Selector strategy: each Figma node carries a `selectors` array of candidates
 * (data-testid, aria-label, #id, .class). The in-page script tries each in
 * order and uses the first that matches a DOM element. Falls back gracefully
 * when no candidate matches — the node is silently skipped.
 *
 * Detections:
 *   design_token_mismatch      — CSS custom property differs from Figma token
 *   design_component_missing   — Figma component selector not found in DOM
 *   design_color_mismatch      — Computed fill/text color deviates >5% RGB distance
 *   design_typography_mismatch — fontSize, fontWeight, lineHeight, fontFamily, or letterSpacing differs
 *   design_spacing_mismatch    — Computed padding deviates from Figma Auto Layout by >2px
 *   design_radius_mismatch     — Computed border-radius differs from Figma cornerRadius by >1px (per-corner)
 *   design_bounds_overflow     — Element rect overflows Figma bounding box by >5px
 *   design_position_drift      — Element absolute position deviates from Figma bounds x/y by >20px
 *   design_stroke_mismatch     — Border color or width differs from Figma stroke
 *   design_shadow_mismatch     — box-shadow offset, blur, spread, or color differs from Figma DROP_SHADOW
 *   design_opacity_mismatch    — CSS opacity differs from Figma node opacity by >10%
 *   design_gap_mismatch        — CSS column-gap/row-gap differs from Figma Auto Layout gap by >2px
 *   design_text_mismatch       — DOM textContent differs from Figma characters string
 *   design_fidelity_summary    — Aggregate counts for all mismatch types
 */

import { registerExpensive } from '../registry.js';
import { unwrapEval }        from './mcp-client.js';
import { childLogger }       from './logger.js';

const logger = childLogger('design-fidelity');

// ── Comparison thresholds ─────────────────────────────────────────────────────
const COLOR_THRESHOLD          = 22;   // Euclidean RGB distance (~5% of 255√3 ≈ 441)
const SPACING_THRESHOLD        = 2;    // px padding deviation
const FONT_THRESHOLD           = 1;    // px font-size / line-height
const RADIUS_THRESHOLD         = 1;    // px border-radius (per corner)
const BOUNDS_TOLERANCE         = 5;    // px bounding-box overflow
const POSITION_DRIFT_THRESHOLD = 20;   // px absolute position drift (scroll-corrected)
const OPACITY_THRESHOLD        = 0.1;  // ±10% opacity tolerance
const LETTER_SPACING_THRESHOLD = 0.5;  // px
const BORDER_WEIGHT_THRESHOLD  = 0.5;  // px
const SHADOW_BLUR_THRESHOLD    = 2;    // px
const SHADOW_OFFSET_THRESHOLD  = 1;    // px
const SHADOW_SPREAD_THRESHOLD  = 2;    // px

// ── In-page comparison script ─────────────────────────────────────────────────
function buildFidelityScript(figmaData, thresholds) {
  const figmaJson  = JSON.stringify(figmaData);
  const threshJson = JSON.stringify(thresholds);
  return `() => {
  var figma  = ${figmaJson};
  var THRESH = ${threshJson};
  var result = {
    tokenMismatches:      [],
    missingComponents:    [],
    colorMismatches:      [],
    typographyMismatches: [],
    spacingMismatches:    [],
    radiusMismatches:     [],
    boundsOverflows:      [],
    positionDrifts:       [],
    strokeMismatches:     [],
    shadowMismatches:     [],
    opacityMismatches:    [],
    gapMismatches:        [],
    textMismatches:       [],
  };

  var rootStyle = getComputedStyle(document.documentElement);

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function parseRgb(str) {
    var m = str && str.match(/rgba?\\((\\d+)[,\\s]+(\\d+)[,\\s]+(\\d+)/);
    return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
  }

  function rgbDelta(a, b) {
    var dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
    return Math.sqrt(dr*dr + dg*dg + db*db);
  }

  function parsePx(str) {
    var v = parseFloat(str);
    return isNaN(v) ? null : v;
  }

  function isTransparentBg(str) {
    if (!str || str.indexOf('rgba') === -1) return false;
    var parts = str.split(',');
    return parseFloat(parts[3]) === 0;
  }

  // Parses Chrome's computed box-shadow regardless of whether color leads or trails.
  function parseBoxShadow(str) {
    if (!str || str === 'none') return null;
    var colorMatch = str.match(/rgba?\\([^)]+\\)/);
    var rest = colorMatch ? str.replace(colorMatch[0], '').trim() : str.trim();
    var nums = rest.match(/-?[\\d.]+px/g);
    if (!nums || nums.length < 2) return null;
    return {
      colorStr: colorMatch ? colorMatch[0] : null,
      offsetX:  parseFloat(nums[0]),
      offsetY:  parseFloat(nums[1]),
      blur:     nums[2] ? parseFloat(nums[2]) : 0,
      spread:   nums[3] ? parseFloat(nums[3]) : 0,
    };
  }

  // Normalise CSS fontFamily: '"Inter", sans-serif' → 'inter'
  function parseFontFamily(str) {
    if (!str) return '';
    return str.split(',')[0].trim().replace(/^["']|["']$/g, '').toLowerCase();
  }

  // Try each selector candidate in order; return { el, sel } for first match.
  function findElementWithSelector(candidates) {
    for (var i = 0; i < candidates.length; i++) {
      try {
        var found = document.querySelector(candidates[i]);
        if (found) return { el: found, sel: candidates[i] };
      } catch(e) { /* invalid selector, skip */ }
    }
    return null;
  }

  // ── 1. CSS custom property tokens (legacy) ────────────────────────────────

  var tokens = figma.tokens || {};
  for (var name in tokens) {
    if (!Object.prototype.hasOwnProperty.call(tokens, name)) continue;
    var expected = String(tokens[name]).trim();
    var actual   = rootStyle.getPropertyValue(name).trim();
    if (!actual) continue;
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      result.tokenMismatches.push({ token: name, expected: expected, actual: actual });
    }
  }

  // ── 2. Component presence (legacy) ───────────────────────────────────────

  var components = figma.components || [];
  for (var ci = 0; ci < components.length; ci++) {
    var comp = components[ci];
    if (!document.querySelector(comp.selector)) {
      result.missingComponents.push({ name: comp.name, selector: comp.selector });
    }
  }

  // ── 3. Per-node rich property comparison ─────────────────────────────────

  var nodes = figma.nodes || [];
  for (var ni = 0; ni < nodes.length; ni++) {
    var node = nodes[ni];

    // Try selector candidates in order (data-testid → aria-label → #id → .class)
    var candidates = node.selectors || (node.selector ? [node.selector] : []);
    var match = findElementWithSelector(candidates);
    if (!match) continue;

    var el  = match.el;
    var sel = match.sel;   // the selector that actually matched
    var cs  = getComputedStyle(el);

    // Color — fill maps to color (TEXT) or backgroundColor (others).
    if (node.fill) {
      var isText   = node.type === 'TEXT';
      var colorStr = isText ? cs.color : cs.backgroundColor;
      if (!(!isText && isTransparentBg(colorStr))) {
        var domRgb = parseRgb(colorStr);
        if (domRgb) {
          var dist = rgbDelta(node.fill, domRgb);
          if (dist > THRESH.color) {
            result.colorMismatches.push({
              selector: sel, name: node.name,
              property: isText ? 'color' : 'backgroundColor',
              expected: 'rgb(' + node.fill.r + ',' + node.fill.g + ',' + node.fill.b + ')',
              actual:   colorStr.replace(/\\s/g, ''),
              delta:    Math.round(dist),
            });
          }
        }
      }
    }

    // Typography — fontSize, fontWeight, lineHeight, fontFamily, letterSpacing.
    if (node.typography) {
      var typo = node.typography;

      if (typo.fontSize != null) {
        var domFs = parsePx(cs.fontSize);
        if (domFs !== null && Math.abs(domFs - typo.fontSize) > THRESH.font) {
          result.typographyMismatches.push({
            selector: sel, name: node.name,
            property: 'fontSize', expected: typo.fontSize, actual: domFs,
          });
        }
      }

      if (typo.fontWeight != null) {
        var domFw = parsePx(cs.fontWeight);
        if (domFw !== null && Math.abs(domFw - typo.fontWeight) > 0) {
          result.typographyMismatches.push({
            selector: sel, name: node.name,
            property: 'fontWeight', expected: typo.fontWeight, actual: domFw,
          });
        }
      }

      if (typo.lineHeightPx != null) {
        var domLh = parsePx(cs.lineHeight);
        if (domLh !== null && Math.abs(domLh - typo.lineHeightPx) > THRESH.font) {
          result.typographyMismatches.push({
            selector: sel, name: node.name,
            property: 'lineHeight', expected: typo.lineHeightPx, actual: domLh,
          });
        }
      }

      if (typo.fontFamily) {
        var domFamily   = parseFontFamily(cs.fontFamily);
        var figmaFamily = typo.fontFamily.toLowerCase();
        if (domFamily && domFamily !== figmaFamily) {
          result.typographyMismatches.push({
            selector: sel, name: node.name,
            property: 'fontFamily',
            expected: typo.fontFamily,
            actual:   cs.fontFamily.split(',')[0].trim(),
          });
        }
      }

      if (typo.letterSpacing != null && typo.letterSpacing !== 0) {
        var domLs = parsePx(cs.letterSpacing);
        if (domLs !== null && Math.abs(domLs - typo.letterSpacing) > THRESH.letterSpacing) {
          result.typographyMismatches.push({
            selector: sel, name: node.name,
            property: 'letterSpacing', expected: typo.letterSpacing, actual: domLs,
          });
        }
      }
    }

    // Spacing — Auto Layout padding + gap.
    if (node.spacing) {
      var sp    = node.spacing;
      var sides = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'];
      for (var si = 0; si < sides.length; si++) {
        var side   = sides[si];
        if (sp[side] == null) continue;
        var domPad = parsePx(cs[side]);
        if (domPad !== null && Math.abs(domPad - sp[side]) > THRESH.spacing) {
          result.spacingMismatches.push({
            selector: sel, name: node.name,
            property: side, expected: sp[side], actual: domPad,
          });
        }
      }

      // Gap — only when Figma explicitly sets a positive gap.
      if (sp.gap > 0) {
        var gapProp = sp.layoutMode === 'HORIZONTAL' ? 'columnGap' :
                      sp.layoutMode === 'VERTICAL'   ? 'rowGap' : 'columnGap';
        var domGapStr = cs[gapProp];
        if (!domGapStr || domGapStr === 'normal') domGapStr = cs.gap;
        var domGap = parsePx(domGapStr);
        if (domGap !== null && Math.abs(domGap - sp.gap) > THRESH.spacing) {
          result.gapMismatches.push({
            selector: sel, name: node.name,
            property: gapProp, expected: sp.gap, actual: domGap,
          });
        }
      }
    }

    // Corner radius — uniform (number) or per-corner (object with topLeft/topRight/bottomRight/bottomLeft).
    if (node.cornerRadius != null) {
      if (typeof node.cornerRadius === 'number') {
        var domRad = parsePx(cs.borderRadius);
        if (domRad !== null && Math.abs(domRad - node.cornerRadius) > THRESH.radius) {
          result.radiusMismatches.push({
            selector: sel, name: node.name,
            corner: 'all', expected: node.cornerRadius, actual: domRad,
          });
        }
      } else {
        var rcorners = [
          { figma: 'topLeft',     css: 'borderTopLeftRadius'     },
          { figma: 'topRight',    css: 'borderTopRightRadius'    },
          { figma: 'bottomRight', css: 'borderBottomRightRadius' },
          { figma: 'bottomLeft',  css: 'borderBottomLeftRadius'  },
        ];
        for (var rci = 0; rci < rcorners.length; rci++) {
          var rc     = rcorners[rci];
          var expRad = node.cornerRadius[rc.figma];
          if (expRad == null) continue;
          var domRad = parsePx(cs[rc.css]);
          if (domRad !== null && Math.abs(domRad - expRad) > THRESH.radius) {
            result.radiusMismatches.push({
              selector: sel, name: node.name,
              corner: rc.figma, expected: expRad, actual: domRad,
            });
          }
        }
      }
    }

    // Bounds — overflow (size) + position drift (x/y).
    if (node.bounds) {
      var rect = el.getBoundingClientRect();
      var b    = node.bounds;

      // Overflow: element must not be larger than its Figma bounding box.
      if ((rect.width - b.width) > THRESH.bounds || (rect.height - b.height) > THRESH.bounds) {
        result.boundsOverflows.push({
          selector: sel, name: node.name,
          expectedWidth: b.width, expectedHeight: b.height,
          actualWidth: Math.round(rect.width), actualHeight: Math.round(rect.height),
        });
      }

      // Position drift: scroll-corrected absolute position vs Figma frame-relative x/y.
      // Works best when the page matches the Figma frame width and is scrolled to top.
      var scrollX = window.pageXOffset || document.documentElement.scrollLeft || 0;
      var scrollY = window.pageYOffset || document.documentElement.scrollTop  || 0;
      var absLeft = Math.round(rect.left + scrollX);
      var absTop  = Math.round(rect.top  + scrollY);
      var driftX  = Math.abs(absLeft - b.x);
      var driftY  = Math.abs(absTop  - b.y);
      if (driftX > THRESH.positionDrift || driftY > THRESH.positionDrift) {
        result.positionDrifts.push({
          selector: sel, name: node.name,
          expectedX: b.x, expectedY: b.y,
          actualX: absLeft, actualY: absTop,
          driftX: Math.round(driftX), driftY: Math.round(driftY),
        });
      }
    }

    // Stroke — border color (borderTopColor) + weight (borderTopWidth).
    if (node.stroke) {
      var domBW    = parsePx(cs.borderTopWidth);
      var weightOk = domBW !== null && Math.abs((domBW || 0) - node.stroke.weight) <= THRESH.borderWeight;
      var colorOk  = true;
      var colorDlt = null;
      if (domBW > 0) {
        var domBorderRgb = parseRgb(cs.borderTopColor);
        if (domBorderRgb) {
          colorDlt = rgbDelta(node.stroke, domBorderRgb);
          colorOk  = colorDlt <= THRESH.color;
        }
      } else if (domBW === 0 || domBW === null) {
        colorOk = false;
      }
      if (!weightOk || !colorOk) {
        result.strokeMismatches.push({
          selector:       sel, name: node.name,
          expectedColor:  'rgb(' + node.stroke.r + ',' + node.stroke.g + ',' + node.stroke.b + ')',
          actualColor:    domBW > 0 ? cs.borderTopColor.replace(/\\s/g, '') : 'none',
          colorDelta:     colorDlt !== null ? Math.round(colorDlt) : null,
          expectedWeight: node.stroke.weight,
          actualWeight:   domBW,
        });
      }
    }

    // Shadow — offsetX/Y, blur, spread, AND color all compared.
    if (node.shadow) {
      var bsStr = cs.boxShadow;
      if (!bsStr || bsStr === 'none') {
        result.shadowMismatches.push({
          selector: sel, name: node.name,
          expectedOffsetX: node.shadow.offsetX, expectedOffsetY: node.shadow.offsetY,
          expectedBlur: node.shadow.blur, expectedSpread: node.shadow.spread,
          expectedColor: 'rgb(' + node.shadow.r + ',' + node.shadow.g + ',' + node.shadow.b + ')',
          actualOffsetX: 0, actualOffsetY: 0, actualBlur: 0, actualSpread: 0,
          actualColor: 'none', colorDelta: null, reason: 'no-shadow',
        });
      } else {
        var domShadow = parseBoxShadow(bsStr);
        if (domShadow) {
          var xDiff = Math.abs(domShadow.offsetX - node.shadow.offsetX);
          var yDiff = Math.abs(domShadow.offsetY - node.shadow.offsetY);
          var bDiff = Math.abs(domShadow.blur    - node.shadow.blur);
          var sDiff = Math.abs(domShadow.spread  - node.shadow.spread);
          var sColorDist = null;
          var domShadowRgb = parseRgb(domShadow.colorStr);
          if (domShadowRgb) sColorDist = rgbDelta(node.shadow, domShadowRgb);

          if (xDiff > THRESH.shadowOffset || yDiff > THRESH.shadowOffset ||
              bDiff > THRESH.shadowBlur   || sDiff > THRESH.shadowSpread  ||
              (sColorDist !== null && sColorDist > THRESH.color)) {
            result.shadowMismatches.push({
              selector: sel, name: node.name,
              expectedOffsetX: node.shadow.offsetX, expectedOffsetY: node.shadow.offsetY,
              expectedBlur: node.shadow.blur, expectedSpread: node.shadow.spread,
              expectedColor: 'rgb(' + node.shadow.r + ',' + node.shadow.g + ',' + node.shadow.b + ')',
              actualOffsetX: domShadow.offsetX,   actualOffsetY: domShadow.offsetY,
              actualBlur:    domShadow.blur,       actualSpread:  domShadow.spread,
              actualColor:   domShadow.colorStr || 'unknown',
              colorDelta:    sColorDist !== null ? Math.round(sColorDist) : null,
              reason: 'values-differ',
            });
          }
        }
      }
    }

    // Opacity — only compared when Figma explicitly sets opacity < 100%.
    if (node.opacity != null && node.opacity < 0.99) {
      var domOp = parseFloat(cs.opacity);
      if (!isNaN(domOp) && Math.abs(domOp - node.opacity) > THRESH.opacity) {
        result.opacityMismatches.push({
          selector: sel, name: node.name,
          expected: node.opacity, actual: domOp,
        });
      }
    }

    // Text content — only when Figma characters string is present.
    if (node.characters) {
      var domText   = (el.textContent || '').trim().replace(/\\s+/g, ' ');
      var figmaText = node.characters.replace(/\\s+/g, ' ');
      if (domText !== figmaText) {
        result.textMismatches.push({
          selector: sel, name: node.name,
          expected: figmaText, actual: domText,
        });
      }
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
 * @param {object|null} figmaData  - { tokens, components, nodes, frame } from figma-adapter
 * @returns {Promise<object[]>} Array of design fidelity finding objects
 */
export async function analyzeDesignFidelity(browser, url, figmaData) {
  if (!figmaData) return [];

  const findings = [];

  try {
    await browser.navigate(url);
    await browser.waitFor({ state: 'networkidle' }).catch(() => {});
    await new Promise(r => setTimeout(r, 400));
  } catch {
    return findings;
  }

  const thresholds = {
    color:         COLOR_THRESHOLD,
    spacing:       SPACING_THRESHOLD,
    font:          FONT_THRESHOLD,
    radius:        RADIUS_THRESHOLD,
    bounds:        BOUNDS_TOLERANCE,
    positionDrift: POSITION_DRIFT_THRESHOLD,
    opacity:       OPACITY_THRESHOLD,
    letterSpacing: LETTER_SPACING_THRESHOLD,
    borderWeight:  BORDER_WEIGHT_THRESHOLD,
    shadowBlur:    SHADOW_BLUR_THRESHOLD,
    shadowOffset:  SHADOW_OFFSET_THRESHOLD,
    shadowSpread:  SHADOW_SPREAD_THRESHOLD,
  };

  let result;
  try {
    const script = buildFidelityScript(figmaData, thresholds);
    const raw    = await browser.evaluate(script);
    result = parseJson(raw);
  } catch (err) {
    logger.warn(`[ARGUS] design-fidelity: comparison script failed for ${url}: ${err.message}`);
    return findings;
  }
  if (!result) return findings;

  const {
    tokenMismatches      = [],
    missingComponents    = [],
    colorMismatches      = [],
    typographyMismatches = [],
    spacingMismatches    = [],
    radiusMismatches     = [],
    boundsOverflows      = [],
    positionDrifts       = [],
    strokeMismatches     = [],
    shadowMismatches     = [],
    opacityMismatches    = [],
    gapMismatches        = [],
    textMismatches       = [],
  } = result;

  for (const { token, expected, actual } of tokenMismatches) {
    findings.push({
      type: 'design_token_mismatch', token, expected, actual,
      message:  `Design token mismatch: "${token}" is "${actual}" but Figma specifies "${expected}"`,
      severity: 'warning', url,
    });
  }

  for (const { name, selector } of missingComponents) {
    findings.push({
      type: 'design_component_missing', component: name, selector,
      message:  `Figma component "${name}" (selector: "${selector}") not found in DOM`,
      severity: 'warning', url,
    });
  }

  for (const { selector, name, property, expected, actual, delta } of colorMismatches) {
    findings.push({
      type: 'design_color_mismatch', selector, component: name,
      property, expected, actual, delta,
      message:  `Color mismatch on "${name}" (${selector}): ${property} is "${actual}" but Figma specifies "${expected}" (RGB delta: ${delta})`,
      severity: 'warning', url,
    });
  }

  for (const { selector, name, property, expected, actual } of typographyMismatches) {
    const unit = (property === 'fontSize' || property === 'lineHeight' || property === 'letterSpacing') ? 'px' : '';
    findings.push({
      type: 'design_typography_mismatch', selector, component: name,
      property, expected, actual,
      message:  `Typography mismatch on "${name}" (${selector}): ${property} is ${actual}${unit} but Figma specifies ${expected}${unit}`,
      severity: 'warning', url,
    });
  }

  for (const { selector, name, property, expected, actual } of spacingMismatches) {
    findings.push({
      type: 'design_spacing_mismatch', selector, component: name,
      property, expected, actual,
      message:  `Spacing mismatch on "${name}" (${selector}): ${property} is ${actual}px but Figma specifies ${expected}px`,
      severity: 'warning', url,
    });
  }

  for (const { selector, name, corner, expected, actual } of radiusMismatches) {
    const cornerLabel = corner === 'all' ? '' : ` (${corner})`;
    findings.push({
      type: 'design_radius_mismatch', selector, component: name,
      corner, expected, actual,
      message:  `Corner radius mismatch on "${name}" (${selector})${cornerLabel}: border-radius is ${actual}px but Figma specifies ${expected}px`,
      severity: 'warning', url,
    });
  }

  for (const { selector, name, expectedWidth, expectedHeight, actualWidth, actualHeight } of boundsOverflows) {
    findings.push({
      type: 'design_bounds_overflow', selector, component: name,
      expectedWidth, expectedHeight, actualWidth, actualHeight,
      message:  `Bounds overflow on "${name}" (${selector}): element is ${actualWidth}×${actualHeight}px but Figma specifies ${expectedWidth}×${expectedHeight}px`,
      severity: 'warning', url,
    });
  }

  for (const { selector, name, expectedX, expectedY, actualX, actualY, driftX, driftY } of positionDrifts) {
    findings.push({
      type: 'design_position_drift', selector, component: name,
      expectedX, expectedY, actualX, actualY, driftX, driftY,
      message:  `Position drift on "${name}" (${selector}): element is at (${actualX},${actualY}) but Figma specifies (${expectedX},${expectedY}) — drift (${driftX}px, ${driftY}px)`,
      severity: 'warning', url,
    });
  }

  for (const { selector, name, expectedColor, actualColor, colorDelta, expectedWeight, actualWeight } of strokeMismatches) {
    findings.push({
      type: 'design_stroke_mismatch', selector, component: name,
      expectedColor, actualColor, colorDelta, expectedWeight, actualWeight,
      message:  `Stroke mismatch on "${name}" (${selector}): border is ${actualWeight}px "${actualColor}" but Figma specifies ${expectedWeight}px "${expectedColor}"`,
      severity: 'warning', url,
    });
  }

  for (const { selector, name, expectedOffsetX, expectedOffsetY, expectedBlur, expectedSpread, expectedColor, actualOffsetX, actualOffsetY, actualBlur, actualSpread, actualColor, colorDelta, reason } of shadowMismatches) {
    const desc = reason === 'no-shadow'
      ? 'no box-shadow in DOM'
      : `box-shadow is ${actualOffsetX}px ${actualOffsetY}px blur:${actualBlur}px spread:${actualSpread}px color:${actualColor}`;
    findings.push({
      type: 'design_shadow_mismatch', selector, component: name,
      expectedOffsetX, expectedOffsetY, expectedBlur, expectedSpread, expectedColor,
      actualOffsetX, actualOffsetY, actualBlur, actualSpread, actualColor, colorDelta,
      message:  `Shadow mismatch on "${name}" (${selector}): ${desc} but Figma specifies ${expectedOffsetX}px ${expectedOffsetY}px blur:${expectedBlur}px spread:${expectedSpread}px color:${expectedColor}`,
      severity: 'warning', url,
    });
  }

  for (const { selector, name, expected, actual } of opacityMismatches) {
    findings.push({
      type: 'design_opacity_mismatch', selector, component: name,
      expected, actual,
      message:  `Opacity mismatch on "${name}" (${selector}): opacity is ${actual} but Figma specifies ${expected}`,
      severity: 'warning', url,
    });
  }

  for (const { selector, name, property, expected, actual } of gapMismatches) {
    findings.push({
      type: 'design_gap_mismatch', selector, component: name,
      property, expected, actual,
      message:  `Gap mismatch on "${name}" (${selector}): ${property} is ${actual}px but Figma specifies ${expected}px`,
      severity: 'warning', url,
    });
  }

  for (const { selector, name, expected, actual } of textMismatches) {
    findings.push({
      type: 'design_text_mismatch', selector, component: name,
      expected, actual,
      message:  `Text content mismatch on "${name}" (${selector}): DOM text is "${actual}" but Figma specifies "${expected}"`,
      severity: 'warning', url,
    });
  }

  // design_fidelity_summary — always emitted when figmaData is present
  findings.push({
    type:                 'design_fidelity_summary',
    tokenMismatches:      tokenMismatches.length,
    missingComponents:    missingComponents.length,
    colorMismatches:      colorMismatches.length,
    typographyMismatches: typographyMismatches.length,
    spacingMismatches:    spacingMismatches.length,
    radiusMismatches:     radiusMismatches.length,
    boundsOverflows:      boundsOverflows.length,
    positionDrifts:       positionDrifts.length,
    strokeMismatches:     strokeMismatches.length,
    shadowMismatches:     shadowMismatches.length,
    opacityMismatches:    opacityMismatches.length,
    gapMismatches:        gapMismatches.length,
    textMismatches:       textMismatches.length,
    frameName:            figmaData.frame?.name ?? '',
    message: [
      `Design fidelity:`,
      `${tokenMismatches.length} token,`,
      `${missingComponents.length} missing component,`,
      `${colorMismatches.length} color,`,
      `${typographyMismatches.length} typography,`,
      `${spacingMismatches.length} spacing,`,
      `${radiusMismatches.length} radius,`,
      `${boundsOverflows.length} bounds,`,
      `${positionDrifts.length} position,`,
      `${strokeMismatches.length} stroke,`,
      `${shadowMismatches.length} shadow,`,
      `${opacityMismatches.length} opacity,`,
      `${gapMismatches.length} gap,`,
      `${textMismatches.length} text mismatch(es)`,
    ].join(' '),
    severity: 'info',
    url,
  });

  return findings;
}

// ── Self-registration ─────────────────────────────────────────────────────────
registerExpensive({
  name: 'design-fidelity',
  analyze: (browser, url, route) => {
    if (!route?.figmaData) return [];
    return analyzeDesignFidelity(browser, url, route.figmaData);
  },
});
