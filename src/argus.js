/**
 * Argus — single-page audit entry point.
 * Re-exports the main crawl pipeline from crawl-and-report.js.
 * Run via: npm run crawl  (or node src/argus.js)
 *
 * Config validation (Zod) runs inside runCrawl() — src/config/schema.js.
 */
export * from './orchestration/crawl-and-report.js';
