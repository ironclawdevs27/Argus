import { childLogger } from './logger.js';

const logger = childLogger('retry');

/**
 * withRetry — exponential-backoff retry wrapper for transient CDP failures.
 *
 * Applied in CdpBrowserAdapter to navigate() and fill() — idempotent operations
 * most likely to fail transiently under load. click() is intentionally excluded
 * (not idempotent — a retry could submit forms or trigger deletions twice).
 *
 * Set ARGUS_RETRY_ATTEMPTS=1 to disable retries (e.g. CI).
 * Non-numeric values fall back to 3 silently.
 *
 * @param {() => Promise<*>} fn       - Async function to call
 * @param {object}           opts
 * @param {number}           opts.attempts  - Max total attempts (default: ARGUS_RETRY_ATTEMPTS ?? 3)
 * @param {number}           opts.delayMs   - Base delay in ms; doubles each attempt (default: 400)
 * @param {string}           opts.label     - Human-readable label for debug logging
 * @returns {Promise<*>} Result of fn on success
 * @throws  Last error if all attempts fail
 */
export async function withRetry(fn, { attempts, delayMs = 400, label = '' } = {}) {
  const parsed = parseInt(process.env.ARGUS_RETRY_ATTEMPTS ?? '3', 10);
  const maxAttempts = attempts ?? (Number.isFinite(parsed) && parsed >= 1 ? parsed : 3);
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === maxAttempts - 1) throw err;
      const wait = delayMs * Math.pow(2, i);
      logger.debug(`[ARGUS] ${label ? label + ': ' : ''}retry ${i + 1}/${maxAttempts - 1} after ${wait}ms — ${err.constructor?.name ?? 'Error'}: ${err.message}`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}
