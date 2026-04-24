/**
 * Argus D7.3 — Parallel route crawling: chunkArray utility.
 * Exported separately so test-harness/validate.js can exercise it without
 * importing crawl-and-report.js (which has heavyweight module-level side effects).
 */

/**
 * Split arr into at most n non-empty chunks of roughly equal size.
 *
 * Uses ceiling division so earlier chunks are at most 1 element larger than
 * later ones. If arr.length < n only arr.length chunks are returned (no empty
 * chunks). If arr is empty, returns [].
 *
 * @param {Array}  arr - Source array (not mutated)
 * @param {number} n   - Target number of chunks (must be > 0)
 * @returns {Array[]}
 */
export function chunkArray(arr, n) {
  if (n <= 0) throw new RangeError('chunkArray: n must be > 0');
  if (arr.length === 0) return [];
  const size = Math.ceil(arr.length / Math.min(n, arr.length));
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}
