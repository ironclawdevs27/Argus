/**
 * Recorded-shape fixtures for the GitHub REST API *reporting* endpoints the PR
 * Validator writes to (Phase A — github-reporter.js):
 *
 *   - GET   /repos/{owner}/{repo}/issues/{n}/comments   (list issue comments)
 *   - POST  /repos/{owner}/{repo}/issues/{n}/comments   (create a PR comment)
 *   - PATCH /repos/{owner}/{repo}/issues/comments/{id}  (update a PR comment)
 *   - POST  /repos/{owner}/{repo}/check-runs            (create a Check Run)
 *   - PATCH /repos/{owner}/{repo}/check-runs/{id}       (complete a Check Run)
 *   - POST  /repos/{owner}/{repo}/statuses/{sha}        (set a commit status)
 *   (api-version 2022-11-28)
 *
 * Companion to `github-pr-files-sample.js` (the diff-side fixture). These bodies are
 * authored to the documented v2022-11-28 schema, NOT live captures — there is no token
 * or private data in any reporting response body (GitHub returns the resource, never the
 * caller's credential). Only documented fields are included.
 *
 * Why this matters (what the inline `{ id: N }` stubs in blocks [151]/[152] CANNOT catch):
 * Argus reads real fields off these responses —
 *   - `postPrComment` scans the comments LIST for the one whose `body` contains
 *     COMMENT_MARKER, then PATCHes `/issues/comments/{that.id}` (idempotent update).
 *   - `createCheckRun` reads `id` off the create response to hand to `completeCheckRun`.
 * A faithful fixture (a rich object among several, an unrelated human comment, a bot
 * comment) proves Argus parses the documented shape, not a one-field toy — so a real
 * response-shape change (id dropped, body renamed, comment object flattened) is caught.
 *
 * Exported for reuse by harness block [166] and E2E sessions (E2E_PLAN.md): import the
 * data, or `makeReportingFetchStub()` to drive the real reporter functions network-free.
 */

// The marker github-reporter.js writes into every Argus PR comment (module-local
// COMMENT_MARKER over there). Recorded here as the literal body fragment; block [166a]
// cross-checks it against a live formatPrComment() render so the fixture can't drift.
export const ARGUS_COMMENT_MARKER = '<!-- argus-qa-report -->';

/** id of the prior Argus comment inside `issueCommentsListWithArgus` — the PATCH target. */
export const ARGUS_COMMENT_ID = 2071999001;
/** id returned when a NEW Argus comment is created (POST). */
export const NEW_COMMENT_ID = 2072450777;
/** id returned by the Check Run create POST (consumed by completeCheckRun). */
export const CHECK_RUN_ID = 9001;
/** PR head SHA the Check Run is anchored to. */
export const HEAD_SHA = 'deadbeefcafe0001deadbeefcafe0001deadbeef';

// ── Issue comment objects (list / create / update) ────────────────────────────
// GitHub "List issue comments" returns an array of these; create/update return one.

const humanCommentEarly = {
  id: 2071400100,
  node_id: 'IC_kwDOABCDEF5AbCdE',
  url: 'https://api.github.com/repos/acme/shop/issues/comments/2071400100',
  html_url: 'https://github.com/acme/shop/pull/7#issuecomment-2071400100',
  issue_url: 'https://api.github.com/repos/acme/shop/issues/7',
  user: {
    login: 'octo-reviewer',
    id: 5830012,
    node_id: 'MDQ6VXNlcjU4MzAwMTI=',
    type: 'User',
    site_admin: false,
  },
  created_at: '2026-06-20T09:12:04Z',
  updated_at: '2026-06-20T09:12:04Z',
  author_association: 'COLLABORATOR',
  body: 'Looks good overall — can you double check the checkout total math?',
};

