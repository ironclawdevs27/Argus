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
      var v = (localStorage.getItem(k) || '').slice(0, 500);  // GAP-51: String() coercion was redundant
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
      .filter(function(c) { return c.length > 0; })  // GAP-50: .filter(Boolean) drops "0"/"false" cookie names
      .map(function(c) { return c.split('=')[0].trim(); });
  } catch (e) {}

  // 4. Response headers — CSP + X-Frame-Options via fetch HEAD (same-origin)
  // GAP-48: Timeout is configurable via ARGUS_SECURITY_TIMEOUT (ms); defaults to 3000.
  // Hardcoded 3s caused false negatives on staging servers behind VPNs/proxies.
  var hasCSP = null, hasXFrame = null;
  try {
    var ctrl    = new AbortController();
    var timeout = (typeof ARGUS_SECURITY_TIMEOUT !== 'undefined' ? ARGUS_SECURITY_TIMEOUT : 3000);
    var tid     = setTimeout(function() { ctrl.abort(); }, timeout);
    try {
      // GAP-44: clearTimeout must run even if fetch rejects — use inner try/finally.
      var r = await fetch(location.href, { method: 'HEAD', cache: 'no-store', signal: ctrl.signal });
      hasCSP    = r.headers.has('Content-Security-Policy');
      hasXFrame = r.headers.has('X-Frame-Options');
    } finally {
      clearTimeout(tid);
    }
  } catch (e) {}

  // 5. iframe sandbox check (GAP-102)
  // Cross-origin iframes without the sandbox attribute can execute scripts,
  // access top-level navigation, and exfiltrate cookies — significant security risk.
  var unsandboxedIframes = [];
  try {
    var iframes = Array.prototype.slice.call(document.querySelectorAll('iframe[src]'));
    for (var fi = 0; fi < iframes.length && fi < 20; fi++) {
      var iframe = iframes[fi];
      var iframeSrc = iframe.getAttribute('src') || '';
      if (!iframe.hasAttribute('sandbox') && iframeSrc && !iframeSrc.startsWith('javascript:')) {
        unsandboxedIframes.push({ src: iframeSrc.slice(0, 100) });
      }
    }
  } catch (e) {}

  // 6. Links opening in new tabs without rel="noopener noreferrer" (GAP-132)
  // window.opener on the opened page allows it to navigate the opener — phishing vector.
  var unsafeBlankLinks = [];
  try {
    var blankLinks = Array.prototype.slice.call(document.querySelectorAll('a[target="_blank"]'));
    for (var li = 0; li < blankLinks.length && li < 30; li++) {
      var link = blankLinks[li];
      var rel = (link.getAttribute('rel') || '').toLowerCase();
      if (!rel.includes('noopener') && !rel.includes('noreferrer')) {
        unsafeBlankLinks.push({ href: (link.href || link.getAttribute('href') || '').slice(0, 100) });
      }
    }
  } catch (e) {}

  return JSON.stringify({ storageTokenKeys: storageTokenKeys, evalUsage: evalUsage, jsCookies: jsCookies, hasCSP: hasCSP, hasXFrame: hasXFrame, unsandboxedIframes: unsandboxedIframes, unsafeBlankLinks: unsafeBlankLinks });
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
    // GAP-43: Unwrap MCP { result: '...' } wrapper before parsing. Without this,
    // JSON.stringify({ result: '{"key":"val"}' }) → parse → { result: '...' } and
    // all field lookups (storageTokenKeys, evalUsage, etc.) return undefined — zero findings.
    // GAP-47: JSON.stringify on a circular object throws; catch logs and returns [].
    let raw = rawResult;
    if (typeof raw === 'object' && !Array.isArray(raw) && raw !== null && raw.result !== undefined) {
      raw = raw.result;
    }
    const str = typeof raw === 'string' ? raw : JSON.stringify(raw);
    data = JSON.parse(str);
  } catch (e) {
    console.warn('[ARGUS] parseSecurityAnalysisResult: parse failed —', e.message);
    return [];
  }

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

  // GAP-102: unsandboxed cross-origin iframes
  if (Array.isArray(data.unsandboxedIframes) && data.unsandboxedIframes.length > 0) {
    for (const frame of data.unsandboxedIframes) {
      bugs.push({
        type:    'security_iframe_no_sandbox',
        src:     frame.src,
        message: `<iframe src="${frame.src}"> has no sandbox attribute — add sandbox="allow-scripts allow-same-origin" to restrict capabilities`,
        severity: 'warning',
        url,
      });
    }
  }

  // GAP-132: target="_blank" links without rel="noopener noreferrer"
  // The opened page can access window.opener and redirect the parent tab — phishing vector.
  if (Array.isArray(data.unsafeBlankLinks) && data.unsafeBlankLinks.length > 0) {
    bugs.push({
      type:    'security_unsafe_blank_link',
      count:   data.unsafeBlankLinks.length,
      hrefs:   data.unsafeBlankLinks.map(l => l.href),
      message: `${data.unsafeBlankLinks.length} link(s) with target="_blank" missing rel="noopener noreferrer" — add rel="noopener noreferrer" to prevent opener hijacking`,
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
