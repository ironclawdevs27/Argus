/**
 * Figma REST adapter — extracts the full design spec from a Figma frame.
 *
 * For each node in the frame tree, extracts:
 *   bounds      — x, y, width, height relative to the frame origin
 *   fill        — primary solid fill color (r,g,b,a — 0-255)
 *   stroke      — border color + weight
 *   typography  — fontSize, fontWeight, lineHeightPx, letterSpacing (TEXT nodes)
 *   spacing     — Auto Layout padding + gap
 *   cornerRadius
 *   shadow      — primary DROP_SHADOW effect
 *   opacity
 *
 * Returns null gracefully when FIGMA_API_TOKEN is absent, the URL is invalid,
 * or the API call fails — callers skip analysis without crashing.
 *
 * Supported Figma URL formats:
 *   https://www.figma.com/file/<fileKey>/Name?node-id=42%3A0
 *   https://www.figma.com/design/<fileKey>/Name?node-id=42-0
 *
 * Requires env: FIGMA_API_TOKEN (Personal Access Token from figma.com/settings)
 */

import { childLogger } from '../utils/logger.js';

const logger = childLogger('figma-adapter');

const FIGMA_API = 'https://api.figma.com/v1';

// Node types that carry no useful layout/style data — skip during tree walk
const SKIP_TYPES = new Set(['VECTOR', 'STAR', 'LINE', 'BOOLEAN_OPERATION', 'REGULAR_POLYGON']);

// ── URL parsing ───────────────────────────────────────────────────────────────

/**
 * Parse fileKey and nodeId from a Figma frame URL.
 * Returns null if the URL is not a recognisable Figma frame URL.
 */
export function parseFigmaUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const fileMatch = url.match(/figma\.com\/(?:file|design)\/([A-Za-z0-9]+)/);
  const nodeMatch = url.match(/node-id=([^&]+)/);
  if (!fileMatch) return null;
  const fileKey = fileMatch[1];
  const rawNode = nodeMatch?.[1];
  if (!rawNode) return null;
  // node-id can be URL-encoded "42%3A0" or dash-separated "42-0" — normalise to "42:0"
  const nodeId = decodeURIComponent(rawNode).replace('-', ':');
  return { fileKey, nodeId };
}

// ── Selector inference ────────────────────────────────────────────────────────

/**
 * Infer a prioritised list of CSS selector candidates from a Figma layer name.
 * The analyzer tries each in order and uses the first that matches a DOM element.
 *
 * Priority:
 *   1. Explicit selector — if the name starts with #, ., or [ use it verbatim
 *   2. data-testid attribute (slug form)
 *   3. aria-label attribute (raw name)
 *   4. ID selector (slug form)
 *   5. Class selector (BEM slug: spaces→-, /→--)
 *
 * Examples:
 *   "Button / Primary" → [data-testid="button--primary"], [aria-label="Button / Primary"], #button--primary, .button--primary
 *   "#hero"            → ["#hero"]   (explicit — used verbatim)
 *   ".card"            → [".card"]  (explicit)
 */
function inferSelectors(node) {
  const name = node.name;

  // Designer typed an explicit selector — honour it and skip inference
  if (name.startsWith('#') || name.startsWith('.') || name.startsWith('[')) {
    return [name];
  }

  const slug = name
    .toLowerCase()
    .replace(/\s*\/\s*/g, '--')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!slug) return [];

  return [
    `[data-testid="${slug}"]`,
    `[aria-label="${name}"]`,
    `#${slug}`,
    `.${slug}`,
  ];
}

// ── Node extraction ───────────────────────────────────────────────────────────

/**
 * Extract all design properties from a single Figma node into a flat object.
 * All color channels are 0-255. Bounds are relative to the frame origin.
 */
