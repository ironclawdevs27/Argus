// ─────────────────────────────────────────────────────────────────────────────
// Landing-side funnel analytics (LANDING_APP_INTEGRATION_PLAN Phase E / BACKLOG T4.7).
//
// The app already records the post-signup funnel (`lib/analytics/*` → a durable
// first-party table + a deferred-on-key PostHog forwarder). The landing recorded
// NOTHING, so the funnel began at signup and landing→signup conversion — the one
// number that says whether the marketing works — was invisible.
//
// ── How the journey joins across the domain hop ──────────────────────────────
// The app forwards to PostHog with `distinct_id = <supabase user id>`. So the
// landing mints an ANONYMOUS id for a first-time visitor, captures against it,
// and at signup sends a PostHog `$identify` carrying `$anon_distinct_id`. PostHog
// then MERGES the anonymous pre-signup events into that person, and every later
// app-side event lands on the same profile. One journey, no app-side change.
//
// ── Privacy posture ──────────────────────────────────────────────────────────
//   • Deferred-on-key: does nothing at all unless VITE_POSTHOG_KEY is set — the
//     same posture as the app's Slack/email/PostHog integrations.
//   • Honours Global Privacy Control and Do Not Track. Both are explicit opt-outs
//     and this is a marketing funnel, not something worth overriding a signal for.
//   • NO PII, ever. The distinct id is a random UUID, then an opaque Supabase user
//     id. Emails, names and referral codes are never sent as properties — the same
//     "opaque id, secret-free" rule the app's event model enforces.
//   • First-party cookie on the apex domain only; no third-party pixel.
//
// Zero-dependency on purpose: `posthog-js` is ~50KB of autocapture and session
// replay for what is four `fetch` calls, on a page whose bundle size is a
// conversion factor. Mirrors the app's forwarder, which also just POSTs.
// ─────────────────────────────────────────────────────────────────────────────

import { apexCookieDomain } from './checkout'

const KEY = import.meta.env.VITE_POSTHOG_KEY || ''
const HOST = (import.meta.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com').replace(/\/$/, '')

// Shared with the app: `distinct_id` there is the Supabase user id, so aliasing to
// it at signup is what stitches the two halves together.
export const DID_KEY = 'argus_did'
const DID_TTL_DAYS = 365

// Event names. The three that also exist app-side keep the app's exact strings
// (lib/analytics/events.ts) so they are ONE funnel step, not two look-alikes.
export const EVENTS = {
  LANDING_VIEW: 'landing_view',
  WAITLIST_SUBMITTED: 'waitlist_submitted',
  SIGNUP: 'signup', // matches ANALYTICS_EVENTS.SIGNUP
  CHECKOUT_STARTED: 'checkout_started', // matches ANALYTICS_EVENTS.CHECKOUT_STARTED
  FOUNDING_CAPTURED: 'founding_captured',
}

// An explicit opt-out is an answer, not an obstacle.
function optedOut() {
  try {
    if (navigator.globalPrivacyControl === true) return true
    const dnt = navigator.doNotTrack ?? window.doNotTrack
    return dnt === '1' || dnt === 'yes'
  } catch {
    return false
  }
}

export function analyticsEnabled() {
  return !!KEY && !optedOut()
}

function readCookie(name) {
  for (const part of String(document.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v.join('='))
  }
  return ''
}

function writeDidCookie(value) {
  const domain = apexCookieDomain(window.location.hostname)
  const bits = [
    `${DID_KEY}=${encodeURIComponent(value)}`,
    'path=/',
    `max-age=${DID_TTL_DAYS * 24 * 60 * 60}`,
    'SameSite=Lax',
  ]
  if (domain) bits.push(`domain=${domain}`)
  if (window.location.protocol === 'https:') bits.push('Secure')
  document.cookie = bits.join('; ')
}

function randomId() {
  try {
    if (crypto?.randomUUID) return crypto.randomUUID()
  } catch { /* older browsers */ }
  return `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

// The visitor's id: whatever is already stored, else a fresh random one. Stored in
// both localStorage and an apex cookie — the cookie so the app subdomain sees the
// same visitor, localStorage so an expired cookie does not silently split a person.
export function distinctId() {
  let id = ''
  try { id = window.localStorage.getItem(DID_KEY) || '' } catch { /* private mode */ }
  if (!id) {
    try { id = readCookie(DID_KEY) } catch { /* cookies blocked */ }
  }
  if (!id) id = randomId()
  try { window.localStorage.setItem(DID_KEY, id) } catch { /* private mode */ }
  try { writeDidCookie(id) } catch { /* cookies blocked */ }
  return id
}

// POST one event. `beacon` matters more than it looks: `checkout_started` fires
// immediately before a full-page navigation to the processor, and a normal fetch
// is cancelled by that navigation — losing precisely the most valuable event in
// the funnel. sendBeacon is designed to survive it.
function send(payload, { beacon = false } = {}) {
  const url = `${HOST}/capture/`
  const body = JSON.stringify(payload)
  if (beacon) {
    try {
      if (navigator.sendBeacon?.(url, new Blob([body], { type: 'application/json' }))) return
    } catch { /* fall through to fetch */ }
  }
  try {
    // keepalive gives fetch the same survive-the-navigation property as a fallback.
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
      mode: 'cors',
      credentials: 'omit',
    }).catch(() => {})
  } catch { /* analytics must never throw into the page */ }
}

/**
 * Record a funnel event. No-op unless a key is configured and the visitor has not
 * opted out. Properties must be non-PII primitives — the same rule the app's
 * buildAnalyticsEvent enforces server-side.
 */
export function capture(event, properties = {}, opts = {}) {
  if (!analyticsEnabled()) return false
  send(
    {
      api_key: KEY,
      event,
      distinct_id: distinctId(),
      properties: { ...properties, $current_url: window.location.href, surface: 'landing' },
      timestamp: new Date().toISOString(),
    },
    opts,
  )
  return true
}

/**
 * Bind this visitor to their Supabase account. `$anon_distinct_id` is what makes
 * PostHog merge everything captured before signup into the identified person —
 * without it the landing half and the app half stay two separate strangers.
 */
export function identify(userId) {
  if (!analyticsEnabled() || !userId) return false
  const anon = distinctId()
  if (anon !== userId) {
    send({
      api_key: KEY,
      event: '$identify',
      distinct_id: userId,
      properties: { $anon_distinct_id: anon },
      timestamp: new Date().toISOString(),
    })
  }
  // From here on this visitor IS the user id, matching what the app sends.
  try { window.localStorage.setItem(DID_KEY, userId) } catch { /* private mode */ }
  try { writeDidCookie(userId) } catch { /* cookies blocked */ }
  return true
}

/** One `landing_view` per page load. */
export function initAnalytics() {
  return capture(EVENTS.LANDING_VIEW, { referrer: document.referrer ? 'external' : 'direct' })
}
