import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  REF_KEY,
  PENDING_FOUNDING_KEY,
  apexCookieDomain,
  normalizeCode,
  captureReferral,
  storedReferral,
  buildCheckoutUrl,
  stashPendingFounding,
  takePendingFounding,
  recordFoundingMember,
  stripQueryParam,
} from '../src/checkout.js'

// The highest-stakes untested code in the landing↔app seam: if any of this breaks,
// a founding purchase still succeeds at the processor but arrives with no account
// link and no referral attribution — money in, nothing recorded. It fails SILENTLY,
// which is exactly why it needs tests rather than a manual click-through.

function clearStorage() {
  window.localStorage.clear()
  // Expire every cookie jsdom is holding.
  for (const c of document.cookie.split(';')) {
    const name = c.split('=')[0].trim()
    if (name) document.cookie = `${name}=; max-age=0; path=/`
  }
}

beforeEach(clearStorage)

// ── normalizeCode ────────────────────────────────────────────────────────────
// Mirrors the app's normalizePromoCode. It is also the sanitizer standing between
// a URL and both storage and an outbound checkout link.

describe('normalizeCode', () => {
  it('upper-cases, strips noise, and caps length', () => {
    expect(normalizeCode(' friend10 ')).toBe('FRIEND10')
    expect(normalizeCode('diwali-30')).toBe('DIWALI-30')
    expect(normalizeCode('a'.repeat(50))).toHaveLength(32)
  })

  it('returns "" for empty-ish input rather than something truthy', () => {
    for (const v of ['', null, undefined, '   ', '!!!']) expect(normalizeCode(v)).toBe('')
  })

  // A referral code arrives from an attacker-controllable query string and ends up
  // in localStorage, a cookie, and a URL. Nothing but [A-Z0-9-] may survive.
  it('strips anything that could escape a URL, a cookie, or the DOM', () => {
    expect(normalizeCode('<script>alert(1)</script>')).toBe('SCRIPTALERT1SCRIPT')
    expect(normalizeCode('a;b=c')).toBe('ABC')
    expect(normalizeCode('x&y=1')).toBe('XY1')
    expect(normalizeCode('"quoted"')).toBe('QUOTED')
    for (const bad of ['<', '>', '"', "'", ';', '&', '=', ' ', '\n', '%']) {
      expect(normalizeCode(`A${bad}B`)).toBe('AB')
    }
  })
})

// ── apexCookieDomain ─────────────────────────────────────────────────────────
// The referral cookie must be readable by the APP subdomain, which is the entire
// reason it is apex-scoped. A Domain the browser cannot match drops the cookie
// silently, so hosts that have no apex must return null instead of guessing.

describe('apexCookieDomain', () => {
  it('returns the shared apex for a real host', () => {
    expect(apexCookieDomain('argus-qa.com')).toBe('.argus-qa.com')
    expect(apexCookieDomain('www.argus-qa.com')).toBe('.argus-qa.com')
    expect(apexCookieDomain('app.argus-qa.com')).toBe('.argus-qa.com')
  })

  it('returns null where a Domain attribute would be dropped', () => {
    expect(apexCookieDomain('localhost')).toBeNull()
    expect(apexCookieDomain('')).toBeNull()
    expect(apexCookieDomain('127.0.0.1')).toBeNull() // raw IP
  })
})

// ── Referral capture ─────────────────────────────────────────────────────────

describe('captureReferral / storedReferral', () => {
  it('captures ?ref= and persists it for a purchase made later', () => {
    expect(captureReferral('?ref=friend10')).toBe('FRIEND10')
    expect(window.localStorage.getItem(REF_KEY)).toBe('FRIEND10')
    expect(storedReferral()).toBe('FRIEND10') // survives the visit
  })

  it('keeps the stored code when a later visit has no ?ref=', () => {
    captureReferral('?ref=FRIEND10')
    expect(captureReferral('')).toBe('FRIEND10')
    expect(captureReferral('?utm_source=x')).toBe('FRIEND10')
  })

  it('lets a newer code replace an older one', () => {
    captureReferral('?ref=OLD')
    expect(captureReferral('?ref=NEW')).toBe('NEW')
  })

  it('refuses to store a code that normalizes to nothing', () => {
    expect(captureReferral('?ref=%20%20')).toBe('')
    expect(window.localStorage.getItem(REF_KEY)).toBeNull()
  })

  it('writes a cookie too, so the app subdomain can read it server-side', () => {
    captureReferral('?ref=FRIEND10')
    expect(document.cookie).toContain(`${REF_KEY}=FRIEND10`)
  })

  // Safari private mode throws on localStorage. Losing a referral is acceptable;
  // taking the pricing page down with it is not.
  it('survives localStorage throwing, falling back to the cookie', () => {
    captureReferral('?ref=FRIEND10') // cookie now set
    const spy = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(() => storedReferral()).not.toThrow()
    expect(storedReferral()).toBe('FRIEND10') // read from the cookie instead
    spy.mockRestore()
  })

  it('returns "" when nothing was ever captured', () => {
    expect(storedReferral()).toBe('')
  })
})

