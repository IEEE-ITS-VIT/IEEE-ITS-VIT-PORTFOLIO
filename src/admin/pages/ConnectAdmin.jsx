/* Admin → Connect: review shared interview questions / topics week by week, approve, reject, edit or add by hand. */
import { useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { Drawer, PageTitle, Badge, Empty, Spinner, Switch, useToast, useConfirm, useLoader, fmtDate } from '../ui'
import Icon from '../icons'

const TONE = { pending: 'warn', approved: 'ok', rejected: 'neutral' }
const TABS = [['pending', 'Waiting for review'], ['approved', 'Published'], ['rejected', 'Rejected'], ['all', 'All']]
const blank = () => ({ kind: 'interview', title: '', answer: '', company: '', role: '', year: new Date().getFullYear(), round: '', difficulty: '', tags: '', links: [''], anonymous: false, author_name: '', status: 'approved', admin_note: '' })

/** Monday of the week a post was sent (posts are reviewed week by week). */
const weekOf = iso => {
    const d = new Date(String(iso).replace(' ', 'T') + (String(iso).endsWith('Z') ? '' : 'Z'))
    const day = (d.getDay() + 6) % 7
    d.setDate(d.getDate() - day); d.setHours(0, 0, 0, 0)
    return d
}

function Editor({ post, onClose, onSaved }) {
    const toast = useToast()
    const [f, setF] = useState(() => post?.id ? { ...post, tags: post.tags.join(', '), links: post.links.length ? post.links.map(l => l.url) : [''] } : blank())
    const [busy, setBusy] = useState(false)
    const set = patch => setF(x => ({ ...x, ...patch }))
    const save = async () => {
        setBusy(true)
        try {
            const body = { ...f, links: f.links.filter(Boolean) }
            const r = post?.id ? await api.put(`/admin/connect/${post.id}`, body) : await api.post('/admin/connect', body)
            toast(post?.id ? 'Saved' : 'Added'); onSaved(r.item); onClose()
        } catch (e) { toast(e.message, 'error') }
        setBusy(false)
    }
    return (
        <Drawer open title={post?.id ? 'Edit post' : 'Add a post'} onClose={onClose}
            footer={<>
                <select className="adm-input" value={f.status} onChange={e => set({ status: e.target.value })} style={{ maxWidth: 190 }}>
                    <option value="approved">Published</option><option value="pending">Waiting for review</option><option value="rejected">Rejected</option>
                </select>
                <button className="adm-btn ghost" onClick={onClose}>Cancel</button>
                <button className="adm-btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
            </>}>
            <div className="adm-form">
                {post?.user_email && <p className="adm-hint">Sent by <b>{post.user_name}</b> ({post.user_email}{post.reg_no ? ` · ${post.reg_no}` : ''}) on {fmtDate(post.created_at)}{post.anonymous ? ' — shown as Anonymous' : ''}.</p>}
                <div className="adm-seg">
                    <button type="button" className={f.kind === 'interview' ? 'on' : ''} onClick={() => set({ kind: 'interview' })}>Interview question</button>
                    <button type="button" className={f.kind === 'topic' ? 'on' : ''} onClick={() => set({ kind: 'topic' })}>Topic / resource</button>
                </div>
                <label className="adm-field"><span>Question / topic</span><textarea className="adm-input" rows={2} value={f.title} onChange={e => set({ title: e.target.value })} /></label>
                <label className="adm-field"><span>Answer / details</span><textarea className="adm-input" rows={8} value={f.answer} onChange={e => set({ answer: e.target.value })} /></label>
                <div className="adm-grid-2">
                    <label className="adm-field"><span>Company</span><input className="adm-input" value={f.company} onChange={e => set({ company: e.target.value })} /></label>
                    <label className="adm-field"><span>Role</span><input className="adm-input" value={f.role} onChange={e => set({ role: e.target.value })} /></label>
                    <label className="adm-field"><span>Year</span><input className="adm-input" type="number" value={f.year ?? ''} onChange={e => set({ year: e.target.value })} /></label>
                    <label className="adm-field"><span>Round</span><input className="adm-input" value={f.round} onChange={e => set({ round: e.target.value })} /></label>
                    <label className="adm-field"><span>Difficulty</span>
                        <select className="adm-input" value={f.difficulty} onChange={e => set({ difficulty: e.target.value })}><option value="">—</option><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select>
                    </label>
                    <label className="adm-field"><span>Tags (comma separated)</span><input className="adm-input" value={f.tags} onChange={e => set({ tags: e.target.value })} /></label>
                </div>
                <div className="adm-field"><span>Resource links (GitHub, YouTube, LinkedIn, LeetCode…)</span>
                    {f.links.map((l, i) => (
                        <div key={i} className="adm-row">
                            <input className="adm-input" value={l} onChange={e => set({ links: f.links.map((x, j) => (j === i ? e.target.value : x)) })} placeholder="https://…" />
                            <button type="button" className="adm-btn small ghost" onClick={() => set({ links: f.links.filter((_, j) => j !== i) })} aria-label="Remove"><Icon name="close" size={14} /></button>
                        </div>
                    ))}
                    {f.links.length < 6 && <button type="button" className="adm-btn small" style={{ alignSelf: 'flex-start' }} onClick={() => set({ links: [...f.links, ''] })}>Add link</button>}
                </div>
                {!post?.user_email && <label className="adm-field"><span>Credit (shown as "Shared by …")</span><input className="adm-input" value={f.author_name} onChange={e => set({ author_name: e.target.value })} placeholder="e.g. Placement cell, or a student's name" /></label>}
                <Switch checked={!!f.anonymous} onChange={v => set({ anonymous: v })} label="Show as Anonymous" />
                {f.status === 'rejected' && <label className="adm-field"><span>Note to the author (they see it under "Your posts")</span><input className="adm-input" value={f.admin_note || ''} onChange={e => set({ admin_note: e.target.value })} placeholder="e.g. Please add the company and the actual question" /></label>}
            </div>
        </Drawer>
    )
}

export default function ConnectAdmin() {
    const toast = useToast()
    const confirm = useConfirm()
    const { data, loading, setData, reload } = useLoader(() => api.get('/admin/connect'), [])
    const [tab, setTab] = useState('pending')
    const [q, setQ] = useState('')
    const [picked, setPicked] = useState([])
    const [editing, setEditing] = useState(null)
    const items = useMemo(() => data?.items || [], [data])
    const counts = Object.fromEntries(TABS.map(([k]) => [k, k === 'all' ? items.length : items.filter(p => p.status === k).length]))
    const shown = items.filter(p => (tab === 'all' || p.status === tab) && (!q || JSON.stringify(p).toLowerCase().includes(q.toLowerCase())))
    const weeks = useMemo(() => {
        const g = new Map()
        for (const p of shown) { const w = weekOf(p.created_at).toISOString(); (g.get(w) || g.set(w, []).get(w)).push(p) }
        return [...g]
    }, [shown])

    const replace = item => setData(d => ({ ...d, items: d.items.some(x => x.id === item.id) ? d.items.map(x => (x.id === item.id ? item : x)) : [item, ...d.items] }))
    const review = async (ids, status) => {
        let note = ''
        if (status === 'rejected' && ids.length === 1) note = window.prompt('Optional note to the author (why it was not published):', '') ?? ''
        try {
            const r = await api.post('/admin/connect/review', { ids, status, note })
            toast(`${r.changed} post${r.changed === 1 ? '' : 's'} ${status === 'approved' ? 'published' : 'rejected'}`)
            setPicked([]); reload()
        } catch (e) { toast(e.message, 'error') }
    }
    const remove = async p => {
        if (!await confirm(`Delete "${p.title.slice(0, 60)}" permanently?`)) return
        try { await api.del(`/admin/connect/${p.id}`); setData(d => ({ ...d, items: d.items.filter(x => x.id !== p.id) })); toast('Deleted') } catch (e) { toast(e.message, 'error') }
    }
    const togglePick = id => setPicked(x => (x.includes(id) ? x.filter(i => i !== id) : [...x, id]))

    return (
        <>
            <PageTitle title="Connect" subtitle="Interview questions and topics shared by members. Nothing is public until you publish it. New posts are grouped by the week they were sent; admins get a reminder email on Mondays when posts are waiting.">
                <input className="adm-input search" placeholder="Search…" value={q} onChange={e => setQ(e.target.value)} />
                <a className="adm-btn ghost" href="/connect" target="_blank" rel="noreferrer">View page <Icon name="external" size={14} /></a>
                <button className="adm-btn primary" onClick={() => setEditing({})}><Icon name="plus" size={16} /> Add a post</button>
            </PageTitle>
            <div className="adm-tabs">{TABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => { setTab(k); setPicked([]) }}>{l} ({counts[k]})</button>)}</div>
            {picked.length > 0 && (
                <div className="adm-row" style={{ marginBottom: 12 }}>
                    <b>{picked.length} selected</b>
                    <button className="adm-btn small primary" onClick={() => review(picked, 'approved')}><Icon name="check" size={14} /> Publish</button>
                    <button className="adm-btn small" onClick={() => review(picked, 'rejected')}>Reject</button>
                    <button className="adm-btn small ghost" onClick={() => setPicked([])}>Clear</button>
                </div>
            )}
            {loading ? <Spinner /> : shown.length === 0 ? <Empty icon="users">{tab === 'pending' ? 'Nothing waiting for review.' : 'No posts here yet.'}</Empty> : weeks.map(([w, posts]) => (
                <section key={w} className="adm-panel" style={{ marginBottom: 14 }}>
                    <div className="adm-row" style={{ justifyContent: 'space-between' }}>
                        <h3 style={{ margin: 0 }}>Week of {new Date(w).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })} · {posts.length}</h3>
                        {tab === 'pending' && <button className="adm-btn small" onClick={() => setPicked(x => [...new Set([...x, ...posts.map(p => p.id)])])}>Select this week</button>}
                    </div>
                    <div className="adm-list" style={{ marginTop: 10 }}>
                        {posts.map(p => (
                            <div key={p.id} className="adm-list-row" style={{ alignItems: 'flex-start' }}>
                                <input type="checkbox" checked={picked.includes(p.id)} onChange={() => togglePick(p.id)} aria-label="Select" style={{ marginTop: 4 }} />
                                <div className="adm-list-main" onClick={() => setEditing(p)}>
                                    <strong style={{ whiteSpace: 'normal' }}>{p.company ? `${p.company} — ` : ''}{p.title}</strong>
                                    <small>{[p.kind === 'interview' ? 'Interview' : 'Topic', p.role, p.year, p.round, p.difficulty, p.links.length ? `${p.links.length} link${p.links.length > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ')}</small>
                                    <small>{p.user_email ? `${p.user_name} · ${p.user_email}` : `Added by admin${p.author_name ? ` · credit: ${p.author_name}` : ''}`}{p.anonymous ? ' · shown as Anonymous' : ''} · {fmtDate(p.created_at)}</small>
                                    {p.answer && <small style={{ whiteSpace: 'normal', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{p.answer}</small>}
                                </div>
                                <Badge tone={TONE[p.status]}>{p.status === 'approved' ? 'published' : p.status}</Badge>
                                <div className="adm-row">
                                    {p.status !== 'approved' && <button className="adm-btn small primary" onClick={() => review([p.id], 'approved')}>Publish</button>}
                                    {p.status !== 'rejected' && <button className="adm-btn small ghost" onClick={() => review([p.id], 'rejected')}>{p.status === 'approved' ? 'Unpublish' : 'Reject'}</button>}
                                    <button className="adm-btn small" onClick={() => setEditing(p)}>Edit</button>
                                    <button className="adm-btn small ghost danger-text" onClick={() => remove(p)} aria-label="Delete"><Icon name="trash" size={14} /></button>
                                </div>
                            </div>
                        ))}
                    </div>
                </section>
            ))}
            {editing && <Editor post={editing.id ? editing : null} onClose={() => setEditing(null)} onSaved={replace} />}
        </>
    )
}
