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
  // GAP-57: Validate inputs — arr.length throws on undefined; non-integer n produces
  // fractional chunk sizes that silently skip elements or create unexpected extra chunks.
  if (!Array.isArray(arr)) throw new TypeError('chunkArray: arr must be an array');
  if (!Number.isInteger(n) || n <= 0) throw new RangeError('chunkArray: n must be a positive integer');
  if (arr.length === 0) return [];
  const size = Math.ceil(arr.length / Math.min(n, arr.length));
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}
