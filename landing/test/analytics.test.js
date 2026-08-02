import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// analytics.js reads VITE_POSTHOG_KEY at MODULE LOAD, so each scenario has to
// import it fresh with the env already stubbed.
async function loadAnalytics({ key = 'phc_test_key', host } = {}) {
  vi.resetModules()
  vi.stubEnv('VITE_POSTHOG_KEY', key)
  if (host) vi.stubEnv('VITE_POSTHOG_HOST', host)
  return import('../src/analytics.js')
}

function clearStorage() {
  window.localStorage.clear()
  for (const c of document.cookie.split(';')) {
    const name = c.split('=')[0].trim()
    if (name) document.cookie = `${name}=; max-age=0; path=/`
  }
}

let sent
function stubTransports() {
  sent = []
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    sent.push({ via: 'fetch', url, body: JSON.parse(init.body) })
    return new Response('{}', { status: 200 })
  }))
  // jsdom has no sendBeacon.
  navigator.sendBeacon = vi.fn((url, blob) => {
    sent.push({ via: 'beacon', url, blob })
    return true
  })
}

beforeEach(() => { clearStorage(); stubTransports() })
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('deferred-on-key + opt-out', () => {
  // The same posture as every other integration in this codebase: no key, no calls.
  it('does nothing at all without a PostHog key', async () => {
    const a = await loadAnalytics({ key: '' })
    expect(a.analyticsEnabled()).toBe(false)
    expect(a.capture('landing_view')).toBe(false)
    expect(a.initAnalytics()).toBe(false)
    expect(a.identify('user-1')).toBe(false)
    expect(sent).toEqual([])
  })

  // GPC and DNT are explicit opt-outs. A marketing funnel is not worth overriding
  // a signal the visitor deliberately set.
  it('honours Global Privacy Control', async () => {
    const a = await loadAnalytics()
    Object.defineProperty(navigator, 'globalPrivacyControl', { value: true, configurable: true })
    expect(a.analyticsEnabled()).toBe(false)
    expect(a.capture('landing_view')).toBe(false)
    expect(sent).toEqual([])
    delete navigator.globalPrivacyControl
  })

  it('honours Do Not Track', async () => {
    const a = await loadAnalytics()
    Object.defineProperty(navigator, 'doNotTrack', { value: '1', configurable: true })
    expect(a.analyticsEnabled()).toBe(false)
    expect(sent).toEqual([])
    Object.defineProperty(navigator, 'doNotTrack', { value: null, configurable: true })
  })
})

describe('distinctId', () => {
  it('mints once and then stays stable across calls', async () => {
    const a = await loadAnalytics()
    const first = a.distinctId()
    expect(first).toBeTruthy()
    expect(a.distinctId()).toBe(first)
  })

  // The cookie is apex-scoped so the app subdomain sees the SAME visitor — the
  // whole reason the funnel can span two origins.
  it('persists to both localStorage and a cookie', async () => {
    const a = await loadAnalytics()
    const id = a.distinctId()
    expect(window.localStorage.getItem(a.DID_KEY)).toBe(id)
    expect(document.cookie).toContain(`${a.DID_KEY}=`)
  })

  it('recovers the id from the cookie when localStorage was cleared', async () => {
    const a = await loadAnalytics()
    const id = a.distinctId()
    window.localStorage.clear()
    expect(a.distinctId()).toBe(id) // not a new stranger
  })

  it('survives localStorage throwing', async () => {
    const a = await loadAnalytics()
    const spy = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => { throw new Error('SecurityError') })
    expect(() => a.distinctId()).not.toThrow()
    spy.mockRestore()
  })
})

describe('capture', () => {
  it('posts a PostHog-shaped event to the capture endpoint', async () => {
    const a = await loadAnalytics()
    a.capture('landing_view', { referrer: 'direct' })
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe('https://us.i.posthog.com/capture/')
    expect(sent[0].body).toMatchObject({
      api_key: 'phc_test_key',
      event: 'landing_view',
      distinct_id: a.distinctId(),
      properties: { referrer: 'direct', surface: 'landing' },
    })
  })

  it('targets a self-hosted PostHog when configured', async () => {
    const a = await loadAnalytics({ host: 'https://ph.example.com/' })
    a.capture('landing_view')
    expect(sent[0].url).toBe('https://ph.example.com/capture/')
  })

  // checkout_started fires immediately before a full-page navigation, which
  // cancels in-flight fetches. Losing it would blind the most important step.
  it('uses sendBeacon when asked, so a navigation cannot cancel the event', async () => {
    const a = await loadAnalytics()
    a.capture('checkout_started', { discounted: true }, { beacon: true })
    expect(sent[0].via).toBe('beacon')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('falls back to fetch when sendBeacon is unavailable or refuses', async () => {
    const a = await loadAnalytics()
    navigator.sendBeacon = vi.fn(() => false) // browser refused to queue it
    a.capture('checkout_started', {}, { beacon: true })
    expect(fetch).toHaveBeenCalled()
  })

  // An analytics outage must never surface in the page.
  it('never throws when the transport fails', async () => {
    const a = await loadAnalytics()
    vi.stubGlobal('fetch', vi.fn(() => { throw new TypeError('Failed to fetch') }))
    navigator.sendBeacon = undefined
    expect(() => a.capture('landing_view')).not.toThrow()
  })
})

describe('identify', () => {
  // Without $anon_distinct_id, PostHog keeps the pre-signup visitor and the
  // signed-up user as two separate people and the funnel never joins.
  it('aliases the anonymous visitor to the account id', async () => {
    const a = await loadAnalytics()
    const anon = a.distinctId()
    a.identify('user-abc')
    const ev = sent.find((s) => s.body?.event === '$identify')
    expect(ev.body.distinct_id).toBe('user-abc')
    expect(ev.body.properties.$anon_distinct_id).toBe(anon)
  })

  // The app forwards with distinct_id = the Supabase user id, so from here on the
  // landing must use the same id or later events would split off again.
  it('adopts the user id for every subsequent event', async () => {
    const a = await loadAnalytics()
    a.identify('user-abc')
    expect(a.distinctId()).toBe('user-abc')
    a.capture('checkout_started')
    expect(sent.at(-1).body.distinct_id).toBe('user-abc')
  })

  it('does not re-alias an already-identified visitor', async () => {
    const a = await loadAnalytics()
    a.identify('user-abc')
    sent.length = 0
    a.identify('user-abc')
    expect(sent.filter((s) => s.body?.event === '$identify')).toHaveLength(0)
  })

  it('ignores a missing user id', async () => {
    const a = await loadAnalytics()
    expect(a.identify(null)).toBe(false)
    expect(a.identify(undefined)).toBe(false)
    expect(sent).toEqual([])
  })
})

describe('no PII leaves the page', () => {
  // The app's server-side event model enforces "opaque id, secret-free". The
  // landing has no scrubber, so the guarantee here is that call sites only ever
  // pass flags — this pins that the module adds nothing of its own.
  it('sends only the id, the event name and the given properties', async () => {
    const a = await loadAnalytics()
    window.localStorage.setItem('argus_ref', 'FRIEND10')
    a.capture('checkout_started', { discounted: true, referred: true })
    const body = JSON.stringify(sent[0].body)
    expect(body).not.toContain('FRIEND10') // the referral CODE never rides along
    expect(body).not.toMatch(/@/) // no email-shaped value anywhere
    expect(Object.keys(sent[0].body.properties).sort()).toEqual(
      ['$current_url', 'discounted', 'referred', 'surface'].sort(),
    )
  })
})
