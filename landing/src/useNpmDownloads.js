import { useState, useEffect } from 'react'

// ── Live npm download stats for argusqa-os ───────────────────────────────────────
// Pulls from npm's public, CORS-enabled download API (the same data npm-stat.com
// charts) directly from the browser — no backend needed on Cloudflare Pages.
//   range:  https://api.npmjs.org/downloads/range/<from>:<to>/<pkg>  → [{ day, downloads }]
//   created: https://registry.npmjs.org/<pkg>  → time.created (first publish)
// Results are cached in sessionStorage so repeat views render instantly; a stale
// cache is shown immediately and refreshed in the background. Every failure path
// degrades to the last-known cache or the hard-coded fallbacks below.

const PKG = 'argusqa-os'
export const FIRST_PUBLISH = '2026-05-26'   // registry time.created (v9.2.0) — fallback only
export const FALLBACK_TOTAL = 5677          // last-known total — shown only if the API is unreachable
const CACHE_KEY = 'argus_npm_dl_v1'
const CACHE_TTL = 1000 * 60 * 60            // 1h: within this window we skip the network entirely

const todayUTC = () => new Date().toISOString().slice(0, 10)

function readCache() {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed && parsed.data && Array.isArray(parsed.data.daily)) return parsed
  } catch { /* ignore */ }
  return null
}

async function fetchCreated() {
  try {
    const res = await fetch(`https://registry.npmjs.org/${PKG}`)
    if (!res.ok) return FIRST_PUBLISH
    const json = await res.json()
    return (json?.time?.created ?? FIRST_PUBLISH).slice(0, 10)
  } catch {
    return FIRST_PUBLISH
  }
}

// npm's range endpoint caps at 18 months per request; our window is well under that.
// If the package ever ages past 18 months this should be chunked — flagged, not needed yet.
async function fetchRange(from, to) {
  const res = await fetch(`https://api.npmjs.org/downloads/range/${from}:${to}/${PKG}`)
  if (!res.ok) throw new Error(`npm range ${res.status}`)
  const json = await res.json()
  return Array.isArray(json?.downloads) ? json.downloads : []
}

export function useNpmDownloads() {
  // Hydrate synchronously from cache so repeat visits paint the real number on first frame.
  const [state, setState] = useState(() => {
    const cached = readCache()
    if (cached) {
      return { ...cached.data, loading: Date.now() - cached.ts >= CACHE_TTL, error: false }
    }
    return { daily: [], total: 0, firstPublish: FIRST_PUBLISH, loading: true, error: false }
  })

  useEffect(() => {
    const cached = readCache()
    if (cached && Date.now() - cached.ts < CACHE_TTL) return   // fresh — no network this session

    let cancelled = false
    ;(async () => {
      try {
        const firstPublish = await fetchCreated()
        const daily = await fetchRange(firstPublish, todayUTC())
        const total = daily.reduce((s, d) => s + (d.downloads || 0), 0)
        if (cancelled) return
        const data = { daily, total, firstPublish }
        setState({ ...data, loading: false, error: false })
        try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data })) } catch { /* quota */ }
      } catch {
        if (cancelled) return
        // keep any stale cache already in state; only flag error when we have nothing to show
        setState(s => ({ ...s, loading: false, error: s.daily.length === 0 }))
      }
    })()

    return () => { cancelled = true }
  }, [])

  return state
}

// ── Aggregation: daily [{ day, downloads }] → bucketed [{ key, label, value }] ────
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function fmtDay(day) {
  const [, m, d] = day.split('-')
  return `${parseInt(d, 10)} ${MONTHS[parseInt(m, 10) - 1]}`
}

// ISO-8601 week key, e.g. "2026-W22" (Monday-based, week containing the first Thursday).
function isoWeekKey(day) {
  const d = new Date(day + 'T00:00:00Z')
  const dayNum = (d.getUTCDay() + 6) % 7          // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3)        // nearest Thursday
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4))
  const week = 1 + Math.round(((d - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

export function aggregate(daily, granularity) {
  if (!Array.isArray(daily) || daily.length === 0) return []

  if (granularity === 'day') {
    return daily.map(d => ({ key: d.day, label: fmtDay(d.day), full: d.day, value: d.downloads || 0 }))
  }

  const order = []
  const map = new Map()
  for (const { day, downloads } of daily) {
    let key, label
    if (granularity === 'week') {
      key = isoWeekKey(day)
      label = key.slice(5)                          // "W22"
    } else if (granularity === 'month') {
      key = day.slice(0, 7)                          // "2026-06"
      const [y, m] = key.split('-')
      label = `${MONTHS[parseInt(m, 10) - 1]} ${y}`  // "Jun 2026"
    } else {                                          // year
      key = day.slice(0, 4)
      label = key
    }
    if (!map.has(key)) { map.set(key, { key, label, full: label, value: 0 }); order.push(key) }
    map.get(key).value += (downloads || 0)
  }
  return order.map(k => map.get(k))
}
