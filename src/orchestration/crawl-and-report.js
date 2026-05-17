/**
 * Argus Crawl Pipeline — backward-compat re-export shell (v9.2.0)
 *
 * The implementation has been split across three focused modules:
 *
 *   orchestrator.js     — crawl loop, route/flow crawl functions, runCrawl()
 *   report-processor.js — dedup, severity overrides, baseline, JSON write
 *   dispatcher.js       — Slack / GitHub / HTML dispatch
 *
 * All callers (argus.js, batch-runner.js, server handlers, test-harness)
 * continue to import from this file unchanged.
 */

export { runCrawl, crawlRouteCheap, crawlRouteExpensive } from './orchestrator.js';
export { processReport, deduplicateFindings, rebuildSummary } from './report-processor.js';
export { dispatchAll } from './dispatcher.js';
