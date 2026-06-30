// landing/src/SecuritySection.jsx — "Security & Compliance" (the Aegis egress boundary).
// A below-the-fold, scroll-animated section: a flow diagram of how a finding is split
// into a full-fidelity LOCAL path and a redacted EGRESS path, the 5-layer detection
// stack, a real-data recall chart, and the compliance posture. Lazy-loaded from App.jsx.
//
// Dependency-light by design: framer-motion + inline SVG/CSS only (no Recharts here),
// so the heavy chart bundle is not pulled twice. Palette comes from theme.js.
import { motion } from 'framer-motion'
import {
  Shield, Eye, Database, Layers, Terminal, GitBranch, Globe, Bell,
  Search, KeyRound, ScanLine, CheckCircle, AlertTriangle, ArrowRight,
} from 'lucide-react'
import { ACCENT, ACCENT_LIGHT, SUCCESS, WARNING, DANGER, accent, accentLight, success } from './theme'

// ── Animation primitives ─────────────────────────────────────────────────────────
const EASE = [0.22, 1, 0.36, 1]

const reveal = {
  hidden: { opacity: 0, y: 28 },
  show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: EASE } },
}
const stagger = (gap = 0.1) => ({
  hidden: {},
  show: { transition: { staggerChildren: gap } },
})
const VIEWPORT = { once: true, margin: '-70px' }

// ── Small UI atoms ─────────────────────────────────────────────────────────────
function Pill({ children, color = SUCCESS }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '0.3rem 0.7rem', borderRadius: 999, fontSize: '0.62rem', fontWeight: 800,
      letterSpacing: '0.14em', textTransform: 'uppercase',
      color, background: `${color}1a`, border: `1px solid ${color}3a`,
    }}>{children}</span>
  )
}

function Mono({ children, dim, strike }) {
  return (
    <span style={{
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: '0.72rem', lineHeight: 1.65, wordBreak: 'break-all',
      color: dim ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.82)',
      textDecoration: strike ? 'line-through' : 'none',
    }}>{children}</span>
  )
}

// ── The redaction example (synthetic, obviously-fake values) ─────────────────────
const RAW_LINES = [
  ['type', 'security_no_https', false],
  ['severity', 'critical', false],
  ['route', '/login', false],
  ['url', 'http://app.internal:8080/login?session=eyJhbGci…', true],
  ['message', 'posts creds over HTTP; Authorization: Bearer sk-ant-api03-Aa1Bb2Cc…', true],
  ['evidence', '<form action="http://app.internal/login">', true],
]
const REDACTED_LINES = [
  ['type', 'security_no_https'],
  ['severity', 'critical'],
  ['route', '/login'],
  ['url', 'http://app.internal:8080/login'],
  ['title', 'security_no_https on /login (critical)'],
  ['detail', '🔒 redacted — full detail in local report'],
]

const SINKS = [
  { icon: Terminal, label: 'Agent context (MCP)' },
  { icon: Bell, label: 'Slack' },
  { icon: GitBranch, label: 'GitHub PR' },
  { icon: Globe, label: 'Hosted HTML / CI' },
]

const LAYERS = [
  { icon: Layers, name: 'Category rules', note: 'security_* types, any body/stack field, unknown shapes → sensitive', tone: ACCENT },
  { icon: KeyRound, name: 'Secret regex — 13 rules', note: 'JWT · AWS · Google · Slack · OpenAI/Anthropic · GitHub PAT · PEM · Bearer · basic-auth URL', tone: ACCENT },
  { icon: ScanLine, name: 'Statistical rarity', note: 'token-efficiency (BPE) with a Shannon-entropy zero-dep fallback', tone: ACCENT_LIGHT },
  { icon: Search, name: 'PII + checksum — 7 rules', note: 'email · phone · Luhn-validated card · SSN · IPv4/6 · private host', tone: ACCENT_LIGHT },
  { icon: Eye, name: 'Context boosting', note: 'a token near “secret / password / bearer / cookie” is promoted', tone: WARNING },
]

