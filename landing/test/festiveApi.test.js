import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchActiveCampaign, campaignToOffer } from '../src/festiveApi.js'

// The live-campaign override. Its defining property is ASYMMETRY: a reachable app
// with a live campaign wins, and EVERY failure mode leaves the compiled-in schedule
// in charge. That is what stops the banner going blank because the app is down —
// so the failure paths matter more here than the happy one.

const VALID = {
  slug: 'diwali-2026',
  name: 'Diwali Special',
  code: 'DIWALI30',
  pctOff: 30,
  startsAt: '2026-11-06T00:00:00Z',
  endsAt: '2026-11-12T23:59:59Z',
  durationMonths: 3,
}

function mockFetch(impl) {
  const spy = vi.fn(impl)
  vi.stubGlobal('fetch', spy)
  return spy
}

afterEach(() => vi.unstubAllGlobals())

describe('fetchActiveCampaign', () => {
  it('returns the campaign the app says is live', async () => {
    const spy = mockFetch(async () => new Response(JSON.stringify({ campaign: VALID }), { status: 200 }))
    expect(await fetchActiveCampaign('https://app.argus-qa.com')).toEqual(VALID)
    expect(spy.mock.calls[0][0]).toBe('https://app.argus-qa.com/api/promos/active')
  })

  it('tolerates a trailing slash on the app origin', async () => {
    const spy = mockFetch(async () => new Response(JSON.stringify({ campaign: VALID }), { status: 200 }))
    await fetchActiveCampaign('https://app.argus-qa.com/')
    expect(spy.mock.calls[0][0]).toBe('https://app.argus-qa.com/api/promos/active')
  })

  it('does not call out at all when no app origin is configured', async () => {
    const spy = mockFetch(async () => new Response('{}'))
    for (const base of ['', null, undefined]) expect(await fetchActiveCampaign(base)).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  // Public marketing data: no visitor session may ride along cross-origin.
  it('sends no credentials', async () => {
    const spy = mockFetch(async () => new Response(JSON.stringify({ campaign: VALID })))
    await fetchActiveCampaign('https://app.argus-qa.com')
    expect(spy.mock.calls[0][1].credentials).toBe('omit')
  })

  // Every one of these must mean "no override", never a throw — an unhandled
  // rejection here would take the pricing section down with it.
  it('degrades to null on any failure', async () => {
    const cases = [
      ['network error', async () => { throw new TypeError('Failed to fetch') }],
      ['HTTP 500', async () => new Response('boom', { status: 500 })],
      ['HTTP 404', async () => new Response('nope', { status: 404 })],
      ['malformed JSON', async () => new Response('<html>not json</html>', { status: 200 })],
      ['no campaign key', async () => new Response(JSON.stringify({}), { status: 200 })],
      ['explicit null', async () => new Response(JSON.stringify({ campaign: null }), { status: 200 })],
    ]
    for (const [label, impl] of cases) {
      mockFetch(impl)
      await expect(fetchActiveCampaign('https://app.argus-qa.com'), label).resolves.toBeNull()
    }
  })

  // A CORS refusal is indistinguishable from a network error in the browser — the
  // exact failure the app-side allowlist exists to prevent. It must still be safe.
  it('degrades to null when the browser blocks the read (CORS)', async () => {
    mockFetch(async () => { throw new TypeError('Failed to fetch') })
    await expect(fetchActiveCampaign('https://app.argus-qa.com')).resolves.toBeNull()
  })

  // Shape validation: a server that answers 200 with something odd must not be
  // able to put a nonsense banner (or a 0%/negative discount) in front of buyers.
  it('rejects a campaign whose shape is wrong', async () => {
    const bad = [
      { ...VALID, slug: '' },
      { ...VALID, code: '' },
      { ...VALID, pctOff: 0 },
      { ...VALID, pctOff: -10 },
      { ...VALID, pctOff: 101 },
      { ...VALID, pctOff: '30' }, // string, not number
      { slug: 'x' },
      'not an object',
      42,
    ]
    for (const campaign of bad) {
      mockFetch(async () => new Response(JSON.stringify({ campaign }), { status: 200 }))
      await expect(fetchActiveCampaign('https://app.argus-qa.com')).resolves.toBeNull()
    }
  })

  it('aborts when the caller unmounts', async () => {
    const ctl = new AbortController()
    mockFetch((_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }),
    )
    const promise = fetchActiveCampaign('https://app.argus-qa.com', { signal: ctl.signal })
    ctl.abort()
    await expect(promise).resolves.toBeNull()
  })
})

describe('campaignToOffer', () => {
  const OFFERS = [
    { id: 'diwali-2026', emoji: '🪔', name: 'Diwali Special', headline: 'Diwali special — 30% off Pro', sub: 'Light up your QA.', code: 'DIWALI30' },
  ]

  // The DB carries no marketing copy, so a known campaign keeps the hand-written
  // emoji/headline and takes only the code + percentage from the server.
  it('keeps hand-written copy for a campaign that matches a compiled-in offer', () => {
    const offer = campaignToOffer({ ...VALID, code: 'DIWALI40', pctOff: 40 }, OFFERS)
    expect(offer.emoji).toBe('🪔')
    expect(offer.headline).toBe('Diwali special — 30% off Pro')
    expect(offer.code).toBe('DIWALI40') // server wins on the enforceable fields
    expect(offer.pctOff).toBe(40)
  })

  it('matches on code when the slug differs', () => {
    const offer = campaignToOffer({ ...VALID, slug: 'renamed' }, OFFERS)
    expect(offer.emoji).toBe('🪔')
  })

  it('synthesizes a headline for a campaign the landing has never heard of', () => {
    const offer = campaignToOffer({ ...VALID, slug: 'flash-sale', code: 'FLASH20', pctOff: 20, name: 'Flash Sale' }, OFFERS)
    expect(offer.id).toBe('flash-sale')
    expect(offer.headline).toContain('20% off')
    expect(offer.code).toBe('FLASH20')
    expect(offer.emoji).toBeTruthy() // never renders a blank slot
  })

  it('pluralizes the duration correctly', () => {
    expect(campaignToOffer({ ...VALID, slug: 'x', code: 'X', durationMonths: 1 }, []).sub).toContain('1 month.')
    expect(campaignToOffer({ ...VALID, slug: 'x', code: 'X', durationMonths: 3 }, []).sub).toContain('3 months')
  })

  it('handles a campaign with no duration', () => {
    const offer = campaignToOffer({ ...VALID, slug: 'x', code: 'X', durationMonths: null }, [])
    expect(offer.sub).toBeTruthy()
    expect(offer.sub).not.toContain('null')
  })

  it('returns null for anything invalid, so the caller falls back', () => {
    for (const bad of [null, undefined, {}, { ...VALID, pctOff: 0 }, 'nope']) {
      expect(campaignToOffer(bad, OFFERS)).toBeNull()
    }
  })

  it('works with no compiled-in offers to match against', () => {
    expect(campaignToOffer(VALID).code).toBe('DIWALI30')
  })
})
