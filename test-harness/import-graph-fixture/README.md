<!-- Fixture for PR_VALIDATOR C1 — framework-aware route mapping (harness block [156])
     + C3 — stylesheet attribution (harness block [158]). -->

# import-graph-fixture

A minimal Next.js `pages/` project whose component/util/stylesheet imports exercise
`mapFilesToRoutesDeep` (src/utils/pr-diff-analyzer.js) + `buildImportGraph`
(src/utils/import-graph.js). Filesystem-only — never served over HTTP.

Routes (Next.js `pages/` convention):

| Page file            | Route        | Imports                                  |
| -------------------- | ------------ | ---------------------------------------- |
| `pages/index.jsx`    | `/`          | `../components/Hero`                      |
| `pages/checkout.jsx` | `/checkout`  | `../components/CartSummary`               |
| `pages/about.jsx`    | `/about`     | `@/components/Profile` (tsconfig alias)   |

Non-page modules:

| File                   | Imported by                | Change maps to                |
| ---------------------- | -------------------------- | ----------------------------- |
| `components/Hero.jsx`        | index                | `/`                           |
| `components/CartSummary.jsx` | checkout             | `/checkout`                   |
| `components/Profile.jsx`     | about (via `@/` alias) | `/about` (alias resolution) |
| `lib/formatPrice.js`         | CartSummary          | `/checkout` (transitive)      |
| `lib/orphan.js`              | *(nobody)*           | ALL routes (conservative fallback) |

Stylesheets (PR_VALIDATOR C3 — tracked as import-graph leaf nodes):

| File                              | Imported by             | Change maps to                       |
| --------------------------------- | ----------------------- | ------------------------------------ |
| `components/CartSummary.module.css` | CartSummary           | `/checkout` (name slug-matches no route → heuristic blasts ALL, graph narrows) |
| `styles/brand.css`                | Hero + CartSummary      | `/` + `/checkout` (union; `/about` safely excluded) |
| `styles/theme.css`                | *(nobody)*              | ALL routes (conservative fallback — orphan stylesheet) |