const PRINCIPLES = [
  { icon: AlertTriangle, title: 'Fail-closed', tone: WARNING,
    body: 'On any classifier error or unknown shape, Aegis redacts more — never less. The one deliberate inversion of Argus’s other post-processors.' },
  { icon: Shield, title: 'Deny-by-default', tone: ACCENT_LIGHT,
    body: 'Only an explicit allowlist of safe fields ever crosses. A field added next year leaks nothing until someone deliberately allows it.' },
  { icon: Database, title: 'Local fidelity preserved', tone: SUCCESS,
    body: 'The on-disk JSON report and the locally-opened HTML keep 100% detail. Redaction only ever removes detail on the way out.' },
  { icon: CheckCircle, title: 'OWASP LLM02:2025', tone: ACCENT_LIGHT,
    body: 'Implements the #2 LLM risk’s mitigations — data minimization, redaction, deny-by-default egress — at Argus’s own boundaries. Maps to NIST AI RMF.' },
]

// ── Finding card (raw vs redacted) ───────────────────────────────────────────────
function FindingCard({ kind }) {
  const raw = kind === 'raw'
  const edge = raw ? DANGER : SUCCESS
  const lines = raw ? RAW_LINES : REDACTED_LINES
  return (
    <div style={{
      flex: '1 1 280px', minWidth: 0,
      background: 'rgba(255,255,255,0.025)',
      border: `1px solid ${edge}33`, borderRadius: 18, padding: '1.2rem 1.25rem',
      boxShadow: raw ? 'none' : `0 0 0 1px ${edge}14, 0 18px 50px ${accent(0.18)}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: '0.9rem' }}>
        <Pill color={edge}>{raw ? 'Local · full fidelity' : 'Egress · redacted'}</Pill>
        {raw
          ? <Eye size={16} color={`${edge}cc`} />
          : <span style={{ fontSize: '1rem' }}>🔒</span>}
      </div>
      <div style={{ display: 'grid', gap: '0.34rem' }}>
        {lines.map(([k, v, secret]) => (
          <div key={k} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
            <span style={{
              fontFamily: 'ui-monospace, monospace', fontSize: '0.66rem', fontWeight: 700,
              color: accentLight(0.85), minWidth: 64, flexShrink: 0,
            }}>{k}</span>
            <Mono dim={raw && secret} strike={raw && secret}>{v}</Mono>
          </div>
        ))}
      </div>
      <p style={{ margin: '0.95rem 0 0', fontSize: '0.7rem', lineHeight: 1.6, color: 'rgba(255,255,255,0.5)' }}>
        {raw
          ? 'Written to disk in full. The JWT, the Bearer key, the query string — all preserved for you locally.'
          : 'type + route + severity + a 🔒 marker. The query string is stripped; the secret never crossed.'}
      </p>
    </div>
  )
}

// ── The egress flow diagram ──────────────────────────────────────────────────────
function FlowDiagram() {
  return (
    <motion.div
      variants={reveal} initial="hidden" whileInView="show" viewport={VIEWPORT}
      style={{
        position: 'relative', borderRadius: 28, padding: 'clamp(1.4rem, 3vw, 2.6rem)',
        background: 'linear-gradient(160deg, rgba(94,14,215,0.16), rgba(10,10,12,0.2))',
        border: `1px solid ${accent(0.35)}`,
      }}
    >
      {/* Origin node */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1.4rem' }}>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 10, padding: '0.7rem 1.15rem',
          borderRadius: 14, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)',
        }}>
          <ScanLine size={18} color={ACCENT_LIGHT} />
          <span style={{ fontSize: '0.82rem', fontWeight: 600, color: '#fff' }}>
            Argus finds a bug carrying a secret
          </span>
        </div>
      </div>

      {/* Split labels */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
        marginBottom: '1.3rem', color: 'rgba(255,255,255,0.4)', fontSize: '0.7rem', fontWeight: 600,
      }}>
        <span style={{ height: 1, flex: 1, maxWidth: 90, background: `linear-gradient(90deg, transparent, ${success(0.6)})` }} />
        one finding · two destinies
        <span style={{ height: 1, flex: 1, maxWidth: 90, background: `linear-gradient(90deg, ${accent(0.6)}, transparent)` }} />
      </div>

      {/* Two branches */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'clamp(1rem, 2.4vw, 1.8rem)', alignItems: 'stretch' }}>
        {/* LEFT — local */}
        <div style={{ flex: '1 1 280px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Database size={16} color={SUCCESS} />
            <span style={{ fontSize: '0.7rem', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: SUCCESS }}>
              Stays on your machine
            </span>
          </div>
          <FindingCard kind="raw" />
        </div>

        {/* MIDDLE — the shield */}
        <div style={{
          flex: '0 0 auto', alignSelf: 'center', display: 'flex', flexDirection: 'column',
          alignItems: 'center', gap: 8, padding: '0.5rem 0.2rem', minWidth: 92,
        }}>
          <div style={{ position: 'relative', width: 64, height: 64, display: 'grid', placeItems: 'center' }}>
            <motion.span
              aria-hidden
              animate={{ scale: [1, 1.35, 1], opacity: [0.55, 0, 0.55] }}
              transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }}
              style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: `2px solid ${ACCENT_LIGHT}` }}
            />
            <div style={{
              width: 52, height: 52, borderRadius: '50%', display: 'grid', placeItems: 'center',
              background: `radial-gradient(circle at 30% 25%, ${accentLight(0.9)}, ${ACCENT})`,
              boxShadow: `0 10px 30px ${accent(0.6)}`,
            }}>
              <Shield size={24} color="#fff" fill="rgba(255,255,255,0.18)" />
            </div>
          </div>
          <span style={{ fontSize: '0.62rem', fontWeight: 800, letterSpacing: '0.12em', color: ACCENT_LIGHT }}>AEGIS</span>
          <ArrowRight size={18} color={accentLight(0.7)} />
        </div>

        {/* RIGHT — egress */}
        <div style={{ flex: '1 1 280px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Shield size={16} color={ACCENT_LIGHT} />
            <span style={{ fontSize: '0.7rem', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: ACCENT_LIGHT }}>
              Crosses the boundary
            </span>
          </div>
          <FindingCard kind="redacted" />
        </div>
      </div>

      {/* Sinks fan-out */}
      <div style={{ marginTop: '1.6rem' }}>
        <p style={{ margin: '0 0 0.8rem', textAlign: 'center', fontSize: '0.72rem', color: 'rgba(255,255,255,0.5)' }}>
          Every external sink receives only the redacted projection:
        </p>
        <motion.div
          variants={stagger(0.08)} initial="hidden" whileInView="show" viewport={VIEWPORT}
          style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 10 }}
        >
          {SINKS.map(({ icon: Icon, label }) => (
            <motion.div key={label} variants={reveal} style={{
              display: 'inline-flex', alignItems: 'center', gap: 8, padding: '0.5rem 0.85rem',
              borderRadius: 999, background: 'rgba(255,255,255,0.04)', border: `1px solid ${accent(0.3)}`,
            }}>
              <Icon size={15} color={ACCENT_LIGHT} />
              <span style={{ fontSize: '0.74rem', fontWeight: 600, color: 'rgba(255,255,255,0.85)' }}>{label}</span>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </motion.div>
  )
}

// ── 5-layer detection stack ──────────────────────────────────────────────────────
function LayerStack() {
  return (
    <motion.div variants={stagger(0.1)} initial="hidden" whileInView="show" viewport={VIEWPORT}
      style={{ display: 'grid', gap: '0.7rem' }}>
      {LAYERS.map(({ icon: Icon, name, note, tone }, i) => (
        <motion.div key={name} variants={reveal} style={{
          display: 'flex', alignItems: 'center', gap: 14,
          padding: '0.95rem 1.1rem', borderRadius: 16,
          background: 'rgba(255,255,255,0.03)', border: `1px solid ${tone}2e`,
        }}>
          <div style={{
            flexShrink: 0, width: 38, height: 38, borderRadius: 11, display: 'grid', placeItems: 'center',
            background: `${tone}1f`, border: `1px solid ${tone}44`,
          }}>
            <Icon size={18} color={tone} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: '0.62rem', fontWeight: 800, color: `${tone}`, opacity: 0.7 }}>
                LAYER {i + 1}
              </span>
              <span style={{ fontSize: '0.92rem', fontWeight: 650, color: '#fff' }}>{name}</span>
            </div>
            <p style={{ margin: '0.2rem 0 0', fontSize: '0.74rem', lineHeight: 1.55, color: 'rgba(255,255,255,0.55)' }}>{note}</p>
          </div>
        </motion.div>
      ))}
      <motion.p variants={reveal} style={{
        margin: '0.2rem 0 0', textAlign: 'center', fontSize: '0.74rem', fontWeight: 600, color: accentLight(0.9),
      }}>
        Any one layer firing marks the finding sensitive — a miss by one is caught by another.
      </motion.p>
    </motion.div>
  )
}

// ── Recall lift chart (real CredData numbers from the design research) ────────────
const RECALL = [
  { label: 'Shannon entropy', pct: 68.7, tone: 'rgba(255,255,255,0.32)' },
  { label: 'Token-efficiency (BPE)', pct: 95.8, tone: ACCENT_LIGHT },
]
function RecallChart() {
  return (
    <motion.div variants={reveal} initial="hidden" whileInView="show" viewport={VIEWPORT}
      style={{
        borderRadius: 22, padding: 'clamp(1.3rem, 2.6vw, 2rem)',
        background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.1)',
      }}>
      <div style={{ marginBottom: '1.3rem' }}>
        <Pill color={ACCENT_LIGHT}>Statistical-rarity layer</Pill>
        <h3 style={{ margin: '0.8rem 0 0.3rem', fontSize: 'clamp(1.1rem, 2vw, 1.4rem)', fontWeight: 600, color: '#fff', letterSpacing: '-0.01em' }}>
          Secrets aren’t random — they’re statistically <em style={{ color: ACCENT_LIGHT, fontStyle: 'normal' }}>rare</em>.
        </h3>
        <p style={{ margin: 0, fontSize: '0.78rem', lineHeight: 1.6, color: 'rgba(255,255,255,0.55)' }}>
          Real secrets fragment into many short BPE tokens while prose compresses. On the CredData benchmark,
          token-efficiency lifts secret recall far past entropy — which missed nearly a third of leaked secrets.
        </p>
      </div>
      <div style={{ display: 'grid', gap: '1rem' }}>
        {RECALL.map(({ label, pct, tone }) => (
          <div key={label}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: '0.76rem', fontWeight: 600, color: 'rgba(255,255,255,0.8)' }}>{label}</span>
              <span style={{ fontSize: '0.8rem', fontWeight: 800, color: tone === ACCENT_LIGHT ? ACCENT_LIGHT : 'rgba(255,255,255,0.6)' }}>{pct}%</span>
            </div>
            <div style={{ height: 12, borderRadius: 999, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
              <motion.div
                initial={{ width: 0 }} whileInView={{ width: `${pct}%` }} viewport={{ once: true }}
                transition={{ duration: 1.2, ease: EASE }}
                style={{
                  height: '100%', borderRadius: 999,
                  background: tone === ACCENT_LIGHT ? `linear-gradient(90deg, ${ACCENT}, ${ACCENT_LIGHT})` : tone,
                }}
              />
            </div>
          </div>
        ))}
      </div>
      <p style={{ margin: '1.1rem 0 0', fontSize: '0.66rem', color: 'rgba(255,255,255,0.4)' }}>
        Recall on the CredData benchmark · token-efficiency is the primary signal, Shannon entropy the zero-dependency fallback.
      </p>
    </motion.div>
  )
}

// ── Principles grid ──────────────────────────────────────────────────────────────
function Principles() {
  return (
    <motion.div variants={stagger(0.1)} initial="hidden" whileInView="show" viewport={VIEWPORT}
      style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))' }}>
      {PRINCIPLES.map(({ icon: Icon, title, body, tone }) => (
        <motion.div key={title} variants={reveal} style={{
          padding: '1.3rem 1.25rem', borderRadius: 18,
          background: 'rgba(255,255,255,0.025)', border: `1px solid ${tone}2e`,
        }}>
          <div style={{
            width: 40, height: 40, borderRadius: 12, display: 'grid', placeItems: 'center', marginBottom: '0.9rem',
            background: `${tone}1c`, border: `1px solid ${tone}40`,
          }}>
            <Icon size={20} color={tone} />
          </div>
          <h4 style={{ margin: '0 0 0.4rem', fontSize: '1rem', fontWeight: 650, color: '#fff' }}>{title}</h4>
          <p style={{ margin: 0, fontSize: '0.78rem', lineHeight: 1.6, color: 'rgba(255,255,255,0.58)' }}>{body}</p>
        </motion.div>
      ))}
    </motion.div>
  )
}

// ── Section ──────────────────────────────────────────────────────────────────────
export function SecuritySection() {
  return (
    <section
      id="security"
      style={{
        position: 'relative', overflow: 'hidden',
        background: 'radial-gradient(120% 80% at 50% -10%, #1a0b30 0%, #0b0712 55%, #08070c 100%)',
        padding: 'clamp(5rem, 10vw, 9rem) clamp(1.25rem, 6vw, 5rem)',
      }}
    >
      {/* faint grid glow */}
      <div aria-hidden style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        background: `radial-gradient(60% 40% at 80% 110%, ${accent(0.16)}, transparent)`,
      }} />

      <div style={{ position: 'relative', maxWidth: 1120, margin: '0 auto' }}>
        {/* Header */}
        <motion.div variants={reveal} initial="hidden" whileInView="show" viewport={VIEWPORT}
          style={{ textAlign: 'center', marginBottom: 'clamp(2.6rem, 5vw, 4.2rem)' }}>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginBottom: '1.1rem', flexWrap: 'wrap' }}>
            <Pill color={SUCCESS}>Default ON</Pill>
            <Pill color={WARNING}>Fail-closed</Pill>
            <Pill color={ACCENT_LIGHT}>OWASP LLM02 · #2</Pill>
          </div>
          <span style={{ fontSize: '0.7rem', fontWeight: 800, letterSpacing: '0.22em', textTransform: 'uppercase', color: accentLight(0.85) }}>
            Security &amp; Compliance
          </span>
          <h2 style={{
            margin: '0.9rem 0 1rem', fontSize: 'clamp(2rem, 5vw, 4rem)', fontWeight: 600,
            color: '#fff', lineHeight: 1.07, letterSpacing: '-0.02em',
          }}>
            Your secrets never leave<br />your machine.
          </h2>
          <p style={{
            maxWidth: 680, margin: '0 auto', fontSize: 'clamp(0.92rem, 1.4vw, 1.08rem)',
            lineHeight: 1.7, color: 'rgba(255,255,255,0.62)',
          }}>
            Argus audits your app for <em style={{ color: '#fff', fontStyle: 'normal' }}>secrets and vulnerabilities</em> —
            so its findings are exactly the data you least want leaving your machine. <strong style={{ color: '#fff', fontWeight: 650 }}>Aegis</strong> is
            a data-loss-prevention layer that redacts every external boundary before a finding can cross it.
          </p>
        </motion.div>

        {/* Flow diagram */}
        <FlowDiagram />

        {/* Detection stack + recall chart */}
        <div style={{ marginTop: 'clamp(3rem, 6vw, 5rem)', display: 'grid', gap: 'clamp(1.6rem, 3vw, 2.4rem)', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))', alignItems: 'start' }}>
          <motion.div variants={reveal} initial="hidden" whileInView="show" viewport={VIEWPORT}>
            <h3 style={{ margin: '0 0 1.2rem', fontSize: 'clamp(1.2rem, 2.2vw, 1.6rem)', fontWeight: 600, color: '#fff', letterSpacing: '-0.01em' }}>
              Five layers, defense in depth.
            </h3>
            <LayerStack />
          </motion.div>
          <RecallChart />
        </div>

        {/* Principles */}
        <div style={{ marginTop: 'clamp(3rem, 6vw, 5rem)' }}>
          <motion.h3 variants={reveal} initial="hidden" whileInView="show" viewport={VIEWPORT}
            style={{ margin: '0 0 1.4rem', textAlign: 'center', fontSize: 'clamp(1.2rem, 2.2vw, 1.6rem)', fontWeight: 600, color: '#fff', letterSpacing: '-0.01em' }}>
            Built on a confidentiality contract.
          </motion.h3>
          <Principles />
        </div>

        {/* Closing opt-out note */}
        <motion.div variants={reveal} initial="hidden" whileInView="show" viewport={VIEWPORT}
          style={{
            marginTop: 'clamp(2.6rem, 5vw, 4rem)', textAlign: 'center',
            padding: 'clamp(1.4rem, 3vw, 2rem)', borderRadius: 20,
            background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.1)',
          }}>
          <p style={{ margin: 0, fontSize: '0.9rem', lineHeight: 1.7, color: 'rgba(255,255,255,0.7)' }}>
            It’s on by default, but never a black box. Set{' '}
            <code style={{ fontFamily: 'ui-monospace, monospace', color: SUCCESS, background: success(0.12), padding: '0.12rem 0.4rem', borderRadius: 6 }}>
              ARGUS_REDACT_SENSITIVE=0
            </code>{' '}
            for output byte-identical to before — and the local on-disk report always keeps 100% fidelity, opt-out or not.
          </p>
        </motion.div>
      </div>
    </section>
  )
}
