import { useState, useMemo } from 'react'
import { motion } from 'framer-motion'
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis,
  CartesianGrid, Tooltip, ReferenceArea,
} from 'recharts'
import { ArrowUpRight, TrendingUp, GitBranch, Shield, Download } from 'lucide-react'
import { aggregate, FALLBACK_TOTAL } from './useNpmDownloads'
import { ACCENT, SUCCESS, WARNING, DANGER, accent } from './theme'
import { githubTraffic, socketScores, pulseStats, SNAPSHOT_DATE } from './growthData'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const NPMSTAT_URL = 'https://npm-stat.com/charts.html?package=argusqa-os'
const GITHUB_URL = 'https://github.com/ironclawdevs27/Argus'

const SOURCES = [
  { id: 'npm', label: 'npm Downloads', icon: Download },
  { id: 'github', label: 'GitHub Traffic', icon: GitBranch },
  { id: 'security', label: 'Security', icon: Shield },
]
const NPM_TABS = [
  { id: 'day', label: 'Day' }, { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' }, { id: 'year', label: 'Year' },
]
const GH_METRICS = [
  { id: 'clones', label: 'Clones' }, { id: 'cloners', label: 'Unique cloners' },
  { id: 'views', label: 'Views' }, { id: 'visitors', label: 'Unique visitors' },
]

function fmtSince(day) {
  if (!day) return ''
  const [y, m, d] = day.split('-')
  return `${parseInt(d, 10)} ${MONTHS[parseInt(m, 10) - 1]} ${y}`
}

// ── Themed tooltip ───────────────────────────────────────────────────────────────
function DlTooltip({ active, payload, unit }) {
  if (!active || !payload || !payload.length) return null
  const p = payload[0].payload
  return (
    <div style={{
      background: '#0d0d0d', border: `1px solid ${accent(0.45)}`, borderRadius: 12,
      padding: '0.55rem 0.8rem', boxShadow: '0 10px 34px rgba(0,0,0,0.55)',
    }}>
      <p style={{ margin: 0, fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.5)' }}>
        {p.full ?? p.label}
      </p>
      <p style={{ margin: '0.25rem 0 0', fontSize: '1.05rem', fontWeight: 700, color: '#fff' }}>
        {(p.value ?? 0).toLocaleString()}
        <span style={{ fontSize: '0.68rem', fontWeight: 500, color: ACCENT, marginLeft: 6 }}>{unit}</span>
      </p>
    </div>
  )
}

// ── Reusable area chart with click-drag-to-zoom ──────────────────────────────────
function GrowthChart({ data, unit }) {
  const [refL, setRefL] = useState(null)
  const [refR, setRefR] = useState(null)
  const [zoom, setZoom] = useState(null)

  const view = zoom ? data.slice(zoom[0], zoom[1] + 1) : data
  const labelByKey = useMemo(() => Object.fromEntries(data.map(d => [d.key, d.label])), [data])

  const clearSel = () => { setRefL(null); setRefR(null) }
  const commit = () => {
    if (refL == null || refR == null || refL === refR) { clearSel(); return }
    let i0 = data.findIndex(d => d.key === refL)
    let i1 = data.findIndex(d => d.key === refR)
    if (i0 < 0 || i1 < 0) { clearSel(); return }
    if (i0 > i1) [i0, i1] = [i1, i0]
    setZoom([i0, i1]); clearSel()
  }

  return (
    <div style={{ position: 'relative' }}>
      {zoom && (
        <button
          onClick={() => setZoom(null)}
          style={{
            position: 'absolute', top: 0, right: 0, zIndex: 2,
            padding: '0.35rem 0.85rem', borderRadius: '2rem', cursor: 'pointer',
            background: accent(0.15), border: `1px solid ${accent(0.4)}`,
            color: '#fff', fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.12em',
            textTransform: 'uppercase', fontFamily: 'inherit',
          }}
        >
          Reset zoom
        </button>
      )}
      <ResponsiveContainer width="100%" height={340}>
        <AreaChart
          data={view}
          margin={{ top: 16, right: 12, left: -10, bottom: 0 }}
          onMouseDown={e => { if (e && e.activeLabel != null) setRefL(e.activeLabel) }}
          onMouseMove={e => { if (refL != null && e && e.activeLabel != null) setRefR(e.activeLabel) }}
          onMouseUp={commit}
          onMouseLeave={clearSel}
          style={{ cursor: 'crosshair', userSelect: 'none' }}
        >
          <defs>
            <linearGradient id="argusGrowthFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={ACCENT} stopOpacity={0.5} />
              <stop offset="100%" stopColor={ACCENT} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
          <XAxis
            dataKey="key" tickFormatter={k => labelByKey[k] ?? k}
            tick={{ fill: 'rgba(255,255,255,0.42)', fontSize: 11 }}
            axisLine={{ stroke: 'rgba(255,255,255,0.1)' }} tickLine={false} minTickGap={28}
          />
          <YAxis
            tick={{ fill: 'rgba(255,255,255,0.42)', fontSize: 11 }}
            axisLine={false} tickLine={false} width={46} allowDecimals={false}
          />
          <Tooltip content={<DlTooltip unit={unit} />} cursor={{ stroke: ACCENT, strokeWidth: 1, strokeOpacity: 0.45 }} />
          <Area
            type="monotone" dataKey="value" stroke={ACCENT} strokeWidth={2}
            fill="url(#argusGrowthFill)" animationDuration={500} dot={false}
            activeDot={{ r: 4, fill: ACCENT, stroke: '#fff', strokeWidth: 1.5 }}
          />
          {refL && refR && <ReferenceArea x1={refL} x2={refR} strokeOpacity={0.3} fill={ACCENT} fillOpacity={0.12} />}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── Pill tabs ────────────────────────────────────────────────────────────────────
function PillTabs({ tabs, active, onChange }) {
  return (
    <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
      {tabs.map(t => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          style={{
            padding: '0.5rem 1.1rem', borderRadius: '2rem', cursor: 'pointer',
            border: active === t.id ? 'none' : '1px solid rgba(255,255,255,0.12)',
            background: active === t.id ? ACCENT : 'transparent',
            color: active === t.id ? '#fff' : 'rgba(255,255,255,0.5)',
            fontWeight: 600, fontSize: '0.78rem', letterSpacing: '0.06em',
            fontFamily: 'inherit', transition: 'all 0.18s ease',
            display: 'inline-flex', alignItems: 'center', gap: '0.45rem',
          }}
        >
          {t.icon && <t.icon size={14} />}
          {t.label}
        </button>
      ))}
    </div>
  )
}

function Stat({ value, label, accent: isAccent }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <span style={{ fontSize: 'clamp(1.5rem, 4vw, 2.5rem)', fontWeight: 700, lineHeight: 1, letterSpacing: '-0.02em', color: isAccent ? ACCENT : '#fff' }}>
        {value}
      </span>
      <span style={{ marginTop: '0.4rem', fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.4)' }}>
        {label}
      </span>
    </div>
  )
}

// ── Socket score ring ────────────────────────────────────────────────────────────
function ScoreRing({ label, value }) {
  const r = 34
  const circ = 2 * Math.PI * r
  const color = value >= 90 ? SUCCESS : value >= 75 ? WARNING : DANGER
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.7rem' }}>
      <svg width={88} height={88} viewBox="0 0 88 88">
        <circle cx="44" cy="44" r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="7" />
        <motion.circle
          cx="44" cy="44" r={r} fill="none" stroke={color} strokeWidth="7" strokeLinecap="round"
          strokeDasharray={circ} transform="rotate(-90 44 44)"
          initial={{ strokeDashoffset: circ }}
          whileInView={{ strokeDashoffset: circ * (1 - value / 100) }}
          viewport={{ once: true }}
          transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }}
        />
        <text x="44" y="44" textAnchor="middle" dominantBaseline="central" fill="#fff" fontSize="22" fontWeight="700">{value}</text>
      </svg>
      <span style={{ fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)', textAlign: 'center', maxWidth: 96, lineHeight: 1.4 }}>
        {label}
      </span>
    </div>
  )
}

function SourceLink({ href, children }) {
  return (
    <a
      href={href} target="_blank" rel="noopener noreferrer"
      style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.04em', color: 'rgba(255,255,255,0.4)', textDecoration: 'none' }}
      onMouseEnter={e => (e.currentTarget.style.color = '#fff')}
      onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.4)')}
    >
      {children}<ArrowUpRight size={12} />
    </a>
  )
}

