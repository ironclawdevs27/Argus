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
 * @param {{ type: string, severity: string, message: string, url?: string }} opts
 * @returns {Readonly<object>}
 */
export function createFinding({ type, severity, message, url = '', ...rest }) {
  if (!type)                           throw new Error(`Finding missing: type`);
  if (!VALID_SEVERITIES.has(severity)) throw new Error(`Invalid severity "${severity}" for type "${type}"`);
  if (!message)                        throw new Error(`Finding missing: message`);
  return Object.freeze({ type, severity, message, url, ...rest });
}