// ── buildCheckoutUrl ─────────────────────────────────────────────────────────
// POLAR parameter names. This is a silent-failure surface: an unrecognised query
// param is ignored by the processor, so a wrong name produces a checkout that is
// unbound and undiscounted while looking completely normal.

describe('buildCheckoutUrl', () => {
  const LINK = 'https://buy.polar.sh/polar_cl_abc123'

  it('binds the payment to the account via reference_id', () => {
    const url = new URL(buildCheckoutUrl(LINK, { userId: 'user-abc' }))
    expect(url.searchParams.get('reference_id')).toBe('user-abc')
    // The Stripe-era name must NOT survive — Polar ignores it, and the webhook
    // would then resolve no org at all.
    expect(url.searchParams.get('client_reference_id')).toBeNull()
  })

  it('uses Polar names for the email and discount prefills', () => {
    const url = new URL(buildCheckoutUrl(LINK, { email: 'a@b.com', promoCode: 'diwali30' }))
    expect(url.searchParams.get('customer_email')).toBe('a@b.com')
    expect(url.searchParams.get('discount_code')).toBe('DIWALI30') // normalized
    expect(url.searchParams.get('prefilled_email')).toBeNull()
    expect(url.searchParams.get('prefilled_promo_code')).toBeNull()
  })

  it('omits every field it was not given', () => {
    const url = new URL(buildCheckoutUrl(LINK))
    expect([...url.searchParams.keys()]).toEqual([])
  })

  it('preserves params already on the configured link', () => {
    const url = new URL(buildCheckoutUrl(`${LINK}?utm_source=landing`, { userId: 'u1' }))
    expect(url.searchParams.get('utm_source')).toBe('landing')
    expect(url.searchParams.get('reference_id')).toBe('u1')
  })

  it('drops a junk promo code instead of forwarding it', () => {
    const url = new URL(buildCheckoutUrl(LINK, { promoCode: '  !!  ' }))
    expect(url.searchParams.get('discount_code')).toBeNull()
  })

  it('URL-encodes values rather than corrupting the link', () => {
    const url = new URL(buildCheckoutUrl(LINK, { email: 'a+tag@b.com' }))
    expect(url.searchParams.get('customer_email')).toBe('a+tag@b.com')
  })
})

// ── The founding stash ───────────────────────────────────────────────────────
// The redirect to the processor is a full navigation, so component state does not
// survive it and the return carries only `?checkout=success`. This stash is the
// only way the landing still knows WHO bought when they come back.

describe('stashPendingFounding / takePendingFounding', () => {
  it('round-trips the buyer across the redirect, lower-casing the email', () => {
    stashPendingFounding({ email: '  Buyer@Example.COM ', userId: 'u1', plan: 'pro' })
    expect(takePendingFounding()).toMatchObject({ email: 'buyer@example.com', userId: 'u1', plan: 'pro' })
  })

  it('captures the referral alongside the buyer', () => {
    captureReferral('?ref=FRIEND10')
    stashPendingFounding({ email: 'a@b.com' })
    expect(takePendingFounding().ref).toBe('FRIEND10')
  })

  // Single-use: a reloaded success URL must not re-fire the capture.
  it('is single-use — a second read returns null', () => {
    stashPendingFounding({ email: 'a@b.com' })
    expect(takePendingFounding()).not.toBeNull()
    expect(takePendingFounding()).toBeNull()
    expect(window.localStorage.getItem(PENDING_FOUNDING_KEY)).toBeNull()
  })

  it('stores nothing without an email — the only field the capture needs', () => {
    stashPendingFounding({ userId: 'u1' })
    expect(window.localStorage.getItem(PENDING_FOUNDING_KEY)).toBeNull()
  })

  it('returns null on corrupted storage instead of throwing on the success page', () => {
    window.localStorage.setItem(PENDING_FOUNDING_KEY, '{not json')
    expect(takePendingFounding()).toBeNull()
  })
})

