/**
 * Argus Lighthouse Checker (extracted D2.5)
 *
 * Extracted from crawl-and-report.js so test-harness/validate.js can import
 * checkLighthouse directly without pulling in the Slack-initialised orchestrator.
 */

import { registerExpensive } from '../registry.js';
import { thresholds }        from '../config/targets.js';
import { childLogger }       from './logger.js';

const logger = childLogger('lighthouse-checker');

const LIGHTHOUSE_LABELS = {
  accessibility:    'Accessibility',
  performance:      'Performance',
  seo:              'SEO',
  'best-practices': 'Best Practices',
};

/**
 * Run a full Lighthouse audit (accessibility, performance, SEO, best-practices).
 *
 * Each category is scored:
 *   score < threshold.critical → 'critical' violation
 *   score < threshold.warning  → 'warning'  violation
 *
 * Individual failing audit items (score === 0) are also surfaced.
 *
 * @param {object} browser - CdpBrowserAdapter
 * @param {string} url     - URL being tested
 * @returns {Promise<object[]>} Lighthouse violation findings
 */
export async function checkLighthouse(browser, url) {
  const violations = [];

  // Lighthouse can hang indefinitely on heavy SPAs or when Chrome is under load.
  // 120 s is generous — a real Lighthouse run completes in 15–30 s on most pages.
  const LIGHTHOUSE_TIMEOUT_MS = parseInt(process.env.ARGUS_LIGHTHOUSE_TIMEOUT ?? '120000', 10);

  try {
    const auditPromise = browser.lighthouse(url, {
      categories: ['accessibility', 'performance', 'seo', 'best-practices'],
    });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Lighthouse timed out after ${LIGHTHOUSE_TIMEOUT_MS / 1000}s`)), LIGHTHOUSE_TIMEOUT_MS)
    );
    const result = await Promise.race([auditPromise, timeoutPromise]);

    const categories = result?.categories ?? {};
    const audits     = result?.audits     ?? {};

    for (const [catKey, catThresholds] of Object.entries(thresholds.lighthouse)) {
      const catData = categories[catKey]
        ?? categories[catKey.replace('-', '_')]
        ?? categories[catKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase())];
      const score   = catData?.score ?? result?.[catKey]?.score ?? null;
      if (score == null) continue;

      const pct   = Math.round(score * 100);
      const label = LIGHTHOUSE_LABELS[catKey];

      if (pct < catThresholds.critical) {
        violations.push({
          type:      'lighthouse_score',
          category:  catKey,
          score:     pct,
          threshold: catThresholds.critical,
          message:   `Lighthouse ${label} score ${pct}/100 — critical (threshold: ${catThresholds.critical})`,
          severity:  'critical',
          url,
        });
      } else if (pct < catThresholds.warning) {
        violations.push({
          type:      'lighthouse_score',
          category:  catKey,
          score:     pct,
          threshold: catThresholds.warning,
          message:   `Lighthouse ${label} score ${pct}/100 — needs improvement (threshold: ${catThresholds.warning})`,
          severity:  'warning',
          url,
        });
      }
    }

    for (const [auditId, audit] of Object.entries(audits)) {
      if (audit.score == null || audit.score !== 0) continue;
      if (audit.details?.type === 'manual') continue;

      const auditCategory = Object.entries(categories).find(([, cat]) =>
        cat?.auditRefs?.some?.(ref => ref.id === auditId)
      )?.[0] ?? 'unknown';

      const label = LIGHTHOUSE_LABELS[auditCategory] ?? auditCategory;

      violations.push({
        type:     'lighthouse_audit',
        category: auditCategory,
        auditId,
        title:    audit.title,
        message:  `[${label}] ${audit.title}${audit.description ? ' — ' + audit.description.slice(0, 120) : ''}`,
        severity: 'warning',
        url,
      });
    }

  } catch (err) {
    logger.warn(`[ARGUS] Lighthouse audit skipped for ${url}: ${err.message}`);
  }

  return violations;
}

// ── Self-registration ─────────────────────────────────────────────────────────
registerExpensive({
  name: 'lighthouse',
  async analyze(browser, url) {
    return checkLighthouse(browser, url);
  },
});
