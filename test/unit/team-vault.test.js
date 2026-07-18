/**
 * Aegis — team-vault routing unit suite (Chrome-free).
 *
 * The last T3 sub-item (AEGIS_FOR_TEAMS_PLAN.md §9): when a governance token AND a
 * team-vault endpoint URL are set, `token` mode routes the reversible token→secret
 * mapping to the org's CENTRAL vault instead of the local 0600 file, so a token
 * minted on a laptop/CI can be re-hydrated through the org's authorized RBAC flow.
 * Proves the invariants the enterprise moat rests on:
 *   - ACTIVATION: inert unless BOTH ARGUS_GOV_TOKEN and ARGUS_REDACT_VAULT_URL set.
 *   - MINT + BUFFER: token mode emits an information-free AEGIS_<hmac16> token and
 *     buffers the token→secret mapping (deduped); the secret never appears in the
 *     redacted egress artifact.
 *   - FLUSH: the buffered mappings POST to the vault URL with the gov-token bearer;
 *     the SECRET travels only to that authorized endpoint; buffer clears on success.
 *   - FAIL-CLOSED: a throwing / HTTP-error flush never throws and retains the buffer
 *     (the emitted token is already safe — a failed flush leaks nothing).
 *   - OPT-IN DEFAULT-IDENTICAL: team OFF ⇒ token mode masks (or uses the local vault),
 *     nothing is buffered, and flushTeamVault is inert (no network).
 *   - PRECEDENCE: the team vault wins over the local ARGUS_REDACT_VAULT vault (§4.3).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  teamVaultActive, teamTokenFor, ensureTeamVaultWired, ensureTokenVaultWired,
  flushTeamVault, pendingTeamVaultCount, _resetTeamVaultForTests,
} from '../../src/utils/team-vault.js';
import { deepScrub } from '../../src/utils/sensitivity-classifier.js';
import { scrubText } from '../../src/utils/secret-patterns.js';
import { _resetVaultForTests, computeToken as vaultComputeToken } from '../../src/utils/aegis-vault.js';

// A real HS256 JWT — the signature tail is the genuinely-secret probe (the engine's
// masker keeps only the universal `eyJh` header prefix, which reveals nothing).
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
const SECRET_TAIL = 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
const VAULT_URL = 'https://control-plane.example.com/api/gov/vault';
const AEGIS_TOKEN_RE = /AEGIS_[0-9a-f]{16}/;

// Snapshot + restore the env vars this suite mutates, so tests are order-independent.
const ENV_KEYS = ['ARGUS_GOV_TOKEN', 'ARGUS_REDACT_VAULT_URL', 'ARGUS_REDACT_MODE', 'ARGUS_REDACT_VAULT', 'ARGUS_REDACT_SENSITIVE'];
let saved;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  _resetTeamVaultForTests();
  _resetVaultForTests();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetTeamVaultForTests();
  _resetVaultForTests();
});

function activate() {
  process.env.ARGUS_GOV_TOKEN = 'argus_gov_testtoken';
  process.env.ARGUS_REDACT_VAULT_URL = VAULT_URL;
  process.env.ARGUS_REDACT_MODE = 'token';
  _resetTeamVaultForTests();
}

describe('team-vault activation (opt-in)', () => {
  it('is inert by default (no gov token, no vault URL)', () => {
    expect(teamVaultActive()).toBe(false);
    expect(ensureTeamVaultWired()).toBe(false);
  });

  it('requires BOTH a gov token AND a vault URL', () => {
    process.env.ARGUS_GOV_TOKEN = 'argus_gov_testtoken';
    expect(teamVaultActive()).toBe(false); // URL still missing
    delete process.env.ARGUS_GOV_TOKEN;
    process.env.ARGUS_REDACT_VAULT_URL = VAULT_URL;
    expect(teamVaultActive()).toBe(false); // token still missing
    process.env.ARGUS_GOV_TOKEN = 'argus_gov_testtoken';
    expect(teamVaultActive()).toBe(true);
  });
});

describe('mint + buffer', () => {
  it('mints an information-free AEGIS token and buffers the mapping; the secret never reaches egress', () => {
    activate();
    const out = JSON.stringify(deepScrub({ header: `Authorization: Bearer ${JWT}` }));
    expect(out).toMatch(AEGIS_TOKEN_RE);          // a token was emitted
    expect(out).not.toContain(SECRET_TAIL);       // the secret did NOT cross the boundary
    expect(pendingTeamVaultCount()).toBeGreaterThanOrEqual(1);
  });

  it('the token equals the deterministic HMAC (aegis-vault computeToken)', () => {
    activate();
    const tok = teamTokenFor(JWT);
    expect(tok).toBe(vaultComputeToken(JWT)); // same machine key ⇒ same token
    expect(tok).toMatch(/^AEGIS_[0-9a-f]{16}$/);
  });

  it('dedupes the same secret to one buffered mapping', () => {
    activate();
    teamTokenFor(JWT);
    teamTokenFor(JWT);
    teamTokenFor(JWT);
    expect(pendingTeamVaultCount()).toBe(1);
  });
});

describe('flush', () => {
  it('POSTs {mappings:[{token,secret}]} to the vault URL with the gov-token bearer; buffer clears', async () => {
    activate();
    teamTokenFor(JWT);
    let captured = null;
    let capturedHeaders = null;
    const res = await flushTeamVault({
      fetchImpl: async (url, opts) => { captured = { url, body: JSON.parse(opts.body) }; capturedHeaders = opts.headers; return { ok: true, status: 200 }; },
    });
    expect(res.posted).toBe(true);
    expect(res.count).toBe(1);
    expect(captured.url).toBe(VAULT_URL);
    expect(capturedHeaders.Authorization).toBe('Bearer argus_gov_testtoken');
    expect(captured.body.mappings).toHaveLength(1);
    expect(captured.body.mappings[0].token).toMatch(/^AEGIS_[0-9a-f]{16}$/);
    // The secret is DELIBERATELY sent (centralized-vault contract §5.2) so the cloud
    // can encrypt it at rest for a later authorized re-hydration.
    expect(captured.body.mappings[0].secret).toContain(SECRET_TAIL);
    expect(pendingTeamVaultCount()).toBe(0); // cleared on success
  });

  it('scrubs the artifactRef provenance field', async () => {
    activate();
    teamTokenFor('x');
    let body = null;
    await flushTeamVault({ fetchImpl: async (_u, o) => { body = JSON.parse(o.body); return { ok: true, status: 200 }; }, artifactRef: `report-with-${JWT}` });
    expect(body.artifactRef).not.toContain(SECRET_TAIL); // provenance is scrubbed
  });

  it('is a no-op with an empty buffer', async () => {
    activate();
    const res = await flushTeamVault({ fetchImpl: async () => { throw new Error('should-not-be-called'); } });
    expect(res).toEqual({ posted: true, count: 0 });
  });
});

describe('fail-closed', () => {
  it('a throwing fetch never throws and retains the buffer', async () => {
    activate();
    teamTokenFor(JWT);
    const res = await flushTeamVault({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    expect(res.posted).toBe(false);
    expect(pendingTeamVaultCount()).toBe(1); // retained for a later flush; token already safe
  });

  it('an HTTP-error response is fail-closed (posted:false, buffer retained)', async () => {
    activate();
    teamTokenFor(JWT);
    const res = await flushTeamVault({ fetchImpl: async () => ({ ok: false, status: 500 }) });
    expect(res.posted).toBe(false);
    expect(pendingTeamVaultCount()).toBe(1);
  });
});

describe('opt-in default-identical', () => {
  it('team OFF ⇒ token mode masks (no AEGIS token), nothing buffered, JWT still redacted', () => {
    process.env.ARGUS_REDACT_MODE = 'token'; // token mode, but NO gov token / vault URL
    _resetTeamVaultForTests();
    const out = JSON.stringify(deepScrub({ header: `Bearer ${JWT}` }));
    expect(out).not.toMatch(AEGIS_TOKEN_RE);   // no team token minted
    expect(out).not.toContain(SECRET_TAIL);    // still redacted (masked)
    expect(pendingTeamVaultCount()).toBe(0);   // nothing buffered
  });

  it('team OFF ⇒ flushTeamVault is inert (no network)', async () => {
    const res = await flushTeamVault({ fetchImpl: async () => { throw new Error('should-not-be-called'); } });
    expect(res).toEqual({ posted: false, count: 0, reason: 'inactive' });
  });
});

describe('precedence (team vault > local vault, §4.3)', () => {
  it('ensureTokenVaultWired wires the TEAM tokenizer when both team + local vault are enabled', () => {
    process.env.ARGUS_REDACT_VAULT = '1';       // local vault ON
    process.env.ARGUS_GOV_TOKEN = 'argus_gov_testtoken';
    process.env.ARGUS_REDACT_VAULT_URL = VAULT_URL; // team vault ON
    _resetTeamVaultForTests();
    _resetVaultForTests();
    expect(ensureTokenVaultWired()).toBe(true);
    // A token-mode scrub now buffers to the TEAM vault (not the local file).
    const out = scrubText(`Bearer ${JWT}`, { mode: 'token' });
    expect(out).toMatch(AEGIS_TOKEN_RE);
    expect(pendingTeamVaultCount()).toBe(1); // buffered for the team flush, not written locally
  });

  it('ensureTokenVaultWired falls back to the local vault when the team vault is inactive', () => {
    process.env.ARGUS_REDACT_VAULT = '1'; // local vault ON, team OFF
    _resetTeamVaultForTests();
    _resetVaultForTests();
    expect(ensureTokenVaultWired()).toBe(true); // local vault wired
    expect(teamVaultActive()).toBe(false);
    const out = scrubText(`Bearer ${JWT}`, { mode: 'token' });
    expect(out).toMatch(AEGIS_TOKEN_RE);      // local vault mints a token
    expect(pendingTeamVaultCount()).toBe(0);  // NOT buffered for the team (local file instead)
  });
});
