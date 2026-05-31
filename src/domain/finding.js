/**
 * Finding factory — enforces required fields and valid severity at creation time.
 *
 * All analyzer modules should build findings with createFinding() instead of
 * raw object literals so missing fields throw at dev time rather than silently
 * producing malformed reports.
 *
 * Object.freeze() prevents accidental mutation as findings pass through the
 * dedup, severity-override, and baseline-diff pipeline.
 */

const VALID_SEVERITIES = new Set(['critical', 'warning', 'info']);

/**
 * Create an immutable finding object.
 *
 * Required fields: type, severity ('critical'|'warning'|'info'), message.
 * Common optional fields passed via ...rest (use these names for consistency):
 *   url         — affected URL (defaults to '')
 *   selector    — CSS selector of the offending element
 *   requestUrl  — URL of the offending network request
 *   status      — HTTP status code (number)
 *   method      — HTTP method string
 *   element     — human-readable element description (e.g. 'button#submit')
 *   property    — CSS property name
 *   metric      — performance metric name (e.g. 'LCP')
 *   value       — measured value
 *   budget      — expected threshold value
 *   count       — numeric count of occurrences
 *   source      — source file or stylesheet path
 *
 * @param {{ type: string, severity: string, message: string, url?: string, [key: string]: any }} opts
 * @returns {Readonly<object>}
 */
export function createFinding({ type, severity, message, url = '', ...rest }) {
  if (!type)                           throw new Error(`Finding missing: type`);
  if (!VALID_SEVERITIES.has(severity)) throw new Error(`Invalid severity "${severity}" for type "${type}"`);
  if (!message)                        throw new Error(`Finding missing: message`);
  return Object.freeze({ type, severity, message, url, ...rest });
}
