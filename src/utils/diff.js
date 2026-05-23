/**
 * ARGUS Diff Utilities
 *
 * Pixel-level screenshot comparison using pixelmatch + pngjs.
 * Also provides DOM structural diff utilities.
 */

import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import fs from 'fs';
// Import shared URL normalizer so diffNetworkRequests uses the same ID-collapsing
// strategy as analyzeApiFrequency — previously each module had its own private normalizer,
// causing the same endpoint to be keyed differently in frequency vs diff analysis.
import { normalizeApiUrl } from './api-frequency.js';
import { childLogger } from './logger.js';

const logger = childLogger('diff');

/**
 * Compare two screenshot files pixel-by-pixel.
 *
 * @param {string} pathA - Absolute path to first screenshot (PNG)
 * @param {string} pathB - Absolute path to second screenshot (PNG)
 * @param {string} diffOutputPath - Where to write the diff overlay image
 * @param {number} threshold - Pixel sensitivity 0–1 (default 0.1)
 * @returns {{ diffPixels: number, diffPercent: number, totalPixels: number }}
 */
export async function compareScreenshots(pathA, pathB, diffOutputPath, threshold = 0.1) {
  // Wrap file I/O in try/catch — readFileSync throws on missing/invalid files,
  // PNG.sync.read throws on corrupt data; both would crash the entire report pipeline.
  let imgA, imgB;
  try {
    imgA = PNG.sync.read(fs.readFileSync(pathA));
    imgB = PNG.sync.read(fs.readFileSync(pathB));
  } catch (err) {
    throw new Error(`compareScreenshots: failed to read screenshot files — ${err.message} (pathA: ${pathA}, pathB: ${pathB})`);
  }

  // Ensure same dimensions — use the smaller of the two
  const width = Math.min(imgA.width, imgB.width);
  const height = Math.min(imgA.height, imgB.height);

  if (width === 0 || height === 0) {
    throw new Error(`compareScreenshots: one or both screenshots have zero dimensions (${imgA.width}×${imgA.height} vs ${imgB.width}×${imgB.height}) — screenshot capture likely failed`);
  }

  // Crop both images to matching dimensions
  const croppedA = cropPNG(imgA, width, height);
  const croppedB = cropPNG(imgB, width, height);

  const diff = new PNG({ width, height });

  const diffPixels = pixelmatch(
    croppedA.data,
    croppedB.data,
    diff.data,
    width,
    height,
    { threshold }
  );

  // Don't let a bad output path crash the report — diff images are optional visuals.
  try {
    fs.writeFileSync(diffOutputPath, PNG.sync.write(diff));
  } catch (err) {
    logger.warn(`[ARGUS] compareScreenshots: could not write diff image to ${diffOutputPath} — ${err.message}`);
  }

  const totalPixels = width * height;
  // Guard against division by zero if both images are 0×0 pixels.
  const diffPercent = totalPixels > 0 ? (diffPixels / totalPixels) * 100 : 0;

  return { diffPixels, diffPercent, totalPixels, width, height };
}

/**
 * Crop a PNG object to the given width/height (top-left origin).
 * @param {PNG} png
 * @param {number} width
 * @param {number} height
 * @returns {PNG}
 */
function cropPNG(png, width, height) {
  if (png.width === width && png.height === height) return png;
  const cropped = new PNG({ width, height });
  PNG.bitblt(png, cropped, 0, 0, width, height, 0, 0);
  return cropped;
}

/**
 * Perform a structural diff on two serialized DOM trees.
 * Returns an array of difference objects.
 *
 * @param {string} domA - Serialized DOM string from take_snapshot (env A)
 * @param {string} domB - Serialized DOM string from take_snapshot (env B)
 * @returns {object[]} Array of diff entries
 */
export function diffDomSnapshots(domA, domB) {
  if (typeof domA !== 'string' || typeof domB !== 'string') {
    logger.warn('[ARGUS] diffDomSnapshots: non-string argument — one or both DOM snapshots may be missing');
    return [];
  }
  const diffs = [];

  // Parse tag/attribute counts as a lightweight structural fingerprint
  const countTags = (dom) => {
    const counts = {};
    const regex = /<([a-zA-Z][a-zA-Z0-9-]*)[^>]*>/g;
    let m;
    while ((m = regex.exec(dom)) !== null) {
      const tag = m[1].toLowerCase();
      counts[tag] = (counts[tag] ?? 0) + 1;
    }
    return counts;
  };

  const tagsA = countTags(domA);
  const tagsB = countTags(domB);
  const allTags = new Set([...Object.keys(tagsA), ...Object.keys(tagsB)]);

  for (const tag of allTags) {
    const countA = tagsA[tag] ?? 0;
    const countB = tagsB[tag] ?? 0;
    if (countA !== countB) {
      diffs.push({
        type: 'element_count_change',
        tag,
        countA,
        countB,
        delta: countB - countA,
        description: `<${tag}>: ${countA} in dev → ${countB} in staging (delta: ${countB - countA > 0 ? '+' : ''}${countB - countA})`,
      });
    }
  }

  return diffs;
}

/**
 * Diff two arrays of network requests by URL + status.
 * Returns added (in B not in A), removed (in A not in B), and changed (same URL, different status).
 *
 * @param {object[]} reqsA - Network requests from env A
 * @param {object[]} reqsB - Network requests from env B
 * @returns {{ added: object[], removed: object[], changed: object[] }}
 */
export function diffNetworkRequests(reqsA, reqsB) {
  // Use the shared normalizeApiUrl (from api-frequency.js) which collapses numeric
  // and UUID path segments to /{id}. The previous private normalizeUrl didn't do this,
  // so /api/123 and /api/456 were treated as different endpoints in diffs but the same
  // endpoint in frequency analysis — inconsistent findings across modules.
  // Object.fromEntries last-write-wins — if two requests normalize to the same key
  // (e.g. /api/123 and /api/456 → /api/{id}), the first request object is silently dropped.
  // Use first-entry-wins so the earlier request (usually the most representative) is kept.
  function buildRequestMap(reqs) {
    const map = {};
    for (const r of (reqs ?? [])) {
      const key = normalizeApiUrl(r.url ?? '');
      if (!Object.prototype.hasOwnProperty.call(map, key)) map[key] = r;
    }
    return map;
  }
  const mapA = buildRequestMap(reqsA);
  const mapB = buildRequestMap(reqsB);

  const urlsA = new Set(Object.keys(mapA));
  const urlsB = new Set(Object.keys(mapB));

  const added = [...urlsB].filter(u => !urlsA.has(u)).map(u => mapB[u]);
  const removed = [...urlsA].filter(u => !urlsB.has(u)).map(u => mapA[u]);
  const changed = [...urlsA]
    .filter(u => urlsB.has(u) && mapA[u].status !== mapB[u].status)
    .map(u => ({ url: u, statusA: mapA[u].status, statusB: mapB[u].status }));

  return { added, removed, changed };
}

/**
 * Diff console messages: find errors in B (staging) that are not in A (dev).
 * These are new regressions introduced in staging.
 *
 * @param {object[]} msgsA
 * @param {object[]} msgsB
 * @returns {object[]} New errors in B not present in A
 */
export function diffConsoleMessages(msgsA, msgsB) {
  const textSetA = new Set((msgsA ?? []).filter(m => m.level === 'error').map(m => m.text ?? m.message));
  return (msgsB ?? []).filter(m => m.level === 'error' && !textSetA.has(m.text ?? m.message));
}
