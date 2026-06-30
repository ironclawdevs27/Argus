/**
 * Golden response schemas for the 9 Argus MCP tools.
 *
 * Single source of truth for the SHAPE of every tool's happy-path response:
 * required keys + types, derived from the live responses of src/mcp-server.js
 * (handleAudit / handleAuditFull / handleCompare / handleLastReport /
 * handleWatchSnapshot / handleGetContext / handleVisualDiff / handleDesignAudit /
 * handlePrValidate). Harness block [147] safeParses each tool's real response
 * against the matching schema, so an accidental field rename or removal in a
 * handler turns a silently-changed contract into a loud, attributable failure.
 *
 * Design rules:
 *   - Objects use `.passthrough()` (matches src/config/schema.js house style): the
 *     contract is "these keys exist with these types", NOT "only these keys" — so
 *     ADDITIVE handler changes (a new field) never break the gate, only renames /
 *     removals / type changes do.
 *   - The TWO summary shapes are deliberately distinct: the cheap audit summary is
 *     `{ critical, warning, info }` (NO `total`); the full report / compare summary
 *     is `{ total, critical, warning, info }`. Keeping them separate means a
 *     handler that drops `total` from the report summary fails [147] instead of
 *     passing under a one-size-fits-all summary schema.
 *
 * Exported for reuse by E2E sessions (E2E_PLAN.md §1): `import { TOOL_RESPONSE_SCHEMAS }`
 * and `safeParse` a captured tool response to assert its contract executably.
 *
 * Regenerating: if a handler intentionally changes its response shape, update the
 * matching schema here in the SAME commit and note the diff in the plan's Progress
 * Log — the schema change IS the contract review.
 */

import { z } from 'zod';

// ── Building blocks ───────────────────────────────────────────────────────────

/**
 * A finding — createFinding() canonical shape (src/domain/finding.js):
 * type/severity/message required, url defaulted to '', plus analyzer-specific
 * extras (level, source, line, count, selector, metric, …). passthrough() keeps
 * those extras from breaking the contract; severity is the enforced enum.
 */
export const findingSchema = z.object({
  type:     z.string(),
  severity: z.enum(['critical', 'warning', 'info']),
  message:  z.string(),
  url:      z.string().optional(),
}).passthrough();

// ── Aegis redaction rider (REDACTION_BOUNDARY_MAX_PLAN.md Step 4 / [168i]) ──────
// Every guarded MCP tool response gains an optional `redaction` rider summarising how
// much detail was withheld at the trust boundary + a pointer to the full local report.
// Pinned `.optional()` so it is ADDITIVE (pre-Aegis / ARGUS_REDACT_SENSITIVE=0 opt-out
// responses still parse), but its shape is enforced WHEN PRESENT — a handler that renames
// `redacted` → `count` (or retypes it) fails [168i] instead of passing under .passthrough().
export const redactionRiderSchema = z.object({
  redacted:        z.number(),
  total:           z.number(),
  localReportPath: z.string().nullable().optional(),
  note:            z.string().optional(),
  failClosed:      z.boolean().optional(),
}).passthrough();

/** Cheap audit severity tally — { critical, warning, info } (no total). */
export const auditSummarySchema = z.object({
  critical: z.number(),
  warning:  z.number(),
  info:     z.number(),
}).passthrough();

/** Full report / env-comparison severity tally — adds `total`. */
export const reportSummarySchema = z.object({
  total:    z.number(),
  critical: z.number(),
  warning:  z.number(),
  info:     z.number(),
}).passthrough();

// ── 1. argus_audit ────────────────────────────────────────────────────────────

export const auditResponseSchema = z.object({
  findings:   z.array(findingSchema),
  summary:    auditSummarySchema,
  url:        z.string(),
  pageTitle:  z.string(),
  screenshot: z.string().nullable(),
  redaction:  redactionRiderSchema.optional(),   // Aegis Step 4 — additive egress rider
}).passthrough();

// ── 2. argus_audit_full + 4. argus_last_report (full report) ──────────────────

export const reportRouteSchema = z.object({
  route:       z.string(),
  url:         z.string(),
  crawledAt:   z.string(),
  errors:      z.array(findingSchema),
  pageTitle:   z.string(),
  isBlankPage: z.boolean(),
  screenshot:  z.string().nullable(),
}).passthrough();

export const reportSchema = z.object({
  generatedAt: z.string(),
  baseUrl:     z.string(),
  summary:     reportSummarySchema,
  routes:      z.array(reportRouteSchema),
  flows:       z.array(z.any()),
  codebase:    z.array(z.any()),
  redaction:   redactionRiderSchema.optional(),   // Aegis Step 4 — additive egress rider
}).passthrough();

