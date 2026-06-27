// landing/src/growthData.js — point-in-time snapshots for growth sources that have
// NO public, CORS-accessible live API:
//   • GitHub repo traffic (clones/views) — admin-only API (needs push access)
//   • Socket.dev security scores — change rarely; no public JSON endpoint
//   • Pulse MCP ecosystem estimate — proprietary
// npm downloads + (if added) GitHub stars are fetched live elsewhere.
// Refresh these numbers periodically. Last updated: 2026-06-26.

export const SNAPSHOT_DATE = 'Jun 2026'

// ── GitHub repo traffic — last 14 days (Insights → Traffic), 06/13 → 06/26 ───────
const GH_DAYS = [
  '06/13', '06/14', '06/15', '06/16', '06/17', '06/18', '06/19',
  '06/20', '06/21', '06/22', '06/23', '06/24', '06/25', '06/26',
]
const series = (vals) => GH_DAYS.map((d, i) => ({ key: d, label: d, full: d, value: vals[i] }))

export const githubTraffic = {
  totals: { clones: 954, uniqueCloners: 241, views: 73, uniqueVisitors: 14 },
  clones:   series([130, 179, 85, 54, 85, 91, 37, 24, 40, 98, 66, 6, 33, 29]),
  cloners:  series([37, 40, 28, 22, 23, 26, 10, 8, 14, 28, 18, 3, 15, 6]),
  views:    series([6, 8, 0, 29, 5, 0, 0, 2, 1, 0, 1, 2, 7, 12]),
  visitors: series([2, 4, 0, 1, 1, 0, 1, 1, 0, 1, 1, 2, 3, 4]),
}

// ── Socket.dev supply-chain analysis ─────────────────────────────────────────────
export const socketScores = {
  overall: 79,
  scores: [
    { label: 'Supply Chain', value: 79 },
    { label: 'Vulnerability', value: 100 },
    { label: 'Quality', value: 100 },
    { label: 'Maintenance', value: 96 },
    { label: 'License', value: 100 },
  ],
  url: 'https://socket.dev/npm/package/argusqa-os',
}

// ── Pulse MCP ecosystem estimate ─────────────────────────────────────────────────
export const pulseStats = {
  estVisitors: '5.8k',
  estVisitorsWeek: '351',
  rank: '#2,526',
  peakRank: '#356',
  url: 'https://www.pulsemcp.com/servers/ironclawdevs27-argus',
}