const argusPriorComment = {
  id: ARGUS_COMMENT_ID,
  node_id: 'IC_kwDOABCDEF5AbZZZ',
  url: `https://api.github.com/repos/acme/shop/issues/comments/${ARGUS_COMMENT_ID}`,
  html_url: `https://github.com/acme/shop/pull/7#issuecomment-${ARGUS_COMMENT_ID}`,
  issue_url: 'https://api.github.com/repos/acme/shop/issues/7',
  user: {
    login: 'github-actions[bot]',
    id: 41898282,
    node_id: 'MDM6Qm90NDE4OTgyODI=',
    type: 'Bot',
    site_admin: false,
  },
  created_at: '2026-06-20T09:15:31Z',
  updated_at: '2026-06-20T09:31:02Z',
  author_association: 'NONE',
  // A previous Argus run's comment — carries the marker, so postPrComment updates THIS one.
  body:
    `${ARGUS_COMMENT_MARKER}\n## 🛡️ Argus QA Report\n\n` +
    '**⛔ Merge blocked** — 1 new critical finding(s) found on affected routes.\n\n' +
    '_(from a prior run — should be PATCHed in place, never duplicated)_',
};

const humanCommentLate = {
  id: 2071780900,
  node_id: 'IC_kwDOABCDEF5AbQQQ',
  url: 'https://api.github.com/repos/acme/shop/issues/comments/2071780900',
  html_url: 'https://github.com/acme/shop/pull/7#issuecomment-2071780900',
  issue_url: 'https://api.github.com/repos/acme/shop/issues/7',
  user: {
    login: 'octo-author',
    id: 5830099,
    node_id: 'MDQ6VXNlcjU4MzAwOTk=',
    type: 'User',
    site_admin: false,
  },
  created_at: '2026-06-20T10:02:48Z',
  updated_at: '2026-06-20T10:02:48Z',
  author_association: 'CONTRIBUTOR',
  body: 'Pushed a fix, PTAL.',
};

/** GET comments list WITH a prior Argus comment present → postPrComment must PATCH it. */
export const issueCommentsListWithArgus = [humanCommentEarly, argusPriorComment, humanCommentLate];

/** GET comments list with NO Argus comment (only humans) → postPrComment must POST a new one. */
export const issueCommentsListNoArgus = [humanCommentEarly, humanCommentLate];

/** POST create-comment 201 response. */
export const issueCommentCreateResponse = {
  id: NEW_COMMENT_ID,
  node_id: 'IC_kwDOABCDEF5AcNEW',
  url: `https://api.github.com/repos/acme/shop/issues/comments/${NEW_COMMENT_ID}`,
  html_url: `https://github.com/acme/shop/pull/7#issuecomment-${NEW_COMMENT_ID}`,
  issue_url: 'https://api.github.com/repos/acme/shop/issues/7',
  user: { login: 'github-actions[bot]', id: 41898282, type: 'Bot', site_admin: false },
  created_at: '2026-06-21T08:00:00Z',
  updated_at: '2026-06-21T08:00:00Z',
  author_association: 'NONE',
  body: `${ARGUS_COMMENT_MARKER}\n## 🛡️ Argus QA Report\n\n(new comment body echoed back by GitHub)`,
};

/** PATCH update-comment 200 response (same id as the existing Argus comment). */
export const issueCommentUpdateResponse = {
  ...argusPriorComment,
  updated_at: '2026-06-21T08:00:00Z',
  body: `${ARGUS_COMMENT_MARKER}\n## 🛡️ Argus QA Report\n\n(updated comment body echoed back by GitHub)`,
};

// ── Check Run objects (create / complete) ─────────────────────────────────────

/** POST create-check-run 201 response — `id` is consumed by completeCheckRun(). */
export const checkRunCreateResponse = {
  id: CHECK_RUN_ID,
  head_sha: HEAD_SHA,
  node_id: 'CR_kwDOABCDEF8AAAAAAiVK2Q',
  external_id: '',
  url: `https://api.github.com/repos/acme/shop/check-runs/${CHECK_RUN_ID}`,
  html_url: `https://github.com/acme/shop/runs/${CHECK_RUN_ID}`,
  details_url: 'https://github.com/acme/shop/actions/runs/123',
  status: 'in_progress',
  conclusion: null,
  started_at: '2026-06-21T08:00:01Z',
  completed_at: null,
  name: 'argus-qa',
  check_suite: { id: 55500001 },
  app: { id: 15368, slug: 'github-actions', name: 'GitHub Actions' },
  output: { title: null, summary: null, text: null, annotations_count: 0 },
};