/** argus_last_report: a full report, OR the no-reports sentinel. */
export const lastReportResponseSchema = z.union([
  reportSchema,
  z.object({ error: z.string() }).passthrough(),
]);

// ── 3. argus_compare — TWO response modes (discriminated on `mode`) ────────────
// runComparison() returns `env-comparison` when a real (non-localhost) staging URL is
// set, else falls back to `css-analysis` (CSS + API-frequency on the dev env only).
// The contract is the discriminated union of BOTH — a single-mode schema would
// silently pass whichever mode the developer's TARGET_STAGING_URL happened to
// produce (block [147] caught exactly that: the prototype env had staging set →
// env-comparison, the hermetic harness forces it off → css-analysis).

/** env-comparison route: a full diff result OR a per-route capture-failure result. */
export const compareEnvRouteSchema = z.object({
  route:      z.string(),
  devUrl:     z.string(),
  stagingUrl: z.string(),
  diffs:      z.array(z.any()),
  error:      z.string().optional(),   // present only on a per-route capture failure
}).passthrough();

export const compareEnvModeSchema = z.object({
  mode:        z.literal('env-comparison'),
  generatedAt: z.string(),
  devUrl:      z.string(),
  stagingUrl:  z.string(),
  summary:     reportSummarySchema,
  routes:      z.array(compareEnvRouteSchema),
  redaction:   redactionRiderSchema.optional(),   // Aegis Step 4 — additive egress rider
}).passthrough();

/** css-analysis route (no staging): per-route CSS + API-frequency findings on dev. */
export const compareCssRouteSchema = z.object({
  route:      z.string(),
  url:        z.string(),
  analyzedAt: z.string(),
  findings:   z.array(findingSchema),
  screenshot: z.string().nullable(),
}).passthrough();

export const compareCssModeSchema = z.object({
  mode:        z.literal('css-analysis'),
  generatedAt: z.string(),
  baseUrl:     z.string(),
  note:        z.string(),
  summary:     reportSummarySchema,
  routes:      z.array(compareCssRouteSchema),
  redaction:   redactionRiderSchema.optional(),   // Aegis Step 4 — additive egress rider
}).passthrough();

export const compareResponseSchema = z.discriminatedUnion('mode', [
  compareEnvModeSchema,
  compareCssModeSchema,
]);

// ── 5. argus_watch_snapshot ───────────────────────────────────────────────────

export const watchSnapshotResponseSchema = z.object({
  findings:   z.array(findingSchema),
  newConsole: z.array(z.any()),
  newNetwork: z.array(z.any()),
  redaction:  redactionRiderSchema.optional(),   // Aegis Step 4 — additive egress rider
}).passthrough();

// ── 6. argus_get_context ──────────────────────────────────────────────────────

export const openTabSchema = z.object({
  id:       z.number(),
  url:      z.string(),
  selected: z.boolean(),
}).passthrough();

export const getContextResponseSchema = z.object({
  snapshot_id:      z.string(),
  summary:          z.string(),
  url:              z.string(),
  timestamp:        z.string(),
  critical_issues:  z.array(findingSchema),
  warnings:         z.array(findingSchema),
  js_errors:        z.array(findingSchema),
  network_failures: z.array(findingSchema),
  console_errors:   z.array(z.any()),
  recent_requests:  z.array(z.any()),
  open_tabs:        z.array(openTabSchema),
  // Present only when a prior snapshot_id is supplied (fix-loop diff):
  resolved:   z.array(findingSchema).optional(),
  new_issues: z.array(findingSchema).optional(),
  persisting: z.array(findingSchema).optional(),
  redaction:  redactionRiderSchema.optional(),   // Aegis Step 4 — additive egress rider
}).passthrough();

// ── 7. argus_visual_diff ──────────────────────────────────────────────────────

export const visualDiffSummarySchema = z.object({
  status:      z.string(),
  diffPercent: z.number(),
  diffPixels:  z.number(),
  totalPixels: z.number(),
  severity:    z.string(),
}).passthrough();

export const visualDiffResponseSchema = z.object({
  findings:  z.array(findingSchema),
  summary:   visualDiffSummarySchema,
  redaction: redactionRiderSchema.optional(),   // Aegis Step 4 — additive egress rider
}).passthrough();

// ── 8. argus_design_audit ─────────────────────────────────────────────────────

export const designSummarySchema = z.object({
  tokenMismatches:      z.number(),
  missingComponents:    z.number(),
  colorMismatches:      z.number(),
  typographyMismatches: z.number(),
  spacingMismatches:    z.number(),
  radiusMismatches:     z.number(),
  boundsOverflows:      z.number(),
  positionDrifts:       z.number(),
  strokeMismatches:     z.number(),
  shadowMismatches:     z.number(),
  opacityMismatches:    z.number(),
  gapMismatches:        z.number(),
  textMismatches:       z.number(),
}).passthrough();

