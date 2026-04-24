/**
 * ARGUS Security Analyzer (v3 Phase A4)
 *
 * Three detection surfaces:
 *   1. DOM / browser context  — SECURITY_ANALYSIS_SCRIPT via evaluate_script
 *      • localStorage keys with token/auth names or JWT-shaped values
 *      • eval() in inline <script> tags
 *      • JS-accessible cookies (no HttpOnly flag)
 *      • Missing Content-Security-Policy and X-Frame-Options response headers
 *        (checked via a same-origin fetch HEAD request)
 *
 *   2. Console messages       — analyzeSecurityConsole
 *      • Mixed content (D6.9): "blocked" in message → critical; passive (image/audio) → warning
 *      • Sensitive data patterns (email address, JWT, Bearer token, param=value)
 *
 *   3. Network request URLs   — analyzeSecurityNetwork
 *      • Sensitive query parameters (?token=, ?key=, ?auth=, …)
 *      • HTTP resource on HTTPS page (D6.9) — skips loopback; only fires on real HTTPS origins
 */

/**
 * Async arrow function injected into the page via mcp.evaluate_script.
 * Uses a fetch HEAD request to check response headers on the same origin.
 * Returns a JSON string consumed by parseSecurityAnalysisResult().
 */
export const SECURITY_ANALYSIS_SCRIPT = `async () => {
  // 1. localStorage — token-shaped key names or JWT-shaped values
  const storageTokenKeys = [];
  try {
    var kPat = /token|jwt|auth|secret|apikey|api_key|password|credential|session/i;
    var jwtPat = /^ey[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]+/;
    var keys = Object.keys(localStorage || {});
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = String(localStorage.getItem(k) || '').slice(0, 500);
      if (kPat.test(k) || jwtPat.test(v)) storageTokenKeys.push(k);
    }
  } catch (e) {}

  // 2. eval() in inline <script> tags
  var evalUsage = false;
  try {
    var scripts = Array.prototype.slice.call(document.querySelectorAll('script:not([src])'));
    evalUsage = scripts.some(function(s) { return /\\beval\\s*\\(/.test(s.textContent || ''); });
  } catch (e) {}

  // 3. JS-accessible cookies (visible to JS = no HttpOnly flag)
  // Limitation: document.cookie only exposes cookies WITHOUT HttpOnly. HttpOnly cookies
  // (most sensitive session tokens) are completely invisible here. The Secure flag also
  // cannot be detected via JS — Secure-only cookies still appear in document.cookie.
  // For HttpOnly detection, the only path is response headers (Set-Cookie inspection),
  // which requires network-layer interception outside this DOM script.
  var jsCookies = [];
  try {
    jsCookies = document.cookie.split(';')
      .map(function(c) { return c.trim(); })
      .filter(Boolean)
      .map(function(c) { return c.split('=')[0].trim(); });
  } catch (e) {}

  // 4. Response headers — CSP + X-Frame-Options via fetch HEAD (same-origin)
  var hasCSP = null, hasXFrame = null;
  try {
    var ctrl = new AbortController();
    var tid  = setTimeout(function() { ctrl.abort(); }, 3000);
    var r    = await fetch(location.href, { method: 'HEAD', cache: 'no-store', signal: ctrl.signal });
    clearTimeout(tid);
    hasCSP    = r.headers.has('Content-Security-Policy');
    hasXFrame = r.headers.has('X-Frame-Options');
  } catch (e) {}

  return JSON.stringify({ storageTokenKeys: storageTokenKeys, evalUsage: evalUsage, jsCookies: jsCookies, hasCSP: hasCSP, hasXFrame: hasXFrame });
}`;

/**
 * Convert the raw evaluate_script result from SECURITY_ANALYSIS_SCRIPT into
 * structured bug entries for the Argus report.
 *
 * @param {object|string|null} rawResult
 * @param {string} url - Page URL for context
 * @returns {object[]}
 */
