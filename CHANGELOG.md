# Changelog

All notable changes to Argus are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/).

> The published npm package is [`argusqa-os`](https://www.npmjs.com/package/argusqa-os)
> and the GitHub Action is version-pinned per release in `action.yml`.

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
