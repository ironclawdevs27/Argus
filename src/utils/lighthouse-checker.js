/**
 * Argus Lighthouse Checker (extracted D2.5)
 *
 * Extracted from crawl-and-report.js so test-harness/validate.js can import
 * checkLighthouse directly without pulling in the Slack-initialised orchestrator.
 */

export const LIGHTHOUSE_THRESHOLDS = {
  accessibility:    { critical: 50, warning: 90 },
  performance:      { critical: 50, warning: 90 },
  seo:              { critical: 50, warning: 90 },
  'best-practices': { critical: 50, warning: 90 },
};

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
 * @param {object} mcp - MCP tool interface (lighthouse_audit)
 * @param {string} url - URL being tested
 * @returns {Promise<object[]>} Lighthouse violation findings
 */
export async function checkLighthouse(mcp, url) {
  const violations = [];

  try {
    const result = await mcp.lighthouse_audit({
      categories: ['accessibility', 'performance', 'seo', 'best-practices'],
      url,
    });

    const categories = result?.categories ?? {};
    const audits     = result?.audits     ?? {};

    for (const [catKey, thresholds] of Object.entries(LIGHTHOUSE_THRESHOLDS)) {
      const catData = categories[catKey] ?? categories[catKey.replace('-', '_')];
      const score   = catData?.score ?? result?.[catKey]?.score ?? null;
      if (score == null) continue;

      const pct   = Math.round(score * 100);
      const label = LIGHTHOUSE_LABELS[catKey];

      if (pct < thresholds.critical) {
        violations.push({
          type:      'lighthouse_score',
          category:  catKey,
          score:     pct,
          threshold: thresholds.critical,
          message:   `Lighthouse ${label} score ${pct}/100 — critical (threshold: ${thresholds.critical})`,
          severity:  'critical',
          url,
        });
      } else if (pct < thresholds.warning) {
        violations.push({
          type:      'lighthouse_score',
          category:  catKey,
          score:     pct,
          threshold: thresholds.warning,
          message:   `Lighthouse ${label} score ${pct}/100 — needs improvement (threshold: ${thresholds.warning})`,
          severity:  'warning',
          url,
        });
      }
    }

    for (const [auditId, audit] of Object.entries(audits)) {
      if (audit.score !== 0) continue;
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
    console.warn(`[ARGUS] Lighthouse audit skipped for ${url}: ${err.message}`);
  }

  return violations;
}