function extractNode(node, frameX, frameY) {
  if (!node) return null;

  const selectors = inferSelectors(node);
  const result = {
    id:        node.id,
    name:      node.name,
    type:      node.type,
    selectors: selectors,       // ordered candidates — analyzer tries each until one matches
    selector:  selectors[0] ?? `.${node.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    opacity:   node.opacity ?? 1,

    // Populated below
    bounds:       null,
    fill:         null,
    stroke:       null,
    typography:   null,
    spacing:      null,
    cornerRadius: null,
    shadow:       null,
  };

  // Bounds — relative to frame origin so they map to viewport coords when the
  // browser viewport matches the frame dimensions.
  if (node.absoluteBoundingBox) {
    result.bounds = {
      x:      node.absoluteBoundingBox.x - frameX,
      y:      node.absoluteBoundingBox.y - frameY,
      width:  node.absoluteBoundingBox.width,
      height: node.absoluteBoundingBox.height,
    };
  }

  // Primary solid fill (first visible solid fill)
  for (const fill of (node.fills ?? [])) {
    if (fill.type === 'SOLID' && fill.color && fill.visible !== false) {
      result.fill = {
        r: Math.round(fill.color.r * 255),
        g: Math.round(fill.color.g * 255),
        b: Math.round(fill.color.b * 255),
        a: Math.round((fill.opacity ?? 1) * 255),
      };
      break;
    }
  }

  // Primary stroke
  for (const stroke of (node.strokes ?? [])) {
    if (stroke.type === 'SOLID' && stroke.color && stroke.visible !== false) {
      result.stroke = {
        r:      Math.round(stroke.color.r * 255),
        g:      Math.round(stroke.color.g * 255),
        b:      Math.round(stroke.color.b * 255),
        a:      Math.round((stroke.opacity ?? 1) * 255),
        weight: node.strokeWeight ?? 1,
      };
      break;
    }
  }

  // Typography (TEXT nodes only)
  if (node.type === 'TEXT' && node.style) {
    const s = node.style;
    result.typography = {
      fontFamily:    s.fontFamily    ?? null,
      fontSize:      s.fontSize      ?? null,
      fontWeight:    s.fontWeight    ?? null,
      lineHeightPx:  s.lineHeightPx  ?? null,
      letterSpacing: s.letterSpacing ?? 0,
    };
  }

  // Text content — actual Figma copy; compared against DOM textContent
  if (node.type === 'TEXT' && typeof node.characters === 'string') {
    result.characters = node.characters.trim() || null;
  }

  // Auto Layout spacing — maps to CSS padding + gap.
  // layoutMode ('HORIZONTAL'|'VERTICAL') lets the analyzer pick columnGap vs rowGap.
  if (node.layoutMode && node.layoutMode !== 'NONE') {
    result.spacing = {
      paddingTop:    node.paddingTop    ?? 0,
      paddingRight:  node.paddingRight  ?? 0,
      paddingBottom: node.paddingBottom ?? 0,
      paddingLeft:   node.paddingLeft   ?? 0,
      gap:           node.itemSpacing   ?? 0,
      layoutMode:    node.layoutMode,
    };
  }

  // Corner radius — uniform number or per-corner object.
  // Figma rectangleCornerRadii = [topLeft, topRight, bottomRight, bottomLeft].
  if (node.cornerRadius != null) {
    result.cornerRadius = node.cornerRadius;  // uniform
  } else if (node.rectangleCornerRadii) {
    const [tl, tr, br, bl] = node.rectangleCornerRadii;
    // Collapse to a single number if all corners are equal (avoids noise in findings)
    result.cornerRadius = (tl === tr && tr === br && br === bl)
      ? tl
      : { topLeft: tl, topRight: tr, bottomRight: br, bottomLeft: bl };
  }

  // Primary DROP_SHADOW effect
  for (const eff of (node.effects ?? [])) {
    if (eff.type === 'DROP_SHADOW' && eff.visible !== false) {
      result.shadow = {
        offsetX: eff.offset?.x ?? 0,
        offsetY: eff.offset?.y ?? 0,
        blur:    eff.radius    ?? 0,
        spread:  eff.spread    ?? 0,
        r:       Math.round((eff.color?.r ?? 0) * 255),
        g:       Math.round((eff.color?.g ?? 0) * 255),
        b:       Math.round((eff.color?.b ?? 0) * 255),
        a:       Math.round((eff.color?.a ?? 0.25) * 255),
      };
      break;
    }
  }

  return result;
}

// ── Tree walker ───────────────────────────────────────────────────────────────

function parseFigmaNodes(data, nodeId) {
  const nodeKey  = nodeId.replace(':', '-');
  const nodeData = data?.nodes?.[nodeKey] ?? data?.nodes?.[nodeId];
  if (!nodeData?.document) return null;

  const doc    = nodeData.document;
  const frameX = doc.absoluteBoundingBox?.x ?? 0;
  const frameY = doc.absoluteBoundingBox?.y ?? 0;

  const nodes      = [];
  const tokens     = {}; // legacy CSS-var format
  const components = []; // legacy component presence format

  function walk(node) {
    if (!node || SKIP_TYPES.has(node.type)) return;

    const extracted = extractNode(node, frameX, frameY);
    if (extracted) {
      nodes.push(extracted);

      // Build legacy tokens map for backward compat
      if (extracted.fill) {
        const hex = '#' +
          extracted.fill.r.toString(16).padStart(2, '0') +
          extracted.fill.g.toString(16).padStart(2, '0') +
          extracted.fill.b.toString(16).padStart(2, '0');
        tokens[`--figma-${extracted.selector.slice(1)}-fill`] = hex;
      }

      // Legacy component presence list
      if (node.type === 'COMPONENT' || node.type === 'INSTANCE') {
        components.push({ name: node.name, selector: extracted.selector });
      }
    }

    for (const child of (node.children ?? [])) walk(child);
  }

  walk(doc);

  return {
    nodes,
    frame: {
      name:   doc.name ?? '',
      x:      frameX,
      y:      frameY,
      width:  doc.absoluteBoundingBox?.width  ?? 0,
      height: doc.absoluteBoundingBox?.height ?? 0,
    },
    // Legacy fields — still consumed by backward-compat token comparison path
    tokens,
    components,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch the full design spec for a Figma frame URL.
 *
 * Returns null when FIGMA_API_TOKEN is unset, the URL is unparseable,
 * or the Figma API returns an error. All errors are logged at warn level.
 *
 * @param {string} figmaFrameUrl
 * @returns {Promise<{nodes, frame, tokens, components}|null>}
 */
export async function getFigmaFrame(figmaFrameUrl) {
  const token = process.env.FIGMA_API_TOKEN;
  if (!token) {
    logger.debug('[ARGUS] figma-adapter: FIGMA_API_TOKEN not set — skipping design fidelity fetch');
    return null;
  }

  const parsed = parseFigmaUrl(figmaFrameUrl);
  if (!parsed) {
    logger.warn(`[ARGUS] figma-adapter: cannot parse Figma URL: ${figmaFrameUrl}`);
    return null;
  }

  const { fileKey, nodeId } = parsed;
  const encodedId = nodeId.replace(':', '-');
  const apiUrl    = `${FIGMA_API}/files/${fileKey}/nodes?ids=${encodedId}&geometry=paths`;

  try {
    const res = await fetch(apiUrl, {
      headers: { 'X-Figma-Token': token },
      signal:  AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      logger.warn(`[ARGUS] figma-adapter: Figma API ${res.status} for ${figmaFrameUrl}`);
      return null;
    }

    const data   = await res.json();
    const result = parseFigmaNodes(data, nodeId);

    if (!result) {
      logger.warn(`[ARGUS] figma-adapter: no node data for nodeId "${nodeId}" in ${figmaFrameUrl}`);
      return null;
    }

    logger.info(
      `[ARGUS] figma-adapter: extracted ${result.nodes.length} node(s) from "${result.frame.name}" ` +
      `(${result.frame.width}×${result.frame.height})`
    );
    return result;

  } catch (err) {
    logger.warn(`[ARGUS] figma-adapter: fetch failed for ${figmaFrameUrl}: ${err.message}`);
    return null;
  }
}
