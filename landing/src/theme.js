// landing/src/theme.js — single source of truth for the Argus landing palette.
// Every brand / status colour lives here so there is exactly ONE code per hue.
// Import the hex constants for solid colours and the rgba() helpers for any
// translucent shade, so every tint stays tied to its canonical hex.

// ── Brand purple ─────────────────────────────────────────────────────────────
export const ACCENT       = '#5E0ED7'   // rgb(94,14,215)    — primary brand purple
export const ACCENT_DARK  = '#3A088A'   // rgb(58,8,138)     — deep brand purple (gradient ends)
export const ACCENT_LIGHT = '#A882FF'   // rgb(168,130,255)  — light lavender (glass rims / highlights)

// ── Status ───────────────────────────────────────────────────────────────────
export const SUCCESS = '#7CFFB2'        // rgb(124,255,178)  — live / online accents
export const DANGER  = '#EF4444'        // form / error text
export const WARNING = '#FFC800'        // rgb(255,200,0)    — "coming soon" badges

// ── Surfaces ─────────────────────────────────────────────────────────────────
export const SURFACE_TINT = '#F7F5FF'   // light lavender-white section background

// ── Translucent helpers — keep every rgba() shade tied to the hexes above ─────
export const accent      = (a) => `rgba(94,14,215,${a})`
export const accentDark  = (a) => `rgba(58,8,138,${a})`
export const accentLight = (a) => `rgba(168,130,255,${a})`
export const success     = (a) => `rgba(124,255,178,${a})`
export const warning     = (a) => `rgba(255,200,0,${a})`
