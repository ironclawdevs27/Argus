import { useState, useEffect } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { ArrowUpRight } from 'lucide-react'
import { FALLBACK_TOTAL } from './useNpmDownloads'
import { accent, accentDark, SUCCESS } from './theme'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const PURPLE_GRADIENT = `linear-gradient(135deg, ${accent(0.96)} 0%, ${accentDark(0.96)} 100%)`
const EASE = [0.22, 1, 0.36, 1]

function fmtSince(day) {
  if (!day) return ''
  const [y, m, d] = day.split('-')
  return `${parseInt(d, 10)} ${MONTHS[parseInt(m, 10) - 1]} ${y}`
}

// requestAnimationFrame count-up (easeOutCubic). run=false → jumps straight to target.
function useCountUp(target, duration = 1700, run = true) {
  const [n, setN] = useState(run ? 0 : target)
  useEffect(() => {
    if (!run) { setN(target); return }
    let raf, start
    const tick = (t) => {
      if (start === undefined) start = t
      const p = Math.min(1, (t - start) / duration)
      const eased = 1 - Math.pow(1 - p, 3)
      setN(Math.round(target * eased))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, duration, run])
  return n
}

/**
 * Hero download badge. On load it reveals a full-width purple band at screen centre
 * with a count-up, then crossfades to a rounded purple square at the bottom-right of
 * the viewport. Hides once the user scrolls past the first screen. Respects
 * reduced-motion (skips straight to the docked square with the final number).
 *
 * Positioning: a single `position: fixed; inset: 0` frame holds both phases, which are
 * positioned ABSOLUTELY inside it. This guarantees the docked square is placed relative
 * to the viewport on EVERY screen size — the previous version morphed the two phases with
 * framer-motion's `layout` on a `position: fixed` element, whose layout projection is
 * unreliable for fixed elements and left the square clipped off-screen on narrow viewports.
 */
export function DownloadBadge({ total, error, firstPublish }) {
  const reduce = useReducedMotion()
  const displayTotal = total > 0 ? total : (error ? FALLBACK_TOTAL : 0)

  const [phase, setPhase] = useState('pending')   // pending → intro → docked
  const [hidden, setHidden] = useState(false)

  // Begin once we actually have a number to count to (instant on session-cached visits).
  useEffect(() => {
    if (displayTotal <= 0 || phase !== 'pending') return
    setPhase(reduce ? 'docked' : 'intro')
  }, [displayTotal, phase, reduce])

  // intro → docked after the count-up settles.
  useEffect(() => {
    if (phase !== 'intro') return
    const t = setTimeout(() => setPhase('docked'), 2400)
    return () => clearTimeout(t)
  }, [phase])

  // Fade the docked badge out once the hero has scrolled away.
  useEffect(() => {
    if (phase !== 'docked') return
    const onScroll = () => setHidden(window.scrollY > window.innerHeight * 0.82)
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener('scroll', onScroll)
  }, [phase])

  const count = useCountUp(displayTotal, 1700, phase === 'intro' && !reduce)
  if (phase === 'pending') return null

  const intro = phase === 'intro'
  const shown = intro ? count : displayTotal

  // Both phases are positioned ABSOLUTELY inside the fixed viewport frame below.
  const bandStyle = {
    position: 'absolute', left: 0, right: 0, top: 'calc(50% - 72px)', height: 144,
    background: PURPLE_GRADIENT,
    borderTop: '1px solid rgba(255,255,255,0.25)', borderBottom: '1px solid rgba(255,255,255,0.18)',
    boxShadow: `0 20px 80px ${accent(0.45)}`,
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    pointerEvents: 'none', borderRadius: 0,
  }
  const squareStyle = {
    position: 'absolute', right: 'clamp(16px, 4vw, 40px)', bottom: 'clamp(16px, 4vw, 40px)',
    width: 'clamp(150px, 21vw, 200px)', maxWidth: 'calc(100vw - 32px)', padding: '1.05rem 1.2rem',
    background: PURPLE_GRADIENT,
    border: '1px solid rgba(255,255,255,0.18)',
    boxShadow: `0 12px 44px ${accent(0.4)}`,
    display: 'flex', flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'center',
    pointerEvents: 'auto', cursor: 'pointer', borderRadius: '1.4rem',
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 45, pointerEvents: 'none', overflow: 'hidden' }}>
      {/* Phase 1 — centre count-up band (crossfades out on dock). */}
      <AnimatePresence>
        {intro && (
          <motion.div
            key="band"
            initial={{ opacity: 0, scaleY: 0.7 }}
            animate={{ opacity: 1, scaleY: 1 }}
            exit={{ opacity: 0, scale: 0.94 }}
            transition={{ duration: 0.5, ease: EASE }}
            style={bandStyle}
          >
            <motion.span
              style={{
                fontWeight: 700, color: '#fff', lineHeight: 1, letterSpacing: '-0.02em',
                fontSize: 'clamp(2.5rem, 9vw, 5.5rem)',
              }}
            >
              {shown.toLocaleString()}
            </motion.span>
            <span
              style={{
                fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.82)',
                marginTop: '0.6rem', fontSize: 'clamp(0.65rem, 1.4vw, 0.85rem)',
              }}
            >
              npm downloads and counting
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Phase 2 — docked corner square (fades in; scroll-hide via opacity, not unmount). */}
      {phase === 'docked' && (
        <motion.div
          initial={{ opacity: 0, scale: 0.85, y: 14 }}
          animate={{ opacity: hidden ? 0 : 1, scale: hidden ? 0.85 : 1, y: hidden ? 14 : 0 }}
          transition={{ duration: 0.5, ease: EASE }}
          onClick={() => document.getElementById('growth')?.scrollIntoView({ behavior: 'smooth' })}
          role="button"
          aria-label={`${displayTotal.toLocaleString()} npm downloads — view growth charts`}
          style={{ ...squareStyle, visibility: hidden ? 'hidden' : 'visible' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.35rem', width: '100%' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: SUCCESS, boxShadow: `0 0 8px ${SUCCESS}`, flexShrink: 0 }} />
            <span style={{ fontSize: '0.5rem', fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.7)' }}>
              Live · npm
            </span>
            <ArrowUpRight size={12} color="rgba(255,255,255,0.6)" style={{ marginLeft: 'auto' }} />
          </div>

          <span
            style={{
              fontWeight: 700, color: '#fff', lineHeight: 1, letterSpacing: '-0.02em',
              marginTop: '0.25rem', fontSize: '1.7rem',
            }}
          >
            {displayTotal.toLocaleString()}
          </span>

          <span
            style={{
              fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.82)',
              marginTop: '0.25rem', fontSize: '0.56rem',
            }}
          >
            downloads
          </span>

          {firstPublish && (
            <span style={{ marginTop: '0.3rem', fontSize: '0.5rem', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)' }}>
              since {fmtSince(firstPublish)}
            </span>
          )}
        </motion.div>
      )}
    </div>
  )
}
