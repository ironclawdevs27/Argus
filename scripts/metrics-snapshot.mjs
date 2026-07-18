#!/usr/bin/env node
/**
 * Argus business-metrics snapshot — `npm run metrics`
 *
 * Pulls the weekly numbers that actually steer the business onto one page
 * (business-analysis.md §8) and appends a CSV row to reports/metrics-history.csv
 * (gitignored) so trends accumulate run over run.
 *
 * Live sources (no auth required):
 *   • npm downloads API   — last-week + last-month download counts
 *   • GitHub repo API     — stars, forks, open issues
 *
 * Optional (env-gated):
 *   • Supabase waitlist count — set SUPABASE_URL + SUPABASE_SERVICE_KEY.
 *     The anon key CANNOT read the waitlist (RLS is insert-only by design),
 *     so this needs the service-role key. Never commit it; run locally only.
 *
 * Manual columns (no safe API from a script): MRR + paying users — read them
 * off the Stripe dashboard and pass via --mrr=1234 --paying=12 when known.
 */

import fs from 'fs';
import path from 'path';

const PKG = 'argusqa-os';
const REPO = process.env.ARGUS_METRICS_REPO || 'ironclawdevs27/Argus';
const OUT_DIR = process.env.REPORT_OUTPUT_DIR || './reports';
const OUT_FILE = path.join(OUT_DIR, 'metrics-history.csv');

const args = Object.fromEntries(
  process.argv.slice(2)
    .map(a => a.match(/^--([\w-]+)(?:=(.*))?$/))
    .filter(Boolean)
    .map(([, k, v]) => [k, v ?? true]),
);

async function getJson(url, headers = {}) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'argus-metrics', ...headers } });
    if (!res.ok) return { _error: `HTTP ${res.status}` };
    return await res.json();
  } catch (err) {
    return { _error: err.message };
  }
}

async function npmDownloads() {
  const [week, month] = await Promise.all([
    getJson(`https://api.npmjs.org/downloads/point/last-week/${PKG}`),
    getJson(`https://api.npmjs.org/downloads/point/last-month/${PKG}`),
  ]);
  return { week: week.downloads ?? null, month: month.downloads ?? null };
}

async function githubStats() {
  const repo = await getJson(`https://api.github.com/repos/${REPO}`);
  if (repo._error) return { stars: null, forks: null, issues: null, error: repo._error };
  return { stars: repo.stargazers_count, forks: repo.forks_count, issues: repo.open_issues_count };
}

async function waitlistCount() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return { count: null, note: 'set SUPABASE_URL + SUPABASE_SERVICE_KEY to include' };
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/waitlist?select=id`, {
      method: 'HEAD',
      headers: { apikey: key, authorization: `Bearer ${key}`, prefer: 'count=exact' },
    });
    const range = res.headers.get('content-range'); // e.g. "0-24/137"
    const total = range?.split('/')[1];
    return total != null ? { count: Number(total) } : { count: null, note: `no count header (HTTP ${res.status})` };
  } catch (err) {
    return { count: null, note: err.message };
  }
}

const [npm, gh, waitlist] = await Promise.all([npmDownloads(), githubStats(), waitlistCount()]);
const mrr = args.mrr ?? '';
const paying = args.paying ?? '';
const date = new Date().toISOString().slice(0, 10);

const fmt = v => (v == null ? '—' : v);
console.log(`\n  ╬ Argus metrics — ${date}\n`);
console.log(`  GitHub          ${fmt(gh.stars)} stars · ${fmt(gh.forks)} forks · ${fmt(gh.issues)} open issues${gh.error ? `  (${gh.error})` : ''}`);
console.log(`  npm downloads   ${fmt(npm.week)}/week · ${fmt(npm.month)}/month  (soft signal — mirrors/CI inflate this)`);
console.log(`  Waitlist        ${fmt(waitlist.count)}${waitlist.note ? `  (${waitlist.note})` : ''}`);
console.log(`  MRR / paying    ${mrr || '—'} / ${paying || '—'}  (pass --mrr= --paying= from the Stripe dashboard)`);

fs.mkdirSync(OUT_DIR, { recursive: true });
const header = 'date,gh_stars,gh_forks,gh_open_issues,npm_week,npm_month,waitlist,mrr,paying_users\n';
// Write the header only if the file is absent — atomic create-exclusive (flag 'wx')
// instead of a existsSync→write check-then-act, which is a file-system race (TOCTOU).
try {
  fs.writeFileSync(OUT_FILE, header, { flag: 'wx' });
} catch (err) {
  if (err.code !== 'EEXIST') throw err; // already exists ⇒ keep the existing header
}
fs.appendFileSync(OUT_FILE, `${date},${gh.stars ?? ''},${gh.forks ?? ''},${gh.issues ?? ''},${npm.week ?? ''},${npm.month ?? ''},${waitlist.count ?? ''},${mrr},${paying}\n`);
console.log(`\n  ✓ appended to ${OUT_FILE}\n`);