export function DownloadsSection({ daily, total, firstPublish, loading, error }) {
  const [source, setSource] = useState('npm')
  const [npmTab, setNpmTab] = useState('day')
  const [ghMetric, setGhMetric] = useState('clones')

  const npmData = useMemo(() => aggregate(daily, npmTab), [daily, npmTab])
  const safeTotal = total > 0 ? total : (error ? FALLBACK_TOTAL : 0)
  const npmHasData = npmData.length > 0
  const ghData = githubTraffic[ghMetric]
  const t = githubTraffic.totals
  const ghSubtitle = (ghMetric === 'clones' || ghMetric === 'cloners')
    ? `${t.clones.toLocaleString()} clones · ${t.uniqueCloners} unique cloners`
    : `${t.views} views · ${t.uniqueVisitors} unique visitors`

  return (
    <section
      id="growth"
      style={{
        background: 'radial-gradient(120% 100% at 50% 0%, #0c0718 0%, #050505 55%)',
        padding: 'clamp(5rem, 10vw, 9rem) clamp(1.25rem, 6vw, 5rem)',
        borderTop: '1px solid rgba(255,255,255,0.05)',
      }}
    >
      <div style={{ maxWidth: 1120, margin: '0 auto' }}>
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          style={{ marginBottom: 'clamp(2.5rem, 5vw, 4rem)' }}
        >
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
            padding: '0.3rem 0.875rem', borderRadius: '2rem',
            border: `1px solid ${accent(0.3)}`, background: accent(0.1), marginBottom: '1.5rem',
          }}>
            <TrendingUp size={12} color={ACCENT} />
            <span style={{ fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: ACCENT }}>
              Momentum
            </span>
          </div>
          <h2 style={{ fontSize: 'clamp(2rem, 5vw, 4rem)', fontWeight: 600, color: '#fff', lineHeight: 1.08, letterSpacing: '-0.02em', margin: 0 }}>
            Real adoption, in real time.
          </h2>
          <p style={{ margin: '1rem 0 0', maxWidth: 560, fontSize: 'clamp(0.9rem, 1.3vw, 1.05rem)', color: 'rgba(255,255,255,0.4)', lineHeight: 1.7 }}>
            npm installs stream live from the registry{firstPublish ? ` since ${fmtSince(firstPublish)}` : ''}. GitHub traffic, the Socket supply-chain audit, and the Pulse MCP rank are point-in-time snapshots ({SNAPSHOT_DATE}).
          </p>
        </motion.div>

        {/* Cross-source stat strip */}
        <motion.div
          initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ delay: 0.1, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          style={{ display: 'flex', gap: 'clamp(1.75rem, 5vw, 4rem)', flexWrap: 'wrap', marginBottom: 'clamp(2rem, 4vw, 3rem)' }}
        >
          <Stat accent value={safeTotal.toLocaleString()} label="npm Downloads" />
          <Stat value={t.clones.toLocaleString()} label="Git Clones · 14d" />
          <Stat value={pulseStats.estVisitors} label="Est. Visitors" />
          <Stat value={pulseStats.rank} label={`Pulse Rank · peak ${pulseStats.peakRank}`} />
        </motion.div>

        {/* Source tabs */}
        <motion.div
          initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ delay: 0.15, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          style={{ marginBottom: '1.25rem' }}
        >
          <PillTabs tabs={SOURCES} active={source} onChange={setSource} />
        </motion.div>

        {/* Panel card */}
        <motion.div
          initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-60px' }}
          transition={{ delay: 0.2, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          style={{
            background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '1.5rem', padding: 'clamp(1.25rem, 3vw, 2rem)',
          }}
        >
          {/* ── npm Downloads ── */}
          {source === 'npm' && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem', marginBottom: '1.5rem' }}>
                <PillTabs tabs={NPM_TABS} active={npmTab} onChange={setNpmTab} />
                <span style={{ fontSize: '0.62rem', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.28)' }}>
                  {loading ? 'Loading…' : 'Live · drag to zoom'}
                </span>
              </div>
              {npmHasData ? (
                <GrowthChart data={npmData} unit="downloads" />
              ) : (
                <div style={{ height: 340, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.35)', fontSize: '0.85rem' }}>
                  {loading ? 'Fetching live npm stats…' : 'Live download stats are momentarily unavailable.'}
                </div>
              )}
            </>
          )}

          {/* ── GitHub Traffic ── */}
          {source === 'github' && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem', marginBottom: '1.5rem' }}>
                <PillTabs tabs={GH_METRICS} active={ghMetric} onChange={setGhMetric} />
                <span style={{ fontSize: '0.62rem', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.28)' }}>
                  Last 14 days · {SNAPSHOT_DATE}
                </span>
              </div>
              <GrowthChart data={ghData} unit={ghMetric} />
              <p style={{ margin: '1rem 0 0', fontSize: '0.78rem', color: 'rgba(255,255,255,0.4)' }}>{ghSubtitle}</p>
            </>
          )}

          {/* ── Security (Socket) ── */}
          {source === 'security' && (
            <div style={{ padding: '0.5rem 0' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'clamp(1.5rem, 4vw, 2.75rem)', justifyContent: 'center', padding: '1rem 0 1.75rem' }}>
                {socketScores.scores.map(s => <ScoreRing key={s.label} label={s.label} value={s.value} />)}
              </div>
              <p style={{ margin: 0, textAlign: 'center', fontSize: '0.85rem', color: 'rgba(255,255,255,0.45)', lineHeight: 1.6 }}>
                Overall Socket score <strong style={{ color: '#fff' }}>{socketScores.overall}/100</strong> — independent supply-chain analysis (vulnerabilities, quality, maintenance, license).
              </p>
            </div>
          )}
        </motion.div>

        {/* Source links */}
        <motion.div
          initial={{ opacity: 0 }} whileInView={{ opacity: 1 }}
          viewport={{ once: true, margin: '-40px' }}
          transition={{ delay: 0.3, duration: 0.5 }}
          style={{ marginTop: '1.25rem', display: 'flex', gap: 'clamp(1rem, 3vw, 2rem)', flexWrap: 'wrap', justifyContent: 'flex-end' }}
        >
          <SourceLink href={NPMSTAT_URL}>npm registry</SourceLink>
          <SourceLink href={GITHUB_URL}>GitHub</SourceLink>
          <SourceLink href={socketScores.url}>Socket.dev</SourceLink>
          <SourceLink href={pulseStats.url}>Pulse MCP</SourceLink>
        </motion.div>
      </div>
    </section>
  )
}
