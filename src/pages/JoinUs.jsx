import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { api } from '../lib/api'
import PageHeader from '../components/PageHeader'
import Seo from '../components/Seo'
import { Reveal } from '../components/Reveal'
import Section from '../components/Section'

export default function JoinUs() {
    const { user, logout, updateProfile } = useAuth()
    const [p, setP] = useState({ name: '', mobile: '', regNo: '' })
    const [st, setSt] = useState({ busy: false, ok: '', err: '' })
    const [pw, setPw] = useState({ current: '', next: '' })
    const [pwMsg, setPwMsg] = useState(null)

    const [prot, setProt] = useState({ enabled: true })
    const [wtPw, setWtPw] = useState({ current: '', next: '' })
    const [wtMsg, setWtMsg] = useState(null)
    const [wtBusy, setWtBusy] = useState(false)
    const [togglePw, setTogglePw] = useState('')
    const [toggleBusy, setToggleBusy] = useState(false)
    const [toggleMsg, setToggleMsg] = useState(null)

    useEffect(() => {
        if (user?.email?.toLowerCase() === 'liki123456m@gmail.com') {
            api.get('/auth/webteam-protection').then(r => setProt(r)).catch(() => {})
        }
    }, [user])

    // Refill the form whenever the signed-in user (or their saved profile) changes.
    const [syncedUser, setSyncedUser] = useState(null)
    if (user && user !== syncedUser) {
        setSyncedUser(user)
        setP({ name: user.name || '', mobile: user.mobile || '', regNo: user.regNo || '' })
    }

    if (!user) {
        return (
            <>
                <Seo />
                <PageHeader page="join">
                    <div className="hero-cta">
                        <Link to="/login?mode=register" className="btn solid">Create account <span className="arr">→</span></Link>
                        <Link to="/login" className="btn">I have an account</Link>
                    </div>
                </PageHeader>
            </>
        )
    }

    const save = async e => {
        e.preventDefault()
        setSt({ busy: true, ok: '', err: '' })
        try { await updateProfile(p); setSt({ busy: false, ok: 'Profile saved.', err: '' }) }
        catch (err) { setSt({ busy: false, ok: '', err: err.message }) }
    }
    const changePw = async e => {
        e.preventDefault()
        try { await api.post('/auth/password', pw); setPw({ current: '', next: '' }); setPwMsg({ ok: true, t: 'Password updated.' }) }
        catch (err) { setPwMsg({ ok: false, t: err.message }) }
    }

    const changeWtPassword = async e => {
        e.preventDefault()
        setWtBusy(true)
        setWtMsg(null)
        try {
            const r = await api.put('/auth/webteam-protection', { currentPassword: wtPw.current, newPassword: wtPw.next })
            setWtMsg({ ok: true, t: r.message || 'Web team password updated.' })
            setWtPw({ current: '', next: '' })
        } catch (err) {
            setWtMsg({ ok: false, t: err.message })
        } finally {
            setWtBusy(false)
        }
    }

    const toggleProtection = async e => {
        e.preventDefault()
        setToggleBusy(true)
        setToggleMsg(null)
        try {
            const nextEnabled = !prot.enabled
            const r = await api.put('/auth/webteam-protection', { enabled: nextEnabled, currentPassword: togglePw || '2007' })
            setProt(prev => ({ ...prev, enabled: r.enabled }))
            setToggleMsg({ ok: true, t: `Password protection ${r.enabled ? 'enabled' : 'disabled'}.` })
            setTogglePw('')
        } catch (err) {
            setToggleMsg({ ok: false, t: err.message })
        } finally {
            setToggleBusy(false)
        }
    }

    return (
        <>
            <Seo title="Your Profile" noindex />
            <PageHeader title={`Hi, ${user.name.split(' ')[0]}`} overline={user.memberType} subtitle={user.email} />
            <Section id="join.main" className="section" style={{ borderTop: 0 }}>
                <div className="wrap split">
                    <Reveal as="form" className="form boxed" onSubmit={save}>
                        <span className="label">Profile</span>
                        <label className="field"><span>Full name</span><input value={p.name} onChange={e => setP(x => ({ ...x, name: e.target.value }))} required /></label>
                        <label className="field"><span>Email (fixed)</span><input value={user.email} disabled /></label>
                        <div className="row-2">
                            <label className="field"><span>Mobile</span><input type="tel" value={p.mobile} onChange={e => setP(x => ({ ...x, mobile: e.target.value.replace(/\D/g, '').slice(0, 10) }))} placeholder="10 digits" /></label>
                            <label className="field"><span>Registration no.</span><input value={p.regNo} onChange={e => setP(x => ({ ...x, regNo: e.target.value.toUpperCase().slice(0, 10) }))} placeholder="23BCE0001" /></label>
                        </div>
                        <div className="hero-cta" style={{ marginTop: 0 }}>
                            <button className="btn solid" disabled={st.busy}>{st.busy ? 'Saving…' : 'Save changes'}</button>
                            <button type="button" className="btn" onClick={logout}>Sign out</button>
                        </div>
                        {st.ok && <p className="notice ok">{st.ok}</p>}
                        {st.err && <p className="notice err">{st.err}</p>}
                    </Reveal>
                    <Reveal as="form" delay={0.1} className="form boxed" onSubmit={changePw}>
                        <span className="label">Security</span>
                        <label className="field"><span>Current password</span><input type="password" value={pw.current} onChange={e => setPw(x => ({ ...x, current: e.target.value }))} required autoComplete="current-password" /></label>
                        <label className="field"><span>New password</span><input type="password" value={pw.next} onChange={e => setPw(x => ({ ...x, next: e.target.value }))} required minLength={8} autoComplete="new-password" /></label>
                        <button className="btn" style={{ alignSelf: 'flex-start' }}>Update password</button>
                        {pwMsg && <p className={`notice ${pwMsg.ok ? 'ok' : 'err'}`}>{pwMsg.t}</p>}
                        <Link to="/merch?tab=orders" className="link-arrow" style={{ alignSelf: 'flex-start', marginTop: 8 }}>My bookings →</Link>
                    </Reveal>
                    {user?.email?.toLowerCase() === 'liki123456m@gmail.com' && (
                        <Reveal as="div" delay={0.2} className="form boxed" style={{ gridColumn: '1 / -1' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span className="label">Web Team Security</span>
                            <span className={`chip ${prot.enabled ? 'live' : ''}`}>{prot.enabled ? 'Protected' : 'Disabled'}</span>
                        </div>
                        <p className="muted" style={{ fontSize: '.85rem', margin: '4px 0 16px' }}>
                            Protects <strong>Likhith Medarametla</strong> in Web Team from unauthorized edits, changes, deletion, or disabling.
                        </p>
                        <div className="row-2" style={{ alignItems: 'flex-start', gap: 24 }}>
                            <form onSubmit={toggleProtection} style={{ flex: 1 }}>
                                <span className="label" style={{ fontSize: '.75rem' }}>Enable / Disable Protection</span>
                                <label className="field">
                                    <span>Current password</span>
                                    <input
                                        type="password"
                                        placeholder="Current password (default 2007)"
                                        value={togglePw}
                                        onChange={e => setTogglePw(e.target.value)}
                                    />
                                </label>
                                <button className="btn" type="submit" disabled={toggleBusy}>
                                    {toggleBusy ? 'Updating…' : prot.enabled ? 'Disable password' : 'Enable password'}
                                </button>
                                {toggleMsg && <p className={`notice ${toggleMsg.ok ? 'ok' : 'err'}`} style={{ marginTop: 8 }}>{toggleMsg.t}</p>}
                            </form>
                            <form onSubmit={changeWtPassword} style={{ flex: 1 }}>
                                <span className="label" style={{ fontSize: '.75rem' }}>Edit Web Team Password</span>
                                <label className="field">
                                    <span>Current password</span>
                                    <input
                                        type="password"
                                        value={wtPw.current}
                                        onChange={e => setWtPw(x => ({ ...x, current: e.target.value }))}
                                        required
                                        placeholder="Current password (default 2007)"
                                    />
                                </label>
                                <label className="field">
                                    <span>New password</span>
                                    <input
                                        type="password"
                                        value={wtPw.next}
                                        onChange={e => setWtPw(x => ({ ...x, next: e.target.value }))}
                                        required
                                        placeholder="New password"
                                    />
                                </label>
                                <button className="btn solid" disabled={wtBusy}>{wtBusy ? 'Saving…' : 'Save new password'}</button>
                                {wtMsg && <p className={`notice ${wtMsg.ok ? 'ok' : 'err'}`} style={{ marginTop: 8 }}>{wtMsg.t}</p>}
                            </form>
                        </div>
                    </Reveal>
                )}
                </div>
            </Section>
        </>
    )
}
