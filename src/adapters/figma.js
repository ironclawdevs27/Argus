/**
 * Figma REST adapter — pulls design tokens and component specs from a Figma frame.
 *
 * Requires FIGMA_API_TOKEN env var (Personal Access Token from figma.com/settings).
 * Returns null gracefully when the token is absent or the URL is unparseable, so
 * callers can skip design-fidelity analysis without crashing.
 *
 * Supported Figma URL formats:
 *   https://www.figma.com/file/<fileKey>/Name?node-id=42%3A0
 *   https://www.figma.com/design/<fileKey>/Name?node-id=42-0
 */

import { childLogger } from '../utils/logger.js';

const logger = childLogger('figma-adapter');

const FIGMA_API = 'https://api.figma.com/v1';

// ── URL parsing ───────────────────────────────────────────────────────────────

/**
 * Parse fileKey and nodeId from a Figma frame URL.
 * Returns null if the URL is not a recognizable Figma frame URL.
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

// ── Figma response parser ─────────────────────────────────────────────────────

/**
 * Parse a Figma /files/:key/nodes response into the Argus design-fidelity format.
 *
 * Returns:
 * {
 *   tokens:     { '--css-var-name': 'value', ... }   — CSS-variable-style design tokens
 *   components: [{ name, selector }]                 — component presence requirements
 *   frame:      { name, width, height }               — frame metadata
 * }
 */
function parseFigmaNodes(data, nodeId) {
  const nodeKey  = nodeId.replace(':', '-');
  const nodeData = data?.nodes?.[nodeKey] ?? data?.nodes?.[nodeId];
  if (!nodeData?.document) return null;

  const doc    = nodeData.document;
  const tokens = {};
  const components = [];

  // Walk the node tree to extract fills (colors) and text styles
  function walk(node) {
    if (!node) return;

    // Extract solid fill colors as CSS-style tokens using the node name as key
    if (node.fills?.length > 0) {
      for (const fill of node.fills) {
        if (fill.type === 'SOLID' && fill.color) {
          const { r, g, b } = fill.color;
          const hex = '#' +
            Math.round(r * 255).toString(16).padStart(2, '0') +
            Math.round(g * 255).toString(16).padStart(2, '0') +
            Math.round(b * 255).toString(16).padStart(2, '0');
          const varName = '--figma-' + node.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
          tokens[varName] = hex;
        }
      }
    }

    // Extract text style font sizes
    if (node.type === 'TEXT' && node.style?.fontSize) {
      const varName = '--figma-font-' + node.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      tokens[varName] = `${node.style.fontSize}px`;
    }

    // Record COMPONENT or INSTANCE nodes as expected DOM components
    if (node.type === 'COMPONENT' || node.type === 'INSTANCE') {
      const selector = '.' + node.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      components.push({ name: node.name, selector });
    }

    for (const child of (node.children ?? [])) walk(child);
  }

  walk(doc);

  return {
    tokens,
    components,
    frame: { name: doc.name ?? '', width: doc.absoluteBoundingBox?.width ?? 0, height: doc.absoluteBoundingBox?.height ?? 0 },
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch design tokens and component specs for a Figma frame URL.
 *
 * Returns null when:
 *   - FIGMA_API_TOKEN is not set
 *   - The URL is not a valid Figma frame URL
 *   - The Figma API returns an error (logged at warn level)
 *
 * @param {string} figmaFrameUrl - Figma file/design URL with node-id param
 * @returns {Promise<object|null>} { tokens, components, frame } or null
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
  const encodedNodeId = nodeId.replace(':', '-');
  const apiUrl = `${FIGMA_API}/files/${fileKey}/nodes?ids=${encodedNodeId}`;

  try {
    const res = await fetch(apiUrl, {
      headers: { 'X-Figma-Token': token },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      logger.warn(`[ARGUS] figma-adapter: Figma API ${res.status} for ${figmaFrameUrl}`);
      return null;
    }

    const data = await res.json();
    const result = parseFigmaNodes(data, nodeId);

    if (!result) {
      logger.warn(`[ARGUS] figma-adapter: no node data for nodeId "${nodeId}" in ${figmaFrameUrl}`);
      return null;
    }

    logger.info(`[ARGUS] figma-adapter: fetched ${Object.keys(result.tokens).length} tokens, ${result.components.length} components from "${result.frame.name}"`);
    return result;

  } catch (err) {
    logger.warn(`[ARGUS] figma-adapter: fetch failed for ${figmaFrameUrl}: ${err.message}`);
    return null;
  }
}
