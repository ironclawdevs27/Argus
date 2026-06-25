// Imported by no page — exercises the monorepo "ambiguous → conservative fallback" guard
// (PR_VALIDATOR C2): a changed file under a workspace package that no route renders must
// still audit ALL routes (never miss a regression), even after the workspace-prefix strip.
export function orphan() {
  return 'unused-by-any-route';
}
