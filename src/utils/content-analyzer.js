/**
 * ARGUS Content Analyzer (v3 Phase A5)
 *
 * DOM-based content quality checks via evaluate_script:
 *   1. undefined / null / NaN rendered as visible text
 *   2. Placeholder text — "Lorem ipsum", "TODO", "FIXME", etc.
 *   3. Broken images — <img> that loaded but has naturalWidth === 0
 *   4. Empty data-oriented lists — <ul>/<ol> with a results/items/grid class but zero <li> children
 */

/**
 * Synchronous arrow function injected into the page via mcp.evaluate_script.
 * Returns a JSON string consumed by parseContentAnalysisResult().
 */
export const CONTENT_ANALYSIS_SCRIPT = `() => {
  var body = document.body || {};
  var bodyText = body.innerText || '';

  // 1. Standalone undefined / null / NaN in visible body text
  var nullMatches = [];
  var nullSet = {};
  var nullPat = /\\bundefined\\b|\\bnull\\b|\\bNaN\\b/g;
  var m;
  while ((m = nullPat.exec(bodyText)) !== null) {
    if (!nullSet[m[0]]) { nullSet[m[0]] = true; nullMatches.push(m[0]); }
  }

  // 2. Placeholder text patterns
  var placeholders = [];
  var phChecks = [
    ['lorem ipsum',  /lorem ipsum/i],
    ['todo',         /\\btodo\\b/i],
    ['fixme',        /\\bfixme\\b/i],
    ['hello world',  /\\bhello[\\s-]world\\b/i],
    ['test user',    /\\btest user\\b/i],
    ['foo bar',      /\\bfoo bar\\b/i],
    ['dummy text',   /\\bdummy (text|data|content)\\b/i],
  ];
  phChecks.forEach(function(pair) {
    if (pair[1].test(bodyText)) placeholders.push(pair[0]);
  });

  // 3. Broken images — loaded (complete) but naturalWidth === 0 (excludes data: URIs)
  var brokenImages = [];
  var imgs = Array.prototype.slice.call(document.querySelectorAll('img[src]'));
  imgs.forEach(function(img) {
    if (img.complete && img.naturalWidth === 0 &&
        img.src && img.src.indexOf('data:') !== 0) {
      brokenImages.push(img.src.slice(0, 200));
    }
  });

  // 4. Empty data-oriented lists (ul/ol with results/items/list/feed/grid class but 0 li children)
  var emptyLists = [];
  var listClassPat = /results|items|list|feed|grid|entries|collection/i;
  var lists = Array.prototype.slice.call(document.querySelectorAll('ul, ol'));
  lists.forEach(function(list) {
    if (list.querySelectorAll('li').length === 0 && listClassPat.test(list.className || '')) {
      emptyLists.push((list.className || 'unnamed').slice(0, 100));
    }
  });

  return JSON.stringify({
    nullMatches:  nullMatches,
    placeholders: placeholders,
    brokenImages: brokenImages,
    emptyLists:   emptyLists,
  });
}`;

/**
 * Convert the raw evaluate_script result from CONTENT_ANALYSIS_SCRIPT into
 * structured bug entries for the Argus report.
 *
 * @param {object|string|null} rawResult
 * @param {string} url - Page URL for context
 * @returns {object[]}
 */
export function parseContentAnalysisResult(rawResult, url) {
  if (rawResult == null) return [];

  let data;
  try {
    const str = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);
    data = JSON.parse(str);
  } catch { return []; }

  if (!data || typeof data !== 'object') return [];

  const bugs = [];

  if (Array.isArray(data.nullMatches) && data.nullMatches.length > 0) {
    bugs.push({
      type:    'content_null_rendered',
      values:  data.nullMatches,
      message: `Null-like value rendered as visible text: ${data.nullMatches.join(', ')}`,
      severity: 'warning',
      url,
    });
  }

  if (Array.isArray(data.placeholders) && data.placeholders.length > 0) {
    bugs.push({
      type:        'content_placeholder_text',
      placeholders: data.placeholders,
      message:     `Placeholder text found in page body: ${data.placeholders.join(', ')}`,
      severity:    'warning',
      url,
    });
  }

  for (const src of data.brokenImages ?? []) {
    bugs.push({
      type:     'content_broken_image',
      src,
      message:  `Broken image (naturalWidth=0): ${src}`,
      severity: 'warning',
      url,
    });
  }

  if (Array.isArray(data.emptyLists) && data.emptyLists.length > 0) {
    bugs.push({
      type:    'content_empty_list',
      classes: data.emptyLists,
      message: `Empty data list detected (${data.emptyLists.length} list(s) with no items): ${data.emptyLists.join(', ')}`,
      severity: 'warning',
      url,
    });
  }

  return bugs;
}
