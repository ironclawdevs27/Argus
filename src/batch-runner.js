/**
 * Argus — multi-page batch audit entry point.
 * Re-exports the main crawl pipeline from crawl-and-report.js.
 * Run via: node src/batch-runner.js
 *
 * Config validation (Zod) runs inside runCrawl() — src/config/schema.js.
 */
export * from './orchestration/crawl-and-report.js';
