/**
 * ARGUS Memory Analyzer (v3 Phase B1)
 *
 * Two detection surfaces:
 *   1. Detached DOM nodes — via take_memory_snapshot (saves snapshot to disk, parsed here)
 *      Nodes removed from the live DOM but still referenced in JS are retained
 *      in the V8 heap as "Detached HTMLXxx" objects, causing memory pressure.
 *   2. Heap size growth — via performance.memory across navigate-away + navigate-back
 *      Significant heap growth after a round-trip indicates a per-load leak.
 *
 * Called as a standalone function after crawlRoute, like analyzeResponsive.
 * The function always leaves the browser navigated to the target URL.
 *
 * Note: take_memory_snapshot requires a filePath argument — it writes the V8
 * heap snapshot JSON to disk. We read and parse it, then delete the temp file.
 */

import fs   from 'fs';
import os   from 'os';
import path from 'path';

// ── Thresholds ─────────────────────────────────────────────────────────────────

const DETACHED_NODE_THRESHOLDS = {
  warning:  10,    // > 10 detached nodes → warning
  critical: 100,   // > 100 detached nodes → critical
};

const HEAP_GROWTH_THRESHOLDS = {
  warning:  2 * 1024 * 1024,   // > 2 MB growth → warning
  critical: 10 * 1024 * 1024,  // > 10 MB growth → critical
};

// ── Scripts ────────────────────────────────────────────────────────────────────

/**
 * Reads performance.memory from the page context.
 * Chrome-only non-standard API, always present in Chrome/headless Chrome.
 */
const HEAP_SIZE_SCRIPT = `() => {
  var m = window.performance && window.performance.memory;
  if (!m) return JSON.stringify({ usedJSHeapSize: null });
  return JSON.stringify({
    usedJSHeapSize:  m.usedJSHeapSize,
    totalJSHeapSize: m.totalJSHeapSize,
    jsHeapSizeLimit: m.jsHeapSizeLimit,
  });
}`;

// ── Snapshot Parsing ───────────────────────────────────────────────────────────

/**
 * Walk a flat V8 heap snapshot nodes array and count detached DOM nodes.
 *
 * The nodes array is a flat int array: each record has nodeFields.length entries.
 * The "name" field indexes into the strings table; Chrome serializes detached
 * DOM elements with "Detached " prepended to their class name (e.g.
 * "Detached HTMLDivElement"). If the `detachedness` field is present (Chrome 90+),
 * value 2 = detached — checked as a secondary signal.
 *
 * @param {object} snapshot - Parsed V8 heap snapshot ({ snapshot, nodes, strings })
 * @returns {{ detachedNodeCount: number, totalNodeCount: number|null }}
 */
function parseV8Snapshot(snapshot) {
  const strings    = Array.isArray(snapshot.strings) ? snapshot.strings : [];
  const meta       = snapshot.snapshot?.meta ?? {};
  const nodeFields = Array.isArray(meta.node_fields) ? meta.node_fields : [];

  let detachedCount = 0;
  const nameIdx         = nodeFields.indexOf('name');
  const detachednessIdx = nodeFields.indexOf('detachedness');

  if (Array.isArray(snapshot.nodes) && snapshot.nodes.length > 0 &&
      (nameIdx !== -1 || detachednessIdx !== -1)) {
    const stride = nodeFields.length;
    const nodes  = snapshot.nodes;

    for (let i = 0; i < nodes.length; i += stride) {
      // Primary: "Detached " prefix in node name string (all Chrome versions)
      if (nameIdx !== -1) {
        const strIdx = nodes[i + nameIdx];
        if (strIdx < strings.length && /^Detached /.test(strings[strIdx])) {
          detachedCount++;
          continue;
        }
      }
      // Secondary: detachedness field value 2 = detached (Chrome 90+)
      if (detachednessIdx !== -1 && nodes[i + detachednessIdx] === 2) {
        detachedCount++;
      }
    }
  } else if (strings.length > 0) {
    // Structural fields not found — use string presence as a lower-bound indicator
    detachedCount = strings.filter(s => /^Detached (HTML|SVG|Text|Document)/.test(s)).length;
  }

  return {
    detachedNodeCount: detachedCount,
    totalNodeCount:    snapshot.snapshot?.node_count ?? null,
  };
}

// ── Heap Size Helper ───────────────────────────────────────────────────────────

/**
 * Read usedJSHeapSize from the currently-loaded page via evaluate_script.
 * Returns null if performance.memory is unavailable.
 */
async function getHeapSize(mcp) {
  try {
    const raw    = await mcp.evaluate_script({ function: HEAP_SIZE_SCRIPT });
    const val    = raw?.result ?? raw;
    const parsed = typeof val === 'string' ? JSON.parse(val) : val;
    return typeof parsed?.usedJSHeapSize === 'number' ? parsed.usedJSHeapSize : null;
  } catch {
    return null;
  }
}

// ── Snapshot Capture ───────────────────────────────────────────────────────────

/**
 * Take a V8 heap snapshot, save it to a temp file, parse it, and delete the file.
 * take_memory_snapshot writes the snapshot JSON to disk (filePath is required).
 *
 * @param {object} mcp
 * @returns {Promise<{ detachedNodeCount: number, totalNodeCount: number|null } | null>}
 */
