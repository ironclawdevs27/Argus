/**
 * Shared API frequency analysis utilities.
 *
 * Previously duplicated in crawl-and-report.js and env-comparison.js.
 * Single source of truth — import from here in both orchestrators.
 */

/**
 * Detect API endpoints called more than once in a single page load.
 * Groups by normalized URL + method. Flags duplicates with severity based
 * on call count and whether it looks like an accidental double-fetch.
 *
 * @param {object[]} networkReqs - All network requests from list_network_requests
 * @param {string} pageUrl - Page URL (for error reporting)
 * @returns {object[]} Bug entries for duplicate/excessive API calls
 */
export function analyzeApiFrequency(networkReqs, pageUrl) {
  const bugs = [];

  // Only examine XHR/fetch calls — filter out static assets
  const staticExtensions = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map|webp|avif)(\?|$)/i;
  const apiCalls = networkReqs.filter(req => {
    const u = req.url ?? '';
    if (staticExtensions.test(u)) return false;
    // Include if it has /api/, /graphql, /v1/, /v2/, or is XHR/fetch type
    return (
      /\/(api|graphql|rest|v\d+|_next\/data|trpc)\//i.test(u) ||
      req.resourceType === 'XHR' ||
      req.resourceType === 'Fetch' ||
      req.initiatorType === 'xmlhttprequest' ||
      req.initiatorType === 'fetch'
    );
  });

  // Group by method + normalized URL (strip query string for grouping key,
  // but keep it in the report so you can see the exact calls made)
  const groups = {};
  for (const req of apiCalls) {
    const method = (req.method ?? 'GET').toUpperCase();
    const normalized = normalizeApiUrl(req.url);
    const key = `${method}::${normalized}`;
    if (!groups[key]) {
      groups[key] = { method, normalizedUrl: normalized, calls: [], key };
    }
    groups[key].calls.push({
      url: req.url,
      status: req.status,
      duration: req.duration ?? req.time ?? null,
      initiator: req.initiator ?? null,
    });
  }

  // Report groups with more than one call
  for (const group of Object.values(groups)) {
    const count = group.calls.length;
    if (count <= 1) continue;

    // Severity ladder:
    //   2 calls  → info    (might be intentional: prefetch + actual)
    //   3–4 calls → warning (likely a bug: double render, missing dependency array)
    //   5+ calls  → critical (runaway loop, missing cleanup)
    let severity = 'info';
    if (count >= 5) severity = 'critical';
    else if (count >= 3) severity = 'warning';

    const durations = group.calls
      .map(c => c.duration)
      .filter(Boolean)
      .map(d => `${Math.round(d)}ms`);

    bugs.push({
      type: 'api_duplicate_call',
      method: group.method,
      endpoint: group.normalizedUrl,
      callCount: count,
      calls: group.calls,
      durations,
      message: `API called ${count}x in one page load: ${group.method} ${group.normalizedUrl}${count >= 5 ? ' — possible infinite loop or missing cleanup' : count >= 3 ? ' — likely double-fetch bug (check useEffect deps or component re-mounts)' : ' — called twice (verify this is intentional)'}`,
      severity,
      url: pageUrl,
    });
  }

  // Also report total unique API calls as an info summary
  const uniqueCount = Object.keys(groups).length;
  const totalCount = apiCalls.length;
  if (totalCount > 0) {
    bugs.push({
      type: 'api_call_summary',
      uniqueEndpoints: uniqueCount,
      totalCalls: totalCount,
      duplicateEndpoints: Object.values(groups).filter(g => g.calls.length > 1).length,
      message: `API summary: ${totalCount} calls to ${uniqueCount} unique endpoints${Object.values(groups).filter(g => g.calls.length > 1).length > 0 ? ` (${Object.values(groups).filter(g => g.calls.length > 1).length} called more than once)` : ''}`,
      severity: 'info',
      url: pageUrl,
    });
  }

  return bugs;
}

/**
 * Normalize an API URL for grouping: strip query params, collapse IDs.
 * e.g. /api/users/123/posts?page=2 → /api/users/{id}/posts
 *
 * @param {string} url
 * @returns {string}
 */
export function normalizeApiUrl(url) {
  try {
    const u = new URL(url);
    const pathname = u.pathname
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/{id}')
      .replace(/\/\d+/g, '/{id}');
    return `${u.hostname}${pathname}`;
  } catch {
    return url.replace(/[?#].*/, '').replace(/\/\d+/g, '/{id}');
  }
}
