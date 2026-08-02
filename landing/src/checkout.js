// ─────────────────────────────────────────────────────────────────────────────
// Checkout plumbing for the landing page — founding capture, referral capture and
// the Stripe Payment Link URL builder.
//
// Kept out of App.jsx (and free of React) so each piece is a pure, testable
// function. Three jobs:
//
//   1. FOUNDING CAPTURE — a completed founding purchase must leave a row in
//      Supabase `founding_members`, not only in Stripe. The email is stashed
//      BEFORE the redirect to Stripe (the only moment the landing knows it) and
//      recorded on the way back at `?checkout=success`.
//   2. REFERRAL CAPTURE — `?ref=<code>` is persisted so a purchase made minutes
//      later is still attributable. It is stored twice on purpose: localStorage
//      for this origin, and a cookie on the APEX domain so the app subdomain can
//      read it server-side and put it in the Checkout session's `metadata.ref`
//      (which is exactly what the billing webhook credits — lib/billing/webhook.ts).
//   3. URL BUILDING — `client_reference_id` (account link), `prefilled_email`, and
//      `prefilled_promo_code` for the active festive campaign.
//
// Payment-Link limitation, deliberately not papered over: a Payment Link URL
// accepts no `metadata`, and its one free-form field (`client_reference_id`) is
// already carrying the Supabase user id. So on the Payment-Link path a referral is
// RECORDED but not attributed inside the Stripe session; attribution happens when
// checkout moves in-app (the app reads the apex cookie into `metadata.ref`).
// Ref: https://docs.stripe.com/payment-links/url-parameters
// ─────────────────────────────────────────────────────────────────────────────

export const REF_KEY = 'argus_ref'
export const PENDING_FOUNDING_KEY = 'argus_pending_founding'
const REF_TTL_DAYS = 90

// The apex domain both origins share, so a cookie set by argus-qa.com is readable
// by app.argus-qa.com. Returns null for localhost/preview hosts — a Domain
// attribute the browser can't match silently drops the cookie, so we omit it and
// fall back to a host-only cookie.
export function apexCookieDomain(hostname = '') {
  const parts = String(hostname).split('.')
  if (parts.length < 2) return null                    // localhost, single-label hosts
  if (/^\d+$/.test(parts[parts.length - 1])) return null // raw IP
  return `.${parts.slice(-2).join('.')}`
}

// Canonical form for a referral code, mirroring the app's normalizePromoCode
// (lib/promos/promos.ts): upper-case, [A-Z0-9-] only, capped. '' means "none",
// so a junk `?ref=<script>` can never reach storage or a URL.
export function normalizeCode(raw) {
  if (!raw) return ''
  return String(raw).trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 32)
}

function readCookie(name, cookieString = '') {
  for (const part of cookieString.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v.join('='))
  }
  return ''
}

function writeRefCookie(code) {
  const domain = apexCookieDomain(window.location.hostname)
  const bits = [
    `${REF_KEY}=${encodeURIComponent(code)}`,
    'path=/',
    `max-age=${REF_TTL_DAYS * 24 * 60 * 60}`,
    'SameSite=Lax',
  ]
  if (domain) bits.push(`domain=${domain}`)
  if (window.location.protocol === 'https:') bits.push('Secure')
  document.cookie = bits.join('; ')
}

// Read `?ref=` off a query string and persist it. Returns the stored code (the
// freshly captured one, or whatever was already stored). Storage is best-effort:
// Safari private mode throws on localStorage, which must never break the page.
export function captureReferral(search = '') {
  const incoming = normalizeCode(new URLSearchParams(search).get('ref'))
  if (incoming) {
    try { window.localStorage.setItem(REF_KEY, incoming) } catch { /* private mode */ }
    try { writeRefCookie(incoming) } catch { /* cookies blocked */ }
    return incoming
  }
  return storedReferral()
}

export function storedReferral() {
  try {
    const fromLs = normalizeCode(window.localStorage.getItem(REF_KEY))
    if (fromLs) return fromLs
  } catch { /* private mode */ }
  try {
    return normalizeCode(readCookie(REF_KEY, document.cookie))
  } catch {
    return ''
  }
}