/** PATCH complete-check-run 200 response (status completed + conclusion). */
export const checkRunCompleteResponse = {
  ...checkRunCreateResponse,
  status: 'completed',
  conclusion: 'failure',
  completed_at: '2026-06-21T08:00:09Z',
  output: {
    title: 'Argus: merge blocked — 1 new critical finding(s) found',
    summary: 'Argus: merge blocked — 1 new critical finding(s) found',
    text: '## 🛡️ Argus QA Report\n\n...',
    annotations_count: 0,
  },
};

// ── Commit status object (setCommitStatus) ────────────────────────────────────

/** POST create-commit-status 201 response. */
export const commitStatusResponse = {
  id: 30000001,
  node_id: 'SC_kwDOABCDEF7AAAAAB',
  url: `https://api.github.com/repos/acme/shop/statuses/${HEAD_SHA}`,
  state: 'failure',
  description: 'Argus: 1 new critical issue(s) — merge blocked (threshold: 1)',
  target_url: null,
  context: 'argus-qa',
  created_at: '2026-06-21T08:00:00Z',
  updated_at: '2026-06-21T08:00:00Z',
  creator: { login: 'github-actions[bot]', id: 41898282, type: 'Bot', site_admin: false },
};

// ── Reusable network-free fetch stub ──────────────────────────────────────────

/**
 * Build a `globalThis.fetch` replacement that routes the reporting endpoints to the
 * recorded responses above. Drives the REAL reporter functions (postPrComment /
 * createCheckRun / completeCheckRun / setCommitStatus / reportPrValidation) with no
 * network. Each call is forwarded to `onRequest({ url, method, body, headers })` so the
 * caller can assert request shape (endpoint, method, body, Authorization header).
 *
 * @param {object} [opts]
 * @param {Array}  [opts.comments]  - the array the comments-list GET returns
 *                                    (default: list WITH a prior Argus comment).
 * @param {(req: { url: string, method: string, body: any, headers: any }) => void} [opts.onRequest]
 * @returns {(url: string, options?: object) => Promise<{ ok: boolean, status: number, json: () => Promise<any>, text: () => Promise<string> }>}
 */
export function makeReportingFetchStub({ comments = issueCommentsListWithArgus, onRequest } = {}) {
  return async (url, options = {}) => {
    const method = options.method ?? 'GET';
    if (onRequest) onRequest({ url, method, body: options.body, headers: options.headers });
    const reply = (status, json) => ({
      ok: status < 400,
      status,
      json: async () => json,
      text: async () => JSON.stringify(json),
    });
    if (method === 'GET'   && /\/issues\/\d+\/comments(\?|$)/.test(url)) return reply(200, comments);
    if (method === 'POST'  && /\/issues\/\d+\/comments$/.test(url))      return reply(201, issueCommentCreateResponse);
    if (method === 'PATCH' && /\/issues\/comments\/\d+$/.test(url))      return reply(200, issueCommentUpdateResponse);
    if (method === 'POST'  && /\/check-runs$/.test(url))                 return reply(201, checkRunCreateResponse);
    if (method === 'PATCH' && /\/check-runs\/\d+$/.test(url))            return reply(200, checkRunCompleteResponse);
    if (method === 'POST'  && /\/statuses\//.test(url))                  return reply(201, commitStatusResponse);
    return reply(200, {});
  };
}

export default {
  issueCommentsListWithArgus,
  issueCommentsListNoArgus,
  issueCommentCreateResponse,
  issueCommentUpdateResponse,
  checkRunCreateResponse,
  checkRunCompleteResponse,
  commitStatusResponse,
  makeReportingFetchStub,
  ARGUS_COMMENT_MARKER,
  ARGUS_COMMENT_ID,
  NEW_COMMENT_ID,
  CHECK_RUN_ID,
  HEAD_SHA,
};
