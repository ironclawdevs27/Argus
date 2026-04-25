/**
 * Argus D7.7 — Slack-optional mode guard.
 *
 * Returns true only when a Slack Bot Token is present in the environment.
 * Used by crawl-and-report.js to decide whether to dispatch to Slack or fall
 * back to generating a local HTML report and opening it in the browser.
 *
 * Configure in .env:
 *   SLACK_BOT_TOKEN=xoxb-...   ← Slack active
 *   (absent)                   ← HTML-only mode
 */

/**
 * @returns {boolean} true when SLACK_BOT_TOKEN is set and non-empty
 */
export function isSlackConfigured() {
  return !!process.env.SLACK_BOT_TOKEN;
}
