/**
 * ARGUS SEO Analyzer (v3 Phase A3)
 *
 * Injected via evaluate_script to inspect the live DOM for SEO signals:
 *   - <meta name="description"> presence
 *   - Open Graph tags (og:title, og:description, og:image)
 *   - Number of <h1> tags
 *   - <title> length / genericness
 *   - <link rel="canonical"> presence
 *   - <meta name="viewport"> presence
 *
 * Returns a JSON string that parseSeoAnalysisResult() converts to bug entries.
 */

/**
 * JavaScript arrow function injected into the page via mcp.evaluate_script.
 * Runs entirely in the page's browser context — no Node.js APIs available.
 */
export const SEO_ANALYSIS_SCRIPT = `() => {
  function sel(s) { return !!document.querySelector(s); }
  return JSON.stringify({
    hasDescription:   sel('meta[name="description"]'),
    hasOgTitle:       sel('meta[property="og:title"]'),
    hasOgDescription: sel('meta[property="og:description"]'),
    hasOgImage:       sel('meta[property="og:image"]'),
    h1Count:          document.querySelectorAll('h1').length,
    titleText:        document.title || '',
    titleLength:      (document.title || '').trim().length,
    hasCanonical:     sel('link[rel="canonical"]'),
    hasViewport:      sel('meta[name="viewport"]'),
  });
}`;

/**
 * Convert the raw evaluate_script result from SEO_ANALYSIS_SCRIPT into
 * structured bug entries for the Argus report.
 *
 * @param {object|string|null} rawResult - Parsed object, JSON string, or null
 * @param {string} url - Page URL for error context
 * @returns {object[]} Bug entries
 */
export function parseSeoAnalysisResult(rawResult, url) {
  if (rawResult == null) return [];

  let data;
  try {
    const str = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);
    data = JSON.parse(str);
  } catch {
    return [];
  }

  if (!data || typeof data !== 'object') return [];

  const bugs = [];

  if (!data.hasDescription) {
    bugs.push({
      type:    'seo_missing_description',
      message: 'Missing <meta name="description"> — page has no search snippet',
      severity: 'warning',
      url,
    });
  }

  if (!data.hasOgTitle) {
    bugs.push({
      type:     'seo_missing_og',
      property: 'og:title',
      message:  'Missing <meta property="og:title"> — social sharing title not set',
      severity: 'warning',
      url,
    });
  }

  if (!data.hasOgDescription) {
    bugs.push({
      type:     'seo_missing_og',
      property: 'og:description',
      message:  'Missing <meta property="og:description"> — social sharing description not set',
      severity: 'warning',
      url,
    });
  }

  if (!data.hasOgImage) {
    bugs.push({
      type:     'seo_missing_og',
      property: 'og:image',
      message:  'Missing <meta property="og:image"> — social sharing image not set',
      severity: 'info',
      url,
    });
  }

  if (data.h1Count > 1) {
    bugs.push({
      type:    'seo_multiple_h1',
      h1Count: data.h1Count,
      message: `Multiple <h1> tags detected (${data.h1Count}) — page should have exactly one`,
      severity: 'warning',
      url,
    });
  } else if (data.h1Count === 0) {
    bugs.push({
      type:    'seo_missing_h1',
      message: 'No <h1> tag on page — missing primary heading',
      severity: 'warning',
      url,
    });
  }

  if (data.titleLength < 10) {
    bugs.push({
      type:        'seo_generic_title',
      titleText:   data.titleText,
      titleLength: data.titleLength,
      message:     `Page title too short (${data.titleLength} chars: "${data.titleText}") — aim for 10–60 chars`,
      severity:    'warning',
      url,
    });
  }

  if (!data.hasCanonical) {
    bugs.push({
      type:    'seo_missing_canonical',
      message: 'Missing <link rel="canonical"> — duplicate content risk',
      severity: 'warning',
      url,
    });
  }

  if (!data.hasViewport) {
    bugs.push({
      type:    'seo_missing_viewport',
      message: 'Missing <meta name="viewport"> — mobile rendering undefined',
      severity: 'warning',
      url,
    });
  }

  return bugs;
}
