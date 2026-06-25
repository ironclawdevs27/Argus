/**
 * Recorded-shape fixture for the GitHub REST API "List pull request files" endpoint
 *   GET /repos/{owner}/{repo}/pulls/{pull_number}/files  (api-version 2022-11-28)
 *
 * Representative response authored to the documented v2022-11-28 schema (NOT a live
 * capture — no token or private data is involved; this endpoint's body contains no
 * secrets). Only documented per-file fields are included: sha, filename, status,
 * additions, deletions, changes, blob_url, raw_url, contents_url, and patch.
 *
 * Notable cases this fixture exercises (consumed by block [137] + the Vitest unit test):
 *   - status values: 'added', 'modified', 'removed'
 *   - patch hunk text carrying real `@@ -a,b +c,d @@` headers (for Phase A3 line mapping)
 *   - a binary file (logo.png) for which GitHub OMITS `patch` entirely — fetchPrFiles
 *     must normalize the missing field to `patch: null`, never undefined.
 *   - a filename whose slug ('checkout') maps to a /checkout route (back-compat: the
 *     filename-only view still drives mapFilesToRoutes).
 *
 * The Argus consumer (fetchPrFiles) reads only filename / status / patch; the remaining
 * fields are kept so the fixture stays faithful to the real response shape.
 */

export const prFilesResponse = [
  {
    sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    filename: 'src/pages/checkout.tsx',
    status: 'modified',
    additions: 6,
    deletions: 2,
    changes: 8,
    blob_url: 'https://github.com/acme/shop/blob/feature/src/pages/checkout.tsx',
    raw_url: 'https://github.com/acme/shop/raw/feature/src/pages/checkout.tsx',
    contents_url: 'https://api.github.com/repos/acme/shop/contents/src/pages/checkout.tsx?ref=feature',
    patch:
      '@@ -12,7 +12,11 @@ export function Checkout() {\n' +
      '   const [items, setItems] = useState([]);\n' +
      '-  const total = items.reduce((s, i) => s + i.price, 0);\n' +
      '+  const total = items.reduce((s, i) => s + i.price * i.qty, 0);\n' +
      '+  const tax = total * 0.08;\n' +
      '   return (\n' +
      '-    <div>{total}</div>\n' +
      '+    <div data-testid="checkout-total">{total + tax}</div>\n' +
      '   );\n' +
      ' }',
  },
  {
    sha: 'b2c3d4e5f60718293a4b5c6d7e8f901234567890',
    filename: 'src/components/CartSummary.tsx',
    status: 'added',
    additions: 24,
    deletions: 0,
    changes: 24,
    blob_url: 'https://github.com/acme/shop/blob/feature/src/components/CartSummary.tsx',
    raw_url: 'https://github.com/acme/shop/raw/feature/src/components/CartSummary.tsx',
    contents_url: 'https://api.github.com/repos/acme/shop/contents/src/components/CartSummary.tsx?ref=feature',
    patch:
      '@@ -0,0 +1,24 @@\n' +
      '+import React from "react";\n' +
      '+\n' +
      '+export function CartSummary({ items }) {\n' +
      '+  return <aside>{items.length} items</aside>;\n' +
      '+}',
  },
  {
    sha: 'c3d4e5f60718293a4b5c6d7e8f90123456789012',
    filename: 'src/legacy/oldCart.js',
    status: 'removed',
    additions: 0,
    deletions: 41,
    changes: 41,
    blob_url: 'https://github.com/acme/shop/blob/main/src/legacy/oldCart.js',
    raw_url: 'https://github.com/acme/shop/raw/main/src/legacy/oldCart.js',
    contents_url: 'https://api.github.com/repos/acme/shop/contents/src/legacy/oldCart.js?ref=main',
    patch:
      '@@ -1,41 +0,0 @@\n' +
      '-// deprecated cart implementation\n' +
      '-module.exports = function oldCart() {};',
  },
  {
    sha: 'd4e5f60718293a4b5c6d7e8f9012345678901234',
    filename: 'public/logo.png',
    status: 'added',
    additions: 0,
    deletions: 0,
    changes: 0,
    blob_url: 'https://github.com/acme/shop/blob/feature/public/logo.png',
    raw_url: 'https://github.com/acme/shop/raw/feature/public/logo.png',
    contents_url: 'https://api.github.com/repos/acme/shop/contents/public/logo.png?ref=feature',
    // No `patch` key — GitHub omits it for binary files. fetchPrFiles must yield null.
  },
];

export default prFilesResponse;
