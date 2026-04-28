/**
 * Argus v3 Phase B4 — Flakiness detection
 *
 * Each route is crawled twice. Findings present in both runs are "confirmed"
 * (severity unchanged). Findings that appear in only one run are "flaky" —
 * severity is downgraded to 'info' and flaky: true is set so the Slack digest
 * can label them visually. This filters out timing-sensitive false positives
 * (race conditions, GC-dependent heap readings, one-off network blips).
 *
 * Finding key: same scheme as baseline-manager — type::message[:100]::status
 */

function findingKey(finding) {
  // GAP-56: Normalize whitespace before truncating — same finding with minor formatting
  // differences (extra spaces, newlines) between run1 and run2 would produce different
  // keys and be incorrectly classified as flaky.
  const msg = (finding.message ?? '').trim().replace(/\s+/g, ' ').slice(0, 100);
  const status = finding.status != null ? '::' + finding.status : '';
  return `${finding.type}::${msg}${status}`;
}

/**
 * Merge two crawl results for the same route.
 *
 * - Findings present in both runs → confirmed (flaky: false, original severity kept)
 * - Findings present in only one run → flaky (flaky: true, severity → 'info')
 *
 * The returned result uses run2's screenshot and responsiveScreenshots (more recent).
 *
 * @param {object} run1 - First crawl result from crawlRoute + analysis engines
 * @param {object} run2 - Second crawl result for the same route
 * @returns {object} Merged result with confirmed + flaky findings combined
 */
export function mergeRunResults(run1, run2) {
  // GAP-61: Validate inputs — accessing .errors on undefined throws a cryptic TypeError.
  if (!run1 || !Array.isArray(run1.errors)) {
    throw new TypeError('mergeRunResults: run1.errors must be an array');
  }
  if (!run2 || !Array.isArray(run2.errors)) {
    throw new TypeError('mergeRunResults: run2.errors must be an array');
  }

  const keys1 = new Map(run1.errors.map(f => [findingKey(f), f]));
  const keys2 = new Set(run2.errors.map(findingKey));

  const confirmed = [];
  const flaky = [];

  for (const f of run1.errors) {
    if (keys2.has(findingKey(f))) {
      confirmed.push({ ...f, flaky: false });
    } else {
      flaky.push({ ...f, severity: 'info', flaky: true });
    }
  }

  for (const f of run2.errors) {
    const key = findingKey(f);
    if (keys1.has(key)) {
      // GAP-52: Prefer run2's version of confirmed findings — run2 is more recent and
      // may have updated metadata. Replace run1's copy in the confirmed array.
      const idx = confirmed.findIndex(c => findingKey(c) === key);
      if (idx !== -1) confirmed[idx] = { ...f, flaky: false };
    } else {
      flaky.push({ ...f, severity: 'info', flaky: true });
    }
  }

  return {
    ...run2,
    errors: [...confirmed, ...flaky],
    responsiveScreenshots: run2.responsiveScreenshots ?? run1.responsiveScreenshots,
    screenshot: run2.screenshot ?? run1.screenshot,
  };
}