export function parseSecurityAnalysisResult(rawResult, url) {
  if (rawResult == null) return [];

  let data;
  try {
    const str = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);
    data = JSON.parse(str);
  } catch { return []; }

  if (!data || typeof data !== 'object') return [];

  const bugs = [];

  if (Array.isArray(data.storageTokenKeys) && data.storageTokenKeys.length > 0) {
    bugs.push({
      type:     'security_token_in_storage',
      keys:     data.storageTokenKeys,
      message:  `Auth token stored in localStorage (keys: ${data.storageTokenKeys.join(', ')}) — XSS-accessible`,
      severity: 'critical',
      url,
    });
  }

  if (data.evalUsage) {
    bugs.push({
      type:     'security_eval_usage',
      message:  'eval() usage detected in inline script — security and performance risk',
      severity: 'warning',
      url,
    });
  }

  if (Array.isArray(data.jsCookies) && data.jsCookies.length > 0) {
    bugs.push({
      type:     'security_cookie_no_httponly',
      cookies:  data.jsCookies,
      message:  `${data.jsCookies.length} cookie(s) readable by JavaScript (no HttpOnly flag): ${data.jsCookies.join(', ')}`,
      severity: 'warning',
      url,
    });
  }

  if (data.hasCSP === false) {
    bugs.push({
      type:     'security_missing_csp',
      message:  'Missing Content-Security-Policy response header — XSS risk',
      severity: 'warning',
      url,
    });
  }

  if (data.hasXFrame === false) {
    bugs.push({
      type:     'security_missing_xframe',
      message:  'Missing X-Frame-Options response header — clickjacking risk',
      severity: 'warning',
      url,
    });
  }

  return bugs;
}

/**
 * Scan console messages for mixed content warnings and sensitive data patterns.
 * Targeted pattern avoids false positives on common error strings.
 *
 * @param {object[]} consoleMsgs - Raw console message objects ({ level, text })
 * @param {string}   url
 * @returns {object[]}
 */
export function analyzeSecurityConsole(consoleMsgs, url) {
  const bugs = [];
  // Targeted: require delimiter after keyword (password=, secret:) OR structural patterns
  const sensitivePattern = /password[:=]|secret[:=]|api[_-]?key[:=]|credential[:=]|eyJ[A-Za-z0-9_-]{10,}|Bearer\s+\S{6,}|\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,7}\b/i;
  const mixedContentPattern = /mixed content/i;

  for (const msg of consoleMsgs ?? []) {
    const text = String(msg.text ?? msg.message ?? msg ?? '');
    if (!text) continue;
    if (mixedContentPattern.test(text)) {
      // D6.9: "blocked" in the message → active content, browser refuses to load → critical.
      // No "blocked" → passive content (image/audio/video), browser loads with a warning → warning.
      const isBlocked = /\bblocked\b/i.test(text);
      bugs.push({
        type:     'security_mixed_content',
        message:  `Mixed content ${isBlocked ? 'blocked' : 'warning'}: ${text.slice(0, 200)}`,
        severity: isBlocked ? 'critical' : 'warning',
        url,
      });
    } else if (sensitivePattern.test(text)) {
      bugs.push({
        type:     'security_sensitive_console',
        message:  `Sensitive data in console output: ${text.slice(0, 200)}`,
        severity: 'warning',
        url,
      });
    }
  }
  return bugs;
}

/**
 * Scan network request URLs for sensitive query parameters.
 *
 * @param {object[]} networkReqs - Network request entries ({ url })
 * @param {string}   url - Page URL for context
 * @returns {object[]}
 */
export function analyzeSecurityNetwork(networkReqs, url) {
  const bugs = [];
  const sensitiveParams = /[?&](token|key|auth|password|secret|apikey|api_key|credential|jwt)=/i;
  // D6.9: flag HTTP resources on HTTPS pages; skip loopback addresses (not mixed content).
  const pageIsHttps = (url ?? '').startsWith('https://');
  const isLoopback  = /^http:\/\/(localhost|127\.|0\.0\.0\.0)/i;

  for (const req of networkReqs ?? []) {
    const reqUrl = req.url ?? req.requestUrl ?? '';
    if (!reqUrl) continue;

    if (pageIsHttps && reqUrl.startsWith('http://') && !isLoopback.test(reqUrl)) {
      bugs.push({
        type:       'security_mixed_content',
        requestUrl: reqUrl,
        message:    `Mixed content: HTTP resource "${reqUrl.slice(0, 200)}" on HTTPS page — request may be blocked`,
        severity:   'critical',
        url,
      });
    }

    if (!sensitiveParams.test(reqUrl)) continue;
    bugs.push({
      type:       'security_token_in_url',
      requestUrl: reqUrl,
      message:    `Sensitive parameter in request URL: ${reqUrl.slice(0, 300)}`,
      severity:   'critical',
      url,
    });
  }
  return bugs;
}
