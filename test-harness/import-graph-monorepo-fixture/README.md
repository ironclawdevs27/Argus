<!-- Fixture for PR_VALIDATOR C2 — monorepo path awareness (harness block [157]). -->

# import-graph-monorepo-fixture

A minimal monorepo whose app lives under `apps/web/` — exercises the C2 path
awareness in `mapFilesToRoutesDeep` (src/utils/pr-diff-analyzer.js). The PR
Validator's `ARGUS_SOURCE_DIR` points at the package subdir (`apps/web`), while
GitHub returns changed-file paths relative to the **repo root** (`apps/web/...`).
C2's `packageRelativePath` strips the workspace prefix so those paths resolve into
the package's import graph instead of double-counting the prefix and missing.
Filesystem-only — never served over HTTP.

Package root: `apps/web` (set as `sourceDir`).

Routes (Next.js `pages/` convention, package-relative):

| Page file (repo-root path)        | Route       | Imports                       |
| --------------------------------- | ----------- | ----------------------------- |
| `apps/web/pages/index.jsx`        | `/`         | `../components/Hero`          |
| `apps/web/pages/checkout.jsx`     | `/checkout` | `../components/CartSummary`   |

Non-page modules:

| File (repo-root path)                  | Imported by  | Change maps to                     |
| -------------------------------------- | ------------ | ---------------------------------- |
| `apps/web/components/Hero.jsx`         | index        | `/`                                |
| `apps/web/components/CartSummary.jsx`  | checkout     | `/checkout`                        |
| `apps/web/lib/formatPrice.js`          | CartSummary  | `/checkout` (transitive)           |
| `apps/web/lib/orphan.js`               | *(nobody)*   | ALL routes (conservative fallback) |

A changed file in a DIFFERENT package (e.g. `apps/admin/...`) shares no overlap
with `apps/web`, never resolves into this graph, and therefore falls back to ALL
routes — it is never misattributed to a `web` route.