async function captureAndParseSnapshot(mcp) {
  const filePath = path.join(os.tmpdir(), `argus-heap-${Date.now()}.heapsnapshot`);
  try {
    await mcp.take_memory_snapshot({ filePath });

    if (!fs.existsSync(filePath)) {
      console.warn(`[ARGUS] Snapshot file not written at ${filePath}`);
      return null;
    }

    const raw      = fs.readFileSync(filePath, 'utf8');
    const snapshot = JSON.parse(raw);
    return parseV8Snapshot(snapshot);
  } catch (err) {
    console.warn(`[ARGUS] Snapshot capture/parse error: ${err.message}`);
    return null;
  } finally {
    try { fs.unlinkSync(filePath); } catch { /* best-effort cleanup */ }
  }
}

// ── Main Analysis ──────────────────────────────────────────────────────────────

/**
 * Analyse a URL for memory leaks.
 *
 * Detection 1 — Detached DOM nodes (hard, deterministic):
 *   Navigate to url → wait → take_memory_snapshot to disk → parse for "Detached Xxx" nodes.
 *   Detached nodes are DOM elements removed from the live tree but still referenced
 *   in JS (e.g. stashed in a closure, array, or event handler), preventing GC.
 *
 * Detection 2 — Heap growth across navigate-away + back (soft, GC-dependent):
 *   Record baseline heap size → navigate to awayUrl → wait → navigate back → compare.
 *   A growing heap across identical page loads indicates a per-load leak.
 *   Tagged with soft:true so the harness can treat them as non-blocking.
 *
 * The function always ends with the browser on `url`.
 *
 * @param {object} mcp      - MCP tool interface (navigate_page, evaluate_script, take_memory_snapshot)
 * @param {string} url      - URL to analyse
 * @param {string} [awayUrl='about:blank'] - Neutral URL for the navigate-away step
 * @returns {Promise<object[]>} Memory findings (same shape as crawlRoute errors)
 */
export async function analyzeMemory(mcp, url, awayUrl = 'about:blank') {
  const findings = [];

  // ── 1. Navigate to the target page ──────────────────────────────────────────
  try {
    await mcp.navigate_page({ url });
    await new Promise(r => setTimeout(r, 1500)); // let JS run, detached nodes accumulate
  } catch (err) {
    console.warn(`[ARGUS] Memory analysis navigation failed for ${url}: ${err.message}`);
    return findings;
  }

  // ── 2. Detached DOM node detection via heap snapshot ─────────────────────────
  try {
    const parsed = await captureAndParseSnapshot(mcp);

    if (parsed !== null) {
      const { detachedNodeCount: count, totalNodeCount } = parsed;

      if (count > DETACHED_NODE_THRESHOLDS.critical) {
        findings.push({
          type:       'memory_detached_dom_nodes',
          count,
          totalNodes: totalNodeCount,
          message:    `${count} detached DOM node(s) in heap — severe leak (threshold: >${DETACHED_NODE_THRESHOLDS.critical})`,
          severity:   'critical',
          url,
        });
      } else if (count > DETACHED_NODE_THRESHOLDS.warning) {
        findings.push({
          type:       'memory_detached_dom_nodes',
          count,
          totalNodes: totalNodeCount,
          message:    `${count} detached DOM node(s) in heap — probable leak (threshold: >${DETACHED_NODE_THRESHOLDS.warning})`,
          severity:   'warning',
          url,
        });
      }
    }
  } catch (err) {
    console.warn(`[ARGUS] Detached node detection skipped for ${url}: ${err.message}`);
  }

  // ── 3. Heap growth — navigate-away + navigate-back ────────────────────────────
  // GC timing makes this non-deterministic; findings are tagged soft:true.
  try {
    const baseline = await getHeapSize(mcp);

    if (baseline !== null) {
      await mcp.navigate_page({ url: awayUrl });
      await new Promise(r => setTimeout(r, 2000)); // allow GC pass

      await mcp.navigate_page({ url });
      await new Promise(r => setTimeout(r, 1500));

      const post = await getHeapSize(mcp);

      if (post !== null) {
        const growth = post - baseline;

        if (growth > HEAP_GROWTH_THRESHOLDS.critical) {
          findings.push({
            type:          'memory_heap_growth',
            baselineBytes: baseline,
            postBytes:     post,
            growthBytes:   growth,
            message:       `Heap grew ${Math.round(growth / 1024)} KB after navigate-away + back — probable leak (baseline ${Math.round(baseline / 1024)} KB → post ${Math.round(post / 1024)} KB)`,
            severity:      'critical',
            soft:          true,
            url,
          });
        } else if (growth > HEAP_GROWTH_THRESHOLDS.warning) {
          findings.push({
            type:          'memory_heap_growth',
            baselineBytes: baseline,
            postBytes:     post,
            growthBytes:   growth,
            message:       `Heap grew ${Math.round(growth / 1024)} KB after navigate-away + back (baseline ${Math.round(baseline / 1024)} KB → post ${Math.round(post / 1024)} KB)`,
            severity:      'warning',
            soft:          true,
            url,
          });
        }
      }
    }
  } catch (err) {
    console.warn(`[ARGUS] Heap growth check skipped for ${url}: ${err.message}`);
  }

  return findings;
}
