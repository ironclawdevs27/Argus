/**
 * Shared slugify helper — converts a human-readable string to a URL/filename-safe slug.
 * Used for screenshot filenames and report paths.
 */
export function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
