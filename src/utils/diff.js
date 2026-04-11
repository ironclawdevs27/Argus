/**
 * ARGUS Diff Utilities
 *
 * Pixel-level screenshot comparison using pixelmatch + pngjs.
 * Also provides DOM structural diff utilities.
 */

import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import fs from 'fs';

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
  const imgA = PNG.sync.read(fs.readFileSync(pathA));
  const imgB = PNG.sync.read(fs.readFileSync(pathB));

  // Ensure same dimensions — use the smaller of the two
  const width = Math.min(imgA.width, imgB.width);
  const height = Math.min(imgA.height, imgB.height);

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

  fs.writeFileSync(diffOutputPath, PNG.sync.write(diff));

  const totalPixels = width * height;
  const diffPercent = (diffPixels / totalPixels) * 100;

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
  const mapA = Object.fromEntries((reqsA ?? []).map(r => [normalizeUrl(r.url), r]));
  const mapB = Object.fromEntries((reqsB ?? []).map(r => [normalizeUrl(r.url), r]));

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

/**
 * Strip query strings and trailing slashes for URL comparison.
 */
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.replace(/\/$/, '');
  } catch {
    return url.replace(/[?#].*/, '').replace(/\/$/, '');
  }
}
