/**
 * Argus Config Schema (v9.1.6)
 *
 * Zod validation for src/config/targets.js exports.
 * Called at startup (before any crawl begins) so misconfiguration is caught
 * immediately with a clear error rather than a silent runtime failure mid-crawl.
 *
 * Usage:
 *   import * as targets from './config/targets.js';
 *   import { validateConfig } from './config/schema.js';
 *   validateConfig(targets);
 */

import { z } from 'zod';

// ── Route ─────────────────────────────────────────────────────────────────────

const RouteSchema = z.object({
  path:       z.string().startsWith('/'),
  name:       z.string().min(1),
  critical:   z.boolean().optional(),
  waitFor:    z.string().nullable().optional(),
  discovered: z.boolean().optional(),
}).passthrough();

// ── Thresholds ────────────────────────────────────────────────────────────────

const LighthouseCategorySchema = z.object({
  critical: z.number().min(0).max(100),
  warning:  z.number().min(0).max(100),
});

const ThresholdsSchema = z.object({
  perf: z.object({
    LCP:  z.number().positive(),
    CLS:  z.number().positive(),
    FID:  z.number().positive(),
    TTFB: z.number().positive(),
  }),
  network: z.object({
    slowWarning:  z.number().positive(),
    slowCritical: z.number().positive(),
    sizeWarning:  z.number().positive(),
    sizeCritical: z.number().positive(),
  }),
  memory: z.object({
    detachedWarning:    z.number().nonnegative(),
    detachedCritical:   z.number().nonnegative(),
    heapGrowthWarning:  z.number().nonnegative(),
    heapGrowthCritical: z.number().nonnegative(),
  }),
  hover: z.object({
    waitMs:       z.number().nonnegative(),
    maxDropdowns: z.number().int().positive(),
    maxTooltips:  z.number().int().positive(),
  }),
  security: z.object({
    headTimeoutMs: z.number().positive(),
  }),
  apiFrequency: z.object({
    warningCount:  z.number().int().positive(),
    criticalCount: z.number().int().positive(),
  }),
  lighthouse: z.object({
    accessibility:    LighthouseCategorySchema,
    performance:      LighthouseCategorySchema,
    seo:              LighthouseCategorySchema,
    'best-practices': LighthouseCategorySchema,
  }),
});

// ── Top-level Config ──────────────────────────────────────────────────────────

export const ConfigSchema = z.object({
  config: z.object({
    pageSettleMs:            z.number().positive(),
    screenshotQuality:       z.number().min(1).max(100).optional(),
    screenshotDiffThreshold: z.number().min(0).optional(),
    outputDir:               z.string().optional(),
  }).passthrough(),
  routes:            z.array(RouteSchema),
  thresholds:        ThresholdsSchema,
  comparisonRoutes:  z.array(z.any()).optional(),
  apiContracts:      z.array(z.any()).optional(),
  severityOverrides: z.record(z.string()).optional(),
  auth:              z.any().nullable().optional(),
  flows:             z.array(z.any()).optional(),
  codebase:          z.any().nullable().optional(),
  autoDiscover:      z.any().nullable().optional(),
}).passthrough();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Validate the targets.js namespace against ConfigSchema.
 * Throws a descriptive Error (wrapping the ZodError) on any schema violation.
 *
 * @param {object} targets - The targets.js module namespace (import * as targets)
 */
export function validateConfig(targets) {
  const result = ConfigSchema.safeParse(targets);
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`[ARGUS] Invalid targets.js configuration:\n${issues}`);
  }
}
