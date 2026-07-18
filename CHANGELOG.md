# Changelog

All notable changes to Argus are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/).

> The published npm package is [`argusqa-os`](https://www.npmjs.com/package/argusqa-os)
> and the GitHub Action is version-pinned per release in `action.yml`.

---

## [10.0.0] — 2026-07-18

### Aegis for Teams — org governance for the egress boundary

Builds on the v9.9.0 Aegis confidentiality boundary with **optional, opt-in**
organization-level governance. Every feature below is **inert by default** — with
no policy and no governance token set, output is **byte-identical to v9.9.0**.
There is **no default behavior change** and **no new runtime dependency**.

**What's new (all opt-in).**
- **Structured org policy** (`ARGUS_REDACT_POLICY`, inline JSON, or the `policy`
  param): toggle which of the 13 secret / 7 PII detectors run, add org-custom
  secret patterns, widen the sensitive finding-type set, and narrow the egress
  field allowlist. The policy can only ever make redaction **stricter** — the
  allowlist is **narrow-only** (intersection), the sensitive-type set is
  **widen-only** (union), and the statistical-entropy layer + category / body
  catch-alls are **not** policy-toggleable (the no-leak floor). A missing,
  malformed, or throwing policy **fails closed** to the strict floor.
- **Governance seam** (`ARGUS_GOV_TOKEN` + `ARGUS_REDACT_POLICY_URL` +
  `ARGUS_REDACT_POLICY_PUBKEY`): a self-hosted / CI bridge that fetches the org's
  **Ed25519-signed** policy from a central control plane, **verifies** it against
  a pinned public key, applies it, TTL-caches it, and posts **secret-free**
  redaction aggregates (label counts only) to an optional audit sink. Any fetch /
  verify / parse error **fails closed** to the strict floor — a bad signature
  never loosens redaction. When a governance token is present it **clamps** the
  local `ARGUS_REDACT_SENSITIVE=0` opt-out so a member can't disable the org
  policy locally. Inert without `ARGUS_GOV_TOKEN` — no phone-home by default.
- **Team-vault routing** (`ARGUS_REDACT_MODE=token` + a governance token +
  `ARGUS_REDACT_VAULT_URL`): route the reversible token→secret mapping to the
  org's central vault (re-hydratable via an authorized RBAC flow) instead of the
  local `0600` file. The information-free token still crosses every other sink;
  the secret travels **only** to the bearer-authed vault endpoint. Best-effort +
  fail-closed (a failed flush leaks nothing — the emitted token carries no
  information — it only forgoes central re-hydration).

#### New configuration (`.env`)

| Variable | Default | Description |
|---|---|---|
| `ARGUS_REDACT_POLICY` | unset | Inline-JSON org policy. Unset ⇒ byte-identical default; malformed ⇒ fail-closed strict floor |
| `ARGUS_GOV_TOKEN` | unset | Governance token (bearer) — the master switch for the governance seam |
| `ARGUS_REDACT_POLICY_URL` | unset | Endpoint serving the org's Ed25519-signed policy |
| `ARGUS_REDACT_POLICY_PUBKEY` | unset | The org's pinned Ed25519 public key (PEM/SPKI) used to verify the policy |
| `ARGUS_REDACT_AUDIT_URL` | unset | Sink for secret-free redaction aggregates (best-effort) |
| `ARGUS_REDACT_POLICY_TTL_MS` | `300000` | Policy re-fetch interval (5 min) |
| `ARGUS_REDACT_VAULT_URL` | unset | Central team-vault endpoint for `mode=token` mappings |

#### Added
- `src/utils/redaction-policy.js` — pure, zero-dependency, zero-I/O policy
  resolver (`resolvePolicy` / `effectivePolicyOpts` / `policyFromEnv`); fails
  closed to a strict default on any bad input.
- `src/utils/governance-seam.js` — opt-in Ed25519 fetch / verify wrapper
  (`ensureGovernancePolicy` / `verifySignedPolicy` / `postRedactionAggregate`);
  `node:crypto` + global `fetch` only, no new dependency.
- `src/utils/team-vault.js` — opt-in `mode=token` → central-vault routing
  (`teamVaultActive` / `flushTeamVault` / `ensureTokenVaultWired`).
- Harness blocks `[170]` (policy param), `[171]` (governance seam), and `[172]`
  (team-vault routing); three new Chrome-free unit suites (redaction-policy,
  governance-seam, team-vault).

### Changed
- Harness grows to **171 blocks / 998 hard assertions** (was 168 / 978); unit
  suite to **562** Chrome-free tests (was 495).

Published to npm as `argusqa-os@10.0.0`; GitHub Action pinned to `10.0.0`.

---

## [9.9.0] — 2026-06-30

### ⚠️ Behavior change (default ON) — Aegis confidentiality egress boundary

Argus now redacts secrets, PII, and exploit detail at **every external sink**
before a finding can cross your trust boundary. This is a **default-ON behavior
change** for external output, called out prominently here per the release policy.

**What changes for external output.** A finding sent to an external sink — an
**MCP tool response** (which lands in the calling agent's context window and
transits to that agent's model provider), a **Slack** message, a **GitHub** PR
comment plus its `::error` / `::warning` annotations, the **hosted / CI HTML
report**, and **CI logs / the step summary** — is now reduced to a need-to-know
projection. A **sensitive** finding crosses as its `type` + `route` + `severity`
+ a `🔒 redacted` marker and **never** its raw payload (`message`, `evidence`,
`snippet`, request/response bodies, headers, cookies, stack). URLs are projected
with the query string and fragment stripped (tokens hide in query params). A
**benign** finding keeps its `message`, but that message is still scrubbed for
any accidentally-embedded secret or PII.

**What does NOT change.** The **local on-disk JSON report and the locally-opened
HTML report keep 100% fidelity.** Nothing is ever lost locally — redaction only
removes detail on the way *out*.

**Safety posture.** Aegis **fails closed**: on any classifier error or unknown
finding shape it redacts *more*, never less (the one deliberate inversion of
Argus's other fail-safe post-processors). Field handling is **deny-by-default** —
only an explicit allowlist of safe fields may ever cross, each through its own
sanitizer, so a finding field added in the future leaks nothing until it is
deliberately allowlisted.

**Opt-out.** Set `ARGUS_REDACT_SENSITIVE=0` for output that is **byte-identical
to pre-Aegis**. There is deliberately no break-glass to disable fail-closed;
`ARGUS_REDACT_SENSITIVE=0` is the only opt-out.

This implements the OWASP **LLM02:2025 — Sensitive Information Disclosure**
mitigations (data minimization, redaction, deny-by-default egress filtering) at
Argus's own boundaries. It is an application-layer DLP control and composes with —
does not replace — a network egress proxy or a provider zero-data-retention tier.

#### New configuration (`.env`)

| Variable | Default | Description |
|---|---|---|
| `ARGUS_REDACT_SENSITIVE` | ON | `0` disables the whole layer (byte-identical pre-Aegis opt-out) |
| `ARGUS_REDACT_MODE` | `mask` | Matched-span style: `mask` \| `label` \| `hash` \| `token` \| `drop` |
| `ARGUS_REDACT_HTML` | off locally / ON in CI | `1` redacts the hosted HTML report too |
| `ARGUS_REDACT_VAULT` | OFF | `1` (with `ARGUS_REDACT_MODE=token`) mints reversible, information-free `AEGIS_<hmac16>` tokens into a local `0600` vault; re-inflate locally with `npm run report:rehydrate -- <report.json>` |
| `ARGUS_REDACT_VAULT_DIR` / `ARGUS_REDACT_AUDIT_DIR` | `reports/.aegis-vault` / `reports/.aegis-audit` | relocate the (gitignored, `0600`) vault / provenance dirs |

#### Added
- `src/utils/secret-patterns.js` — zero-dependency secret/PII core: 13 secret
  rules (JWT, AWS id/secret, Google, Slack, OpenAI/Anthropic, GitHub PAT/token,
  PEM, Bearer, basic-auth URL, generic assignment) + 7 PII rules (email, E.164
  phone, Luhn-validated card, SSN, IPv4/IPv6, private host) + context-word
  boosting; Shannon entropy as the live zero-dep statistical-rarity fallback
  (with an injectable BPE token-efficiency seam). Re-exports `scrubSecrets` so
  existing callers are unchanged.
- `src/utils/sensitivity-classifier.js` — the 5-layer `classifySensitivity`
  detector plus the deny-by-default `redactForEgress` / `redactReport` /
  `deepScrub` projection and `summarizeRedaction`; fail-closed throughout.
- `src/utils/aegis-vault.js` — optional, default-OFF reversible re-hydration
  vault (HMAC tokens, per-machine `0600` key, secret-free audit trail) +
  `scripts/rehydrate-report.mjs` (`npm run report:rehydrate`).
- Pipeline wiring (`report-processor.js` step 3c) and egress guards at all five
  sinks (`mcp-server.js` — all 9 tools, with an optional `redaction` rider;
  `dispatcher.js`; `github-reporter.js`; `html-reporter.js`; `cli/pr-validate.js`).
- Six Chrome-free unit suites (secret-patterns, sensitivity-classifier, a
  fast-check fuzz invariant, a red-team adversarial suite, sinks, vault) and
  harness blocks `[168]` (engine + pipeline + MCP boundary) and `[169]`
  (Slack / GitHub / HTML / CI-log sinks).

### Changed
- Harness grows to **168 blocks / 978 hard assertions** (was 166 / 961); unit
  suite to **495** Chrome-free tests (was 366).

Published to npm as `argusqa-os@9.9.0`; GitHub Action pinned to `9.9.0`.

---

## [9.8.1] — 2026-06-27

### Security
- CodeQL hardening: fixed a filesystem TOCTOU in `import-graph.js` (collapsed
  stat→read into a single `fd`); removed 2 unused vars.
- `session-persistence.js` and `argus init` now write `.env` / session files
  owner-only (`0600`) so captured cookies / Web Storage and Slack/GitHub/Figma
  tokens are never world-readable.
- Dependency CVEs patched (`hono`, `form-data`) → `npm audit` reports 0
  vulnerabilities.

### Added
- Landing-page **Growth** section: live npm download charts plus point-in-time
  GitHub-traffic / Socket-score / Pulse-rank panels.

---

## [9.8.0] — 2026-06-26

### Added
- **PR Validator** end-to-end (Phases A–E): idempotent PR comment + Check Run,
  baseline-aware merge blocking (blocks on findings the PR *introduces*),
  framework-aware route mapping (import-graph), monorepo path awareness,
  bounded-concurrency route auditing, selective analyzer depth, deploy-preview
  URL auto-detection, per-route timeout/retry, and resilient GitHub API access.

### Changed
- HTML report brand restyle.

Published to npm as `argusqa-os@9.8.0`; GitHub Action pinned to `9.8.0`.
