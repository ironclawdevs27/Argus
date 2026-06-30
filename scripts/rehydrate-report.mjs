#!/usr/bin/env node
/**
 * Aegis rehydrate CLI (Step 8 of REDACTION_BOUNDARY_MAX_PLAN.md).
 *
 * Re-inflates a token-redacted report LOCALLY by swapping every `AEGIS_` vault token
 * back to its original from the on-disk vault. This is a LOCAL-ONLY operator tool —
 * it requires the per-machine vault key + the mapping files under
 * reports/.aegis-vault/ (both 0600, gitignored). The token that crossed the trust
 * boundary is information-free; only this machine can re-hydrate.
 *
 *   npm run report:rehydrate -- <report.json> [--stdout]
 *
 * Without --stdout, writes <report>.rehydrated.json next to the input and prints the
 * path. The original (redacted) file is never modified.
 */
import fs from 'fs';
import { rehydrate, loadVault } from '../src/utils/aegis-vault.js';

const args = process.argv.slice(2);
const toStdout = args.includes('--stdout');
const file = args.find((a) => !a.startsWith('--'));

if (!file) {
  console.error('Usage: npm run report:rehydrate -- <report.json> [--stdout]');
  process.exit(1);
}

let raw;
try {
  raw = fs.readFileSync(file, 'utf8');
} catch (err) {
  console.error(`[Aegis] cannot read ${file}: ${err.message}`);
  process.exit(1);
}

let obj;
try {
  obj = JSON.parse(raw);
} catch (err) {
  console.error(`[Aegis] ${file} is not valid JSON: ${err.message}`);
  process.exit(1);
}

const vault = loadVault();
if (vault.size === 0) {
  console.error('[Aegis] vault is empty — nothing to rehydrate. Was ARGUS_REDACT_VAULT=1 (and ARGUS_REDACT_MODE=token) set during the run?');
}

const out = rehydrate(obj, vault);

if (toStdout) {
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
} else {
  const outPath = file.replace(/\.json$/i, '') + '.rehydrated.json';
  try {
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
    console.error(`[Aegis] rehydrated using ${vault.size} mapping(s) → ${outPath}`);
  } catch (err) {
    console.error(`[Aegis] could not write ${outPath}: ${err.message}`);
    process.exit(1);
  }
}
