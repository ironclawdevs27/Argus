// ─────────────────────────────────────────────────────────────────────────────
// Live festive-campaign source for the landing banner.
//
// The banner's compiled-in FESTIVE_OFFERS schedule (App.jsx) is the FLOOR: it works
// with no network and no app deploy. This module lets the hosted app's public
// `/api/promos/active` route override it, so editing a campaign in the dashboard
// changes the live banner without rebuilding + redeploying the landing.
//
// Override-only, on purpose. A reachable API with a live campaign wins; a fetch
// error, a timeout, a malformed body, or an authoritative "nothing live right now"
// all leave the compiled-in schedule in charge. That asymmetry means the banner can
// never go blank because the app is down or its promo table is unseeded — the cost
// is that pulling a campaign EARLY also needs it removed from the compiled-in list.
// ─────────────────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 4000

// Shape returned by the app route (lib/promos/promos.ts → PublicCampaign):
//   { slug, name, code, pctOff, startsAt, endsAt, durationMonths }
// Anything not matching that shape is treated as "no campaign" rather than trusted.
function isPublicCampaign(c) {
  return !!c
    && typeof c.slug === 'string' && c.slug.length > 0
    && typeof c.code === 'string' && c.code.length > 0
    && typeof c.pctOff === 'number' && c.pctOff > 0 && c.pctOff <= 100
}

// GET <appUrl>/api/promos/active. Resolves to a PublicCampaign or null; never
// throws and never rejects — "no override" is the only failure mode.
export async function fetchActiveCampaign(appUrl, { signal } = {}) {
  const base = String(appUrl ?? '').replace(/\/$/, '')
  if (!base) return null
  const ctl = typeof AbortController === 'function' ? new AbortController() : null
  const timer = ctl ? setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS) : null
  // Caller-supplied signal (unmount) must also abort the request.
  if (signal && ctl) signal.addEventListener('abort', () => ctl.abort(), { once: true })
  try {
    const res = await fetch(`${base}/api/promos/active`, {
      signal: ctl?.signal ?? signal,
      headers: { accept: 'application/json' },
      // The banner is public marketing — no credentials cross origins for it.
      credentials: 'omit',
      mode: 'cors',
    })
    if (!res.ok) return null
    const body = await res.json()
    return isPublicCampaign(body?.campaign) ? body.campaign : null
  } catch {
    return null // network error, CORS refusal, abort, bad JSON — all "no override"
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// Project a live campaign onto the banner's offer shape. When the campaign matches
// a compiled-in offer (by slug or code) its hand-written emoji/headline/sub are
// kept — those are marketing copy the DB does not carry — and only the code and
// percentage come from the server. An unknown campaign gets a synthesized headline.
export function campaignToOffer(campaign, offers = []) {
  if (!isPublicCampaign(campaign)) return null
  const known = offers.find(o => o.id === campaign.slug || o.code === campaign.code)
  if (known) return { ...known, code: campaign.code, pctOff: campaign.pctOff }

  const months = campaign.durationMonths
  return {
    id: campaign.slug,
    emoji: '🎉',
    name: campaign.name || 'Limited-time offer',
    headline: `${campaign.name || 'Limited-time offer'} — ${campaign.pctOff}% off Pro`,
    sub: months
      ? `Founding price + an extra ${campaign.pctOff}% off your first ${months} month${months === 1 ? '' : 's'}.`
      : `Founding price + an extra ${campaign.pctOff}% off.`,
    code: campaign.code,
    pctOff: campaign.pctOff,
  }
}
