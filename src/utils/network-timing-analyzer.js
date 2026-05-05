/**
 * ARGUS Network HAR Timing Analyzer (v6 GAP-094)
 *
 * Reads per-request TTFB (timing.wait) from list_network_requests HAR output.
 * Detects third-party resources that block page load — cross-origin requests
 * have 0ms in window.performance.getEntriesByType('resource') when the server
 * omits Timing-Allow-Origin, so PerformanceResourceTiming (NETWORK_PERF_SCRIPT)
 * is blind to them. Chrome DevTools HAR timing is always accurate.
 *
 * Same-origin slow requests are covered by the existing NETWORK_PERF_SCRIPT
 * approach in crawlRouteExpensive — this module focuses exclusively on cross-
 * origin (third-party) blocking resources.
 *
 * Detections:
 *   slow_third_party_blocking — cross-origin resource with timing.wait > 2000 ms
 */

// Cross-origin slow-resource threshold (ms)
const THIRD_PARTY_WARNING_MS = 2000;

// Static asset extensions — focus analysis on scripts/XHR/fetch, not images/fonts
const STATIC_ASSET_EXT = /\.(png|jpg|jpeg|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot)(\?.*)?$/i;

/**
 * Extract wait time (ms) from a HAR timing object.
 * HAR 1.2 uses req.timings.wait; chrome-devtools-mcp uses req.timing.wait.
 */
function getWaitMs(req) {
  if (req.timing  && typeof req.timing.wait  === 'number') return req.timing.wait;
  if (req.timings && typeof req.timings.wait === 'number') return req.timings.wait;
  // req.time/req.duration represent total request duration (not TTFB) — omitted to
  // avoid flagging large-payload responses as slow when server response was fast.
  return null;
}

function isStaticAsset(url) {
  try { return STATIC_ASSET_EXT.test(new URL(url).pathname); } catch { return false; }
}

function isSameOrigin(reqUrl, pageUrl) {
  try { return new URL(reqUrl).origin === new URL(pageUrl).origin; } catch { return true; }
}

/**
 * Pure: analyse sliced list_network_requests results for slow third-party resources.
 *
 * @param {object[]} reqs    - sliced array of network request HAR objects
 * @param {string}   pageUrl - URL of the page being analysed (for origin comparison)
 * @returns {object[]}       - array of slow_third_party_blocking finding objects
 */
export function parseNetworkTiming(reqs, pageUrl) {
  const findings = [];
  for (const req of reqs) {
    if (!req.url) continue;
    if (isStaticAsset(req.url)) continue;
    if (isSameOrigin(req.url, pageUrl)) continue;  // covered by NETWORK_PERF_SCRIPT

    // Skip failed/aborted requests — status errors are caught by classifyNetworkRequest
    const status = req.status ?? 0;
    if (status === 0) continue; // aborted or in-flight — timing fields are unreliable
    if (status < 200 || status >= 400) continue;

    const waitMs = getWaitMs(req);
    if (waitMs == null || waitMs < THIRD_PARTY_WARNING_MS) continue;

    findings.push({
      type:       'slow_third_party_blocking',
      requestUrl: req.url,
      waitMs:     Math.round(waitMs),
      message:    `Slow third-party resource: ${req.method ?? 'GET'} ${req.url} — ${Math.round(waitMs)}ms server wait may block page render (threshold: ${THIRD_PARTY_WARNING_MS}ms)`,
      severity:   'warning',
      url:        pageUrl,
    });
  }
  return findings;
}