// ── recordFoundingMember ─────────────────────────────────────────────────────
// Goes through the capture_founding_member RPC because founding_members grants
// anon INSERT but deliberately no SELECT (a PostgREST upsert would need SELECT,
// which would expose every founding email to the public key).

describe('recordFoundingMember', () => {
  const okClient = () => ({ rpc: vi.fn(async () => ({ error: null })), from: vi.fn() })

  it('captures through the RPC with a normalized email', async () => {
    const client = okClient()
    const res = await recordFoundingMember(client, '  Buyer@Example.COM ')
    expect(res.ok).toBe(true)
    expect(client.rpc).toHaveBeenCalledWith('capture_founding_member', { p_email: 'buyer@example.com' })
    expect(client.from).not.toHaveBeenCalled() // no table write on the happy path
  })

  it('refuses obvious non-emails without a round-trip', async () => {
    const client = okClient()
    for (const bad of ['', '   ', 'nope', null, undefined]) {
      expect((await recordFoundingMember(client, bad)).ok).toBe(false)
    }
    expect(client.rpc).not.toHaveBeenCalled()
  })

  it('reports a missing client rather than throwing', async () => {
    expect(await recordFoundingMember(null, 'a@b.com')).toEqual({ ok: false, reason: 'no-supabase-client' })
  })

  // A database that has not had the migration applied yet must still capture —
  // losing the record is the whole thing this code exists to prevent.
  it('falls back to a plain insert when the function is missing', async () => {
    const insert = vi.fn(async () => ({ error: null }))
    const client = {
      rpc: vi.fn(async () => ({ error: { code: 'PGRST202', message: 'no function' } })),
      from: vi.fn(() => ({ insert })),
    }
    const res = await recordFoundingMember(client, 'a@b.com')
    expect(res).toMatchObject({ ok: true, via: 'insert-fallback' })
    expect(insert).toHaveBeenCalledWith({ email: 'a@b.com' })
  })

  it('treats a duplicate on the fallback path as already-captured, not a failure', async () => {
    const client = {
      rpc: vi.fn(async () => ({ error: { code: 'PGRST202' } })),
      from: vi.fn(() => ({ insert: async () => ({ error: { code: '23505' } }) })),
    }
    expect(await recordFoundingMember(client, 'a@b.com')).toMatchObject({ ok: true, via: 'already-captured' })
  })

  it('reports other RPC errors without falling back', async () => {
    const client = {
      rpc: vi.fn(async () => ({ error: { code: '42501', message: 'permission denied' } })),
      from: vi.fn(),
    }
    expect(await recordFoundingMember(client, 'a@b.com')).toMatchObject({ ok: false, reason: 'permission denied' })
    expect(client.from).not.toHaveBeenCalled()
  })

  // A capture failure is an operator problem. It must never surface as a failed
  // purchase — the money already moved.
  it('never throws, even when the client blows up', async () => {
    const client = { rpc: async () => { throw new Error('network down') }, from: vi.fn() }
    expect(await recordFoundingMember(client, 'a@b.com')).toMatchObject({ ok: false })
  })
})

// ── stripQueryParam ──────────────────────────────────────────────────────────

describe('stripQueryParam', () => {
  it('removes the param without adding a history entry', () => {
    window.history.replaceState({}, '', '/?checkout=success&keep=1#pricing')
    stripQueryParam('checkout')
    expect(window.location.search).toBe('?keep=1')
    expect(window.location.hash).toBe('#pricing') // the anchor must survive
  })

  it('does nothing when the param is absent', () => {
    window.history.replaceState({}, '', '/?keep=1')
    stripQueryParam('checkout')
    expect(window.location.search).toBe('?keep=1')
  })
})
