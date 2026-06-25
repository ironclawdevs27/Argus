// Imported by no page — exercises the C1 "ambiguous → conservative fallback" guard:
// a changed file that no route renders must still audit ALL routes (never miss a regression).
export function orphan() {
  return 'unused-by-any-route';
}
