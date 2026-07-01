import { useState, useEffect } from 'react'
import { X } from 'lucide-react'
import { supabase } from './supabase'
import './AuthModal.css'

// Brand marks (lucide v1 dropped brand icons) — inline SVGs.
function GithubMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.73.5.5 5.74.5 12.02c0 5.1 3.29 9.42 7.86 10.95.58.11.79-.25.79-.56 0-.27-.01-1.16-.02-2.1-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14 0 1.55-.01 2.8-.01 3.18 0 .31.21.68.8.56A11.53 11.53 0 0 0 23.5 12.02C23.5 5.74 18.27.5 12 .5z" />
    </svg>
  )
}
function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  )
}

/**
 * Animated sign-in / sign-up modal (double-slider). Wired to Supabase Auth (email+password
 * + optional OAuth). On success it calls onAuthed(user); the caller decides where to go next
 * (e.g. proceed to Stripe checkout with the account id attached).
 */
export function AuthModal({ open, initialMode = 'signin', intent, onClose, onAuthed }) {
  const [active, setActive] = useState(initialMode === 'signup') // active = sign-up panel forward
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [name, setName] = useState('')
  const [suEmail, setSuEmail] = useState('')
  const [suPass, setSuPass] = useState('')
  const [siEmail, setSiEmail] = useState('')
  const [siPass, setSiPass] = useState('')

  useEffect(() => {
    if (!open) return
    setActive(initialMode === 'signup'); setError(''); setNotice('')
  }, [open, initialMode])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
  }, [open, onClose])

  if (!open) return null

  const guard = () => {
    if (!supabase) { setError('Auth is not configured yet (missing Supabase keys).'); return false }
    return true
  }

  const doSignin = async (e) => {
    e.preventDefault(); setNotice('')
    if (!guard()) return
    setLoading(true); setError('')
    const { data, error } = await supabase.auth.signInWithPassword({ email: siEmail.trim(), password: siPass })
    setLoading(false)
    if (error) { setError(error.message); return }
    if (data?.session?.user) onAuthed(data.session.user)
  }

  const doSignup = async (e) => {
    e.preventDefault(); setNotice('')
    if (!guard()) return
    setLoading(true); setError('')
    const { data, error } = await supabase.auth.signUp({
      email: suEmail.trim(), password: suPass, options: { data: { name } },
    })
    setLoading(false)
    if (error) { setError(error.message); return }
    if (data?.session?.user) { onAuthed(data.session.user); return }   // confirmations off → instant
    setNotice('Check your email to confirm your account, then sign in to continue.')
  }

  const oauth = async (provider) => {
    if (!guard()) return
    const { error } = await supabase.auth.signInWithOAuth({
      provider, options: { redirectTo: window.location.origin + window.location.pathname },
    })
    if (error) setError(error.message + ' — enable this provider in Supabase Auth.')
  }

  return (
    <div className="aa-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className={'aa-card' + (active ? ' aa-active' : '')} role="dialog" aria-modal="true" aria-label="Sign in or create an account">
        <button className="aa-close" aria-label="Close" onClick={onClose}><X size={18} /></button>

        {/* Sign up */}
        <div className="aa-form-container aa-signup">
          <form onSubmit={doSignup}>
            <h2>Create account</h2>
            {intent && <div className="aa-intent">for {intent}</div>}
            <div className="aa-socials">
              <button type="button" onClick={() => oauth('github')} aria-label="Continue with GitHub"><GithubMark /></button>
              <button type="button" onClick={() => oauth('google')} aria-label="Continue with Google"><GoogleMark /></button>
            </div>
            <div className="aa-hint">or use your email</div>
            <div className="aa-group"><input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="aa-group"><input type="email" placeholder="Email" required value={suEmail} onChange={(e) => setSuEmail(e.target.value)} /></div>
            <div className="aa-group"><input type="password" placeholder="Password (min 6)" required minLength={6} value={suPass} onChange={(e) => setSuPass(e.target.value)} /></div>
            {active && error && <p className="aa-error">{error}</p>}
            {active && notice && <p className="aa-notice">{notice}</p>}
            <button className="aa-submit" disabled={loading}>{loading ? 'Please wait…' : 'Sign up'}</button>
            <p className="aa-mobile-toggle">Have an account? <button type="button" onClick={() => setActive(false)}>Sign in</button></p>
          </form>
        </div>

        {/* Sign in */}
        <div className="aa-form-container aa-signin">
          <form onSubmit={doSignin}>
            <h2>Sign in</h2>
            {intent && <div className="aa-intent">to continue to {intent}</div>}
            <div className="aa-socials">
              <button type="button" onClick={() => oauth('github')} aria-label="Continue with GitHub"><GithubMark /></button>
              <button type="button" onClick={() => oauth('google')} aria-label="Continue with Google"><GoogleMark /></button>
            </div>
            <div className="aa-hint">or use your account</div>
            <div className="aa-group"><input type="email" placeholder="Email" required value={siEmail} onChange={(e) => setSiEmail(e.target.value)} /></div>
            <div className="aa-group"><input type="password" placeholder="Password" required value={siPass} onChange={(e) => setSiPass(e.target.value)} /></div>
            {!active && error && <p className="aa-error">{error}</p>}
            {!active && notice && <p className="aa-notice">{notice}</p>}
            <button className="aa-submit" disabled={loading}>{loading ? 'Please wait…' : 'Sign in'}</button>
            <p className="aa-mobile-toggle">New here? <button type="button" onClick={() => setActive(true)}>Create account</button></p>
          </form>
        </div>

        {/* Sliding gradient overlay */}
        <div className="aa-overlay-container">
          <div className="aa-overlay-wrapper">
            <div className="aa-panel aa-panel-left">
              <h2>Welcome back</h2>
              <p>Sign in to pick up where you left off.</p>
              <button className="aa-ghost" onClick={() => setActive(false)}>Sign in</button>
            </div>
            <div className="aa-panel aa-panel-right">
              <h2>Hello 👋</h2>
              <p>{intent ? `Create your account to start ${intent}.` : 'Create an account to get started with Argus.'}</p>
              <button className="aa-ghost" onClick={() => setActive(true)}>Sign up</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