// Build the POLAR Checkout Link URL. Pure: takes the base link plus what we know,
// returns a string. An absent field is simply not appended.
//
// Polar replaced Stripe as the processor because Stripe India is invite-only and
// never onboarded us. A Polar Checkout Link is the direct analogue of a Stripe
// Payment Link — a long-lived URL that mints a fresh Checkout Session per visit —
// but the parameter NAMES differ, and getting them wrong fails silently (an
// unrecognised param is ignored, so the buyer just sees an unbound, undiscounted
// checkout). The mapping, for anyone reading this next to the git history:
//   client_reference_id  → reference_id
//   prefilled_email      → customer_email
//   prefilled_promo_code → discount_code
// Ref: https://polar.sh/docs/features/checkout/links
export function buildCheckoutUrl(checkoutUrl, { userId, email, promoCode } = {}) {
  const url = new URL(checkoutUrl)
  // Ties the payment → account, so the webhook resolves the org without having to
  // match on email (lib/billing/webhook.ts → findOrgIdByUserId). A query string
  // cannot carry metadata, so this single free-form field IS the account binding
  // on the link path; the app's own checkout additionally sends metadata.user_id.
  if (userId) url.searchParams.set('reference_id', userId)
  if (email) url.searchParams.set('customer_email', email)
  // The festive campaign's discount. `discount_code` prefills the code input and
  // only works for a Polar discount that HAS a code set — a code-less (automatic)
  // discount cannot be prefilled this way, and an unknown code is simply not
  // applied. So the operator's job is unchanged from the Stripe era: keep the
  // Polar discount's code + redemption window matched to the campaign (§8.5).
  const promo = normalizeCode(promoCode)
  if (promo) url.searchParams.set('discount_code', promo)
  return url.toString()
}

// Stash what we know about the buyer immediately before handing off to Stripe.
// The redirect is a full page navigation, so component state does not survive it
// and the Payment Link gives us nothing back but `?checkout=success`.
export function stashPendingFounding({ email, userId, plan } = {}) {
  if (!email) return
  try {
    window.localStorage.setItem(PENDING_FOUNDING_KEY, JSON.stringify({
      email: String(email).trim().toLowerCase(),
      userId: userId ?? null,
      plan: plan ?? null,
      ref: storedReferral() || null,
      at: Date.now(),
    }))
  } catch { /* private mode — capture degrades to the session-email path below */ }
}

// Consume the stash (single-use: read then clear, so a reload can't re-fire).
export function takePendingFounding() {
  try {
    const raw = window.localStorage.getItem(PENDING_FOUNDING_KEY)
    window.localStorage.removeItem(PENDING_FOUNDING_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed.email === 'string' ? parsed : null
  } catch {
    return null
  }
}

// Record the founding purchase in Supabase.
//
// Goes through the `capture_founding_member` RPC rather than a table write. The table
// grants anon INSERT but deliberately no SELECT, and a PostgREST upsert (`on_conflict`)
// demands SELECT — granting it would expose every founding member's email to the
// public anon key. The SECURITY DEFINER function dedupes server-side instead, and
// returns void either way so it can't be used to test whether an address is a member.
//
// Falls back to a plain insert when the function is missing (a database that has not
// had the migration applied yet): losing a capture is the outcome T4.1 exists to
// prevent, so a duplicate-key rejection there counts as already-captured.
//
// Returns { ok } / { ok:false, reason } — the caller shows the thank-you toast either
// way; a capture failure must never look like a failed purchase.
export async function recordFoundingMember(client, email) {
  if (!client) return { ok: false, reason: 'no-supabase-client' }
  const clean = String(email ?? '').trim().toLowerCase()
  if (!clean || !clean.includes('@')) return { ok: false, reason: 'no-email' }
  try {
    const { error } = await client.rpc('capture_founding_member', { p_email: clean })
    if (!error) return { ok: true, email: clean }
    // PGRST202 = no such function in the exposed schema.
    if (error.code !== 'PGRST202') return { ok: false, reason: error.message }

    const { error: insertError } = await client.from('founding_members').insert({ email: clean })
    if (!insertError) return { ok: true, email: clean, via: 'insert-fallback' }
    // 23505 = unique violation → the row is already there, which is success.
    if (insertError.code === '23505') return { ok: true, email: clean, via: 'already-captured' }
    return { ok: false, reason: insertError.message }
  } catch (err) {
    return { ok: false, reason: err?.message ?? 'capture-threw' }
  }
}

// Strip a one-shot query param from the address bar without adding a history entry.
export function stripQueryParam(name) {
  const url = new URL(window.location.href)
  if (!url.searchParams.has(name)) return
  url.searchParams.delete(name)
  window.history.replaceState({}, '', url.pathname + url.search + url.hash)
}