export const designAuditResponseSchema = z.object({
  findings:  z.array(findingSchema),
  summary:   designSummarySchema,
  error:     z.string().optional(),   // present only in the no-token / fetch-fail degraded path
  redaction: redactionRiderSchema.optional(),   // Aegis Step 4 — additive egress rider
}).passthrough();

// ── 9. argus_pr_validate ──────────────────────────────────────────────────────

/**
 * The `baseline` field (PR_VALIDATOR plan B1/B2 — handlePrValidate src/mcp-server.js:516).
 * A discriminated pair on `available`:
 *   - available:true  → numeric new/persisting/resolved counts (the head-vs-base diff)
 *   - available:false → the fail-safe `note` (baseline unavailable → absolute blocking)
 * Pinned so a rename inside baselineInfo (e.g. newCritical → newCrit) is caught, while
 * the discriminator keeps the two variants from cross-validating.
 */
export const prBaselineSchema = z.discriminatedUnion('available', [
  z.object({
    available:   z.literal(true),
    newCritical: z.number(),
    newWarning:  z.number(),
    newInfo:     z.number(),
    persisting:  z.number(),
    resolved:    z.number(),
  }).passthrough(),
  z.object({
    available: z.literal(false),
    note:      z.string(),
  }).passthrough(),
]);

/**
 * The `reporting` field (PR_VALIDATOR plan A4 — reportPrValidation github-reporter.js:672).
 * The PR-reporting side-effect summary appended via `{ ...result, reporting }`. Always three
 * booleans + an optional `reason` across every return path of reportPrValidation.
 */
export const prReportingSchema = z.object({
  posted:  z.boolean(),
  checked: z.boolean(),
  skipped: z.boolean(),
  reason:  z.string().optional(),
}).passthrough();

export const prValidateResponseSchema = z.object({
  prUrl:          z.string(),
  targetUrl:      z.string(),
  affectedRoutes: z.array(z.string()),
  changedFiles:   z.array(z.any()),
  findings:       z.array(findingSchema),
  perRoute:       z.array(z.any()),
  summary:        auditSummarySchema,   // { critical, warning, info } — NO total
  blocked:        z.boolean(),
  blockOn:        z.string(),
  // baseline (B1/B2) + reporting (A4) are ALWAYS present on the live handlePrValidate
  // response, but pinned `.optional()` here for two reasons: (1) [147] can't live-validate
  // this tool (it needs Chrome + a live PR + GitHub), so the schema can't enforce presence
  // anyway — the source cross-check [147i] guards the always-present core keys; (2) the
  // A1-era result shape (pre-baseline/pre-reporting) + the [153c] back-compat fixture must
  // still parse. When PRESENT, each inner shape IS pinned ([147o]/[147p] prove non-vacuous).
  // [147i] filters optional keys so it never demands `reporting` (spread-appended, not in
  // the `const result` literal) inside the handler's result object.
  baseline:       prBaselineSchema.optional(),
  reporting:      prReportingSchema.optional(),
  redaction:      redactionRiderSchema.optional(),   // Aegis Step 4 — additive egress rider
}).passthrough();

// ── Tool → schema map (the contract index) ────────────────────────────────────

/**
 * Maps every MCP tool name to its golden response schema. The harness coverage
 * ratchet ([147]) fails if the live `tools/list` returns a tool name absent from
 * this map — a new tool then CANNOT ship without a pinned response contract.
 */
export const TOOL_RESPONSE_SCHEMAS = {
  argus_audit:          auditResponseSchema,
  argus_audit_full:     reportSchema,
  argus_compare:        compareResponseSchema,
  argus_last_report:    lastReportResponseSchema,
  argus_watch_snapshot: watchSnapshotResponseSchema,
  argus_get_context:    getContextResponseSchema,
  argus_visual_diff:    visualDiffResponseSchema,
  argus_design_audit:   designAuditResponseSchema,
  argus_pr_validate:    prValidateResponseSchema,
};

export const TOOL_NAMES = Object.keys(TOOL_RESPONSE_SCHEMAS);

/**
 * Compact one-line summary of a failed safeParse — `path: message` per issue,
 * for embedding in a harness assertion's (got: …). Mirrors validateConfig().
 * @param {{ success: boolean, error?: import('zod').ZodError }} result
 */
export function formatZodError(result) {
  if (result.success) return 'valid';
  return result.error.issues
    .map(i => `${i.path.join('.') || '<root>'}: ${i.message}`)
    .join(' | ');
}
