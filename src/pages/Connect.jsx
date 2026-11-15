/*
 * /connect — interview questions and topics shared by students. Anyone can read approved posts;
 * signed-in members can share (a few per week) and every post waits for an admin's approval.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { api } from '../lib/api'
import PageHeader from '../components/PageHeader'
import Seo from '../components/Seo'
import Section from '../components/Section'
import LinkedText from '../components/LinkedText'

const LINK_LABEL = { github: 'GitHub', youtube: 'YouTube', linkedin: 'LinkedIn', leetcode: 'LeetCode', gfg: 'GeeksforGeeks', hackerrank: 'HackerRank', codeforces: 'Codeforces', article: 'Article', drive: 'Google Drive', link: 'Link' }
const host = u => { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return 'link' } }
const blank = () => ({ kind: 'interview', title: '', answer: '', company: '', role: '', year: String(new Date().getFullYear()), round: '', difficulty: '', tags: '', links: [''], anonymous: false })
const STATUS = { pending: 'Waiting for review', approved: 'Published', rejected: 'Not published' }

function PostCard({ p }) {
    const [open, setOpen] = useState(false)
    const long = (p.answer || '').length > 280
    return (
        <article className="cx-card boxed">
            <div className="cx-meta">
                <span className={`cx-kind ${p.kind}`}>{p.kind === 'interview' ? 'Interview' : 'Topic'}</span>
                {p.company && <b>{p.company}</b>}
                {p.role && <span>{p.role}</span>}
                {p.year && <span>{p.year}</span>}
                {p.round && <span>{p.round}</span>}
                {p.difficulty && <span className={`cx-diff ${p.difficulty}`}>{p.difficulty}</span>}
            </div>
            <h3 className="cx-title">{p.title}</h3>
            {p.answer && (
                <div className={`cx-answer${long && !open ? ' clamp' : ''}`}>
                    <LinkedText as="p" style={{ whiteSpace: 'pre-line', margin: 0, overflowWrap: 'anywhere' }} text={p.answer} />
                </div>
            )}
            {long && <button type="button" className="cx-more" onClick={() => setOpen(o => !o)}>{open ? 'Show less' : 'Show full answer'}</button>}
            {p.links.length > 0 && (
                <ul className="cx-links">
                    {p.links.map((l, i) => <li key={i}><a href={l.url} target="_blank" rel="noopener noreferrer nofollow" className={`cx-link ${l.type}`}>{LINK_LABEL[l.type] || 'Link'}<small>{host(l.url)}</small></a></li>)}
                </ul>
            )}
            <div className="cx-foot">
                {p.tags.length > 0 && <span className="cx-tags">{p.tags.map(t => <span key={t}>#{t}</span>)}</span>}
                <span className="muted">Shared by {p.author}</span>
            </div>
        </article>
    )
}

function ShareForm({ onSent, left }) {
    const [f, setF] = useState(blank)
    const [busy, setBusy] = useState(false)
    const [msg, setMsg] = useState(null)
    const set = patch => setF(x => ({ ...x, ...patch }))
    const submit = async e => {
        e.preventDefault()
        setBusy(true); setMsg(null)
        try {
            const r = await api.post('/connect', { ...f, links: f.links.filter(Boolean) })
            setF(blank()); onSent(r.left)
            setMsg({ ok: true, t: 'Thanks for sharing! Your post will appear here after the IEEE ITS VIT team reviews it (we review every week).' })
        } catch (err) { setMsg({ ok: false, t: err.message }) } finally { setBusy(false) }
    }
    const interview = f.kind === 'interview'
    return (
        <form className="form boxed cx-form" onSubmit={submit}>
            <div className="cx-seg" role="tablist">
                <button type="button" className={interview ? 'on' : ''} onClick={() => set({ kind: 'interview' })}>Interview question</button>
                <button type="button" className={!interview ? 'on' : ''} onClick={() => set({ kind: 'topic' })}>Topic / resource</button>
            </div>
            <label className="field"><span>{interview ? 'The question you were asked' : 'Topic'}</span>
                <input value={f.title} onChange={e => set({ title: e.target.value })} required minLength={8} maxLength={300} placeholder={interview ? 'e.g. Find the longest substring without repeating characters' : 'e.g. How to prepare for system design rounds'} />
            </label>
            <label className="field"><span>{interview ? 'Answer / your approach (optional)' : 'Details'}</span>
                <textarea value={f.answer} onChange={e => set({ answer: e.target.value })} maxLength={8000} rows={6} placeholder={interview ? 'How you answered it, hints, complexity, what the interviewer looked for…' : 'What to learn, in what order, tips…'} />
            </label>
            <div className="cx-grid">
                <label className="field"><span>Company{interview ? ' *' : ''}</span><input value={f.company} onChange={e => set({ company: e.target.value })} required={interview} maxLength={80} placeholder="e.g. Microsoft" /></label>
                <label className="field"><span>Role</span><input value={f.role} onChange={e => set({ role: e.target.value })} maxLength={80} placeholder="e.g. SDE intern" /></label>
                <label className="field"><span>Year</span><input type="number" min="2000" max={new Date().getFullYear() + 1} value={f.year} onChange={e => set({ year: e.target.value })} /></label>
                {interview && <label className="field"><span>Round</span><input value={f.round} onChange={e => set({ round: e.target.value })} maxLength={60} placeholder="Online test, Technical 1, HR…" /></label>}
                <label className="field"><span>Difficulty</span>
                    <select value={f.difficulty} onChange={e => set({ difficulty: e.target.value })}><option value="">—</option><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select>
                </label>
                <label className="field"><span>Tags</span><input value={f.tags} onChange={e => set({ tags: e.target.value })} placeholder="arrays, dp, os" /></label>
            </div>
            <div className="field"><span>Resources — GitHub, YouTube, LinkedIn, LeetCode, articles (optional)</span>
                {f.links.map((l, i) => (
                    <div key={i} className="cx-linkrow">
                        <input type="url" value={l} onChange={e => set({ links: f.links.map((x, j) => (j === i ? e.target.value : x)) })} placeholder="https://leetcode.com/problems/…" />
                        {f.links.length > 1 && <button type="button" className="btn sm" onClick={() => set({ links: f.links.filter((_, j) => j !== i) })} aria-label="Remove link">✕</button>}
                    </div>
                ))}
                {f.links.length < 6 && <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => set({ links: [...f.links, ''] })}>+ Add another link</button>}
            </div>
            <label className="cx-check"><input type="checkbox" checked={f.anonymous} onChange={e => set({ anonymous: e.target.checked })} /> Post anonymously (your name is hidden; the team can still see it)</label>
            <button className="btn solid" disabled={busy || left === 0}>{busy ? 'Sending…' : 'Submit for review'} <span className="arr">→</span></button>
            <p className="muted" style={{ margin: 0, fontSize: '.85rem' }}>{left === 0 ? 'You have used this week\'s posts — you can share more in a few days.' : `You can share ${left ?? 5} more this week. Posts appear once approved.`}</p>
            {msg && <p className={`notice ${msg.ok ? 'ok' : 'err'}`} role="status">{msg.t}</p>}
        </form>
    )
}

export default function Connect() {
    const { user, loading: authLoading } = useAuth()
    const [items, setItems] = useState(null)
    const [mine, setMine] = useState(null)
    const [error, setError] = useState('')
    const [q, setQ] = useState('')
    const [kind, setKind] = useState('all')
    const [company, setCompany] = useState('')
    const [year, setYear] = useState('')

    useEffect(() => { api.get('/connect').then(r => setItems(r.items)).catch(e => setError(e.message)) }, [])
    const loadMine = useCallback(() => { if (user) api.get('/connect/mine').then(setMine).catch(() => {}) }, [user])
    useEffect(() => { loadMine() }, [loadMine])

    const companies = useMemo(() => [...new Set((items || []).map(p => p.company).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [items])
    const years = useMemo(() => [...new Set((items || []).map(p => p.year).filter(Boolean))].sort((a, b) => b - a), [items])
    const shown = (items || []).filter(p => (kind === 'all' || p.kind === kind) && (!company || p.company === company) && (!year || String(p.year) === year)
        && (!q || `${p.title} ${p.answer} ${p.company} ${p.role} ${p.round} ${p.tags.join(' ')}`.toLowerCase().includes(q.toLowerCase())))
    const withdraw = async id => { try { await api.del(`/connect/mine/${id}`); loadMine() } catch { /* already reviewed */ } }

    return (
        <>
            <Seo />
            <PageHeader page="connect">
                <div className="hero-cta">
                    <button type="button" className="btn solid" onClick={() => document.getElementById('share')?.scrollIntoView({ behavior: 'smooth' })}>Share a question <span className="arr">→</span></button>
                </div>
            </PageHeader>
            <Section id="connect.list" className="section" style={{ borderTop: 0 }}>
                <div className="wrap cx-wrap">
                    <div className="cx-filters">
                        <input className="input" type="search" placeholder="Search questions, companies, tags…" value={q} onChange={e => setQ(e.target.value)} aria-label="Search" />
                        <select className="input" value={kind} onChange={e => setKind(e.target.value)} aria-label="Type"><option value="all">All posts</option><option value="interview">Interview questions</option><option value="topic">Topics & resources</option></select>
                        <select className="input" value={company} onChange={e => setCompany(e.target.value)} aria-label="Company"><option value="">All companies</option>{companies.map(c => <option key={c}>{c}</option>)}</select>
                        <select className="input" value={year} onChange={e => setYear(e.target.value)} aria-label="Year"><option value="">Any year</option>{years.map(y => <option key={y}>{y}</option>)}</select>
                    </div>
                    {error ? <p className="notice err">{error}</p> : items === null ? <p className="muted">Loading…</p> : shown.length === 0 ? (
                        <p className="empty">{items.length ? 'Nothing matches those filters.' : 'No posts yet — be the first to share an interview question.'}</p>
                    ) : (
                        <>
                            <p className="muted cx-count">{shown.length} post{shown.length === 1 ? '' : 's'}</p>
                            <div className="cx-list">{shown.map(p => <PostCard key={p.id} p={p} />)}</div>
                        </>
                    )}

                    <div id="share" className="cx-share">
                        <h2 className="display h-md">Share what you were asked</h2>
                        <p className="muted">Help juniors and friends prepare: the question, how you answered, the company and year, and links that helped. The team reviews new posts every week; only approved posts are shown.</p>
                        {authLoading ? null : !user ? (
                            <p className="notice">Sign in to share — it keeps the board free of spam. <Link to="/login?next=/connect" className="accent">Sign in →</Link> or <Link to="/login?mode=register&next=/connect" className="accent">create an account</Link>.</p>
                        ) : <ShareForm left={mine?.left} onSent={() => loadMine()} />}
                        {user && mine?.items?.length > 0 && (
                            <div className="cx-mine">
                                <h3 className="display h-sm">Your posts</h3>
                                <ul>
                                    {mine.items.map(p => (
                                        <li key={p.id}>
                                            <span className={`cx-status ${p.status}`}>{STATUS[p.status]}</span>
                                            <span className="cx-mine-title">{p.company ? `${p.company} — ` : ''}{p.title}</span>
                                            {p.status === 'rejected' && p.admin_note && <small className="muted">Note from the team: {p.admin_note}</small>}
                                            {p.status === 'pending' && <button type="button" className="cx-more" onClick={() => withdraw(p.id)}>Withdraw</button>}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </div>
                </div>
            </Section>
        </>
    )
}
