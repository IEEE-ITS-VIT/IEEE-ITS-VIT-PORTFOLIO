import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Reorder, useDragControls } from 'framer-motion'
import { api } from '../../lib/api'
import { useSite } from '../../context/SiteContext'
import { CONTENT_TYPES, slugify } from '../../../shared/cms.js'
import { FieldForm, thumb } from '../fields'
import { Drawer, Modal, PageTitle, Badge, Empty, Spinner, useToast, useConfirm, useLoader, Switch, queuedText } from '../ui'
import { PreviewFrame, withItem } from '../Preview'
import Icon from '../icons'

/* Where each kind of content appears on the website (the preview opens there). */
const PREVIEW_PATH = {
    faculty: '/faculty', advisory: '/advisory-board', web_team: '/web-team', blogs: d => (d.title ? `/blogs/${d.slug || slugify(d.title)}` : '/blogs'),
    magazines: '/blogs', projects: d => (d.title ? `/projects/${d.slug || slugify(d.title)}` : '/projects'), resources: d => (d.title ? `/resources/${d.slug || slugify(d.title)}` : '/projects?tab=resources'), vlogs: '/vlogs', faqs: '/faq', merch: '/merch',
}
/* The section of that page the preview scrolls to. */
const PREVIEW_FOCUS = {
    board: 'home.board', banners: 'home.banners', gallery: 'home.gallery', domains: 'home.domains', faculty: 'faculty.list', advisory: 'advisory.list',
    web_team: 'webteam.list', faqs: 'faq.list', merch: 'merch.list', vlogs: 'vlogs.list', footer_links: 'footer', social_links: 'footer',
}
const previewPath = (type, data) => { const p = PREVIEW_PATH[type]; return typeof p === 'function' ? p(data) : p || '/' }

/* Default wording for "new post / new issue" emails (editable before sending). */
const ANNOUNCE = {
    blogs: {
        subject: 'New on the IEEE ITS VIT blog: {{title}}',
        body: 'Hi {{name}},\n\nWe just published a new article on the IEEE ITS VIT blog:\n\n{{title}}\n{{summary}}\n\nRead it here ({{readTime}}):\n{{link}}\n\nIEEE ITS VIT',
    },
    magazines: {
        subject: 'The new {{title}} is out — check it out',
        body: 'Hi {{name}},\n\nThe latest edition of {{title}} {{edition}} is out.\n\n{{summary}}\n\nCheck it out here:\n{{link}}\n\nIEEE ITS VIT',
    },
}

/** Email a blog post / magazine issue to all users, newsletter subscribers and/or typed-in addresses. */
function AnnounceModal({ type, item, onClose }) {
    const toast = useToast()
    const navigate = useNavigate()
    const [aud, setAud] = useState({ users: true, subscribers: true })
    const [custom, setCustom] = useState('')
    const [subject, setSubject] = useState(ANNOUNCE[type].subject)
    const [body, setBody] = useState(ANNOUNCE[type].body)
    const [counts, setCounts] = useState(null)
    const [busy, setBusy] = useState(false)
    useEffect(() => { api.get('/admin/announce/audience').then(setCounts).catch(() => {}) }, [])
    const typed = custom.split(/[\s,;]+/).filter(Boolean)
    const badTyped = typed.filter(e => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
    const upTo = (aud.users ? counts?.users || 0 : 0) + (aud.subscribers ? counts?.subscribers || 0 : 0) + typed.length
    const send = async () => {
        setBusy(true)
        try {
            const r = await api.post('/admin/announce', { type, id: item.id, audiences: Object.keys(aud).filter(k => aud[k]), custom, subject, body })
            toast(queuedText(r.queued)); navigate('/admin/outbox')
        } catch (e) { toast(e.message, 'error') }
        setBusy(false)
    }
    const fill = t => t.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => ({ name: 'Aditi', title: item.title || '', summary: item.desc || '', edition: item.edition || '', readTime: item.readTime || '2 min read', link: '(link to the ' + (type === 'blogs' ? 'article' : 'magazine') + ')' }[k] ?? ''))
    return (
        <Modal open onClose={onClose} title={`Email “${item.title || 'this'}” to readers`} wide>
            <div className="adm-form">
                {item._status !== 'published' && <p className="adm-hint warn">This item is a draft — publish it first, otherwise the link in the email will not open.</p>}
                <div className="adm-field"><span>Send to</span>
                    <div className="adm-row wrap">
                        <label className="adm-chipcheck"><input type="checkbox" checked={aud.users} onChange={e => setAud(a => ({ ...a, users: e.target.checked }))} />All registered users{counts ? ` (${counts.users})` : ''}</label>
                        <label className="adm-chipcheck"><input type="checkbox" checked={aud.subscribers} onChange={e => setAud(a => ({ ...a, subscribers: e.target.checked }))} />Newsletter subscribers{counts ? ` (${counts.subscribers})` : ''}</label>
                    </div>
                </div>
                <label className="adm-field"><span>Custom emails — separated by spaces, commas or new lines ({typed.length})</span>
                    <textarea className="adm-input mono" rows={3} value={custom} onChange={e => setCustom(e.target.value)} placeholder="friend@vitstudent.ac.in faculty@vit.ac.in" />
                    {badTyped.length > 0 && <small className="adm-err">Not valid: {badTyped.slice(0, 5).join(', ')}</small>}
                </label>
                <label className="adm-field"><span>Subject</span><input className="adm-input" value={subject} onChange={e => setSubject(e.target.value)} /></label>
                <label className="adm-field"><span>Message</span><textarea className="adm-input" rows={9} value={body} onChange={e => setBody(e.target.value)} /></label>
                <p className="adm-hint" style={{ margin: 0 }}>Placeholders: {'{{name}} {{title}} {{summary}} {{edition}} {{readTime}} {{link}}'}. {type === 'magazines' ? '{{link}} opens the PDF in the website\'s viewer.' : '{{link}} opens the article.'} Everyone gets their own email; people in more than one list get it once. Large lists go out within the daily email limit.</p>
                <details><summary className="adm-hint" style={{ cursor: 'pointer' }}>Preview</summary>
                    <div className="adm-panel" style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}><b>{fill(subject)}</b>{'\n\n'}{fill(body)}</div>
                </details>
                <div className="adm-row end">
                    <button type="button" className="adm-btn ghost" onClick={onClose}>Cancel</button>
                    <button type="button" className="adm-btn primary" disabled={busy || !upTo || badTyped.length > 0 || !subject.trim()} onClick={send}><Icon name="send" size={16} /> Queue {upTo ? `up to ${upTo}` : ''} emails</button>
                </div>
            </div>
        </Modal>
    )
}

const toLocalInput = v => (v ? String(v).replace(' ', 'T').slice(0, 16) : '')

function blank(def) {
    const d = {}
    for (const f of def.fields) {
        if (f.type === 'toggle') d[f.name] = false
        else if (['images', 'strings', 'colors', 'rows'].includes(f.type)) d[f.name] = []
        else if (f.type === 'select') d[f.name] = f.options[0]
    }
    return d
}

function strip(item) {
    // eslint-disable-next-line no-unused-vars
    const { id, _status, _sort, _starts_at, _ends_at, _updated_at, ...data } = item
    return data
}

function Row({ item, def, onEdit, onToggle, onDuplicate, onDelete, onEmail }) {
    const controls = useDragControls()
    const now = new Date().toISOString().slice(0, 16)
    const scheduled = (item._starts_at && toLocalInput(item._starts_at) > now) ? 'Scheduled' : (item._ends_at && toLocalInput(item._ends_at) < now) ? 'Expired' : null
    const image = def.image ? item[def.image] : null
    return (
        <Reorder.Item value={item} dragListener={false} dragControls={controls} className="adm-list-row" whileDrag={{ scale: 1.02, boxShadow: '0 12px 30px rgba(0,0,0,.15)' }}>
            <button className="adm-drag" onPointerDown={e => controls.start(e)} aria-label="Drag to reorder"><Icon name="drag" size={18} /></button>
            {def.image && <div className="adm-thumb">{image ? <img src={thumb(image)} alt="" /> : <span>—</span>}</div>}
            <div className="adm-list-main" onClick={onEdit}>
                <strong>{item[def.title] || <em>Untitled</em>}</strong>
                <small>{def.fields.filter(f => f.name !== def.title && ['text', 'url'].includes(f.type)).slice(0, 2).map(f => item[f.name]).filter(Boolean).join(' · ')}</small>
            </div>
            {scheduled && <Badge tone="warn">{scheduled}</Badge>}
            <Switch checked={item._status === 'published'} onChange={onToggle} label={item._status === 'published' ? 'Live' : 'Draft'} />
            <div className="adm-row">
                <button className="adm-btn small" onClick={onEdit}>Edit</button>
                {onEmail && <button className="adm-btn small ghost" onClick={onEmail} title="Email this to users"><Icon name="send" size={14} /> Email</button>}
                <button className="adm-btn small ghost" onClick={onDuplicate} title="Duplicate" aria-label="Duplicate"><Icon name="copy" size={16} /></button>
                <button className="adm-btn small ghost danger-text" onClick={onDelete} title="Delete" aria-label="Delete"><Icon name="trash" size={16} /></button>
            </div>
        </Reorder.Item>
    )
}

export default function ContentManager({ type }) {
    const def = CONTENT_TYPES[type]
    const { refresh, content: live } = useSite()
    const toast = useToast()
    const confirm = useConfirm()
    const { data, loading, error, reload, setData } = useLoader(() => api.get(`/admin/content/${type}`).then(r => r.items), [type])
    const [items, setItems] = useState([])
    const [editing, setEditing] = useState(null) // { id?, data, status, starts_at, ends_at }
    const [announcing, setAnnouncing] = useState(null)
    const [saving, setSaving] = useState(false)
    const [q, setQ] = useState('')

    useEffect(() => { setItems(data || []) }, [data])

    const afterChange = () => { refresh(true) }

    const save = async () => {
        setSaving(true)
        try {
            const body = { data: editing.data, status: editing.status, starts_at: editing.starts_at || null, ends_at: editing.ends_at || null }
            const { item } = editing.id ? await api.put(`/admin/content/${type}/${editing.id}`, body) : await api.post(`/admin/content/${type}`, body)
            setData(list => (editing.id ? list.map(x => (x.id === item.id ? item : x)) : [...list, item]))
            toast(`${def.singular} ${editing.id ? 'updated' : 'created'}`)
            setEditing(null)
            afterChange()
        } catch (e) { toast(e.message, 'error') }
        finally { setSaving(false) }
    }

    const toggle = async (item, on) => {
        try {
            const { item: updated } = await api.put(`/admin/content/${type}/${item.id}`, { data: strip(item), status: on ? 'published' : 'draft', starts_at: item._starts_at, ends_at: item._ends_at })
            setData(list => list.map(x => (x.id === item.id ? updated : x)))
            toast(on ? 'Published' : 'Moved to drafts')
            afterChange()
        } catch (e) { toast(e.message, 'error') }
    }

    const duplicate = async item => {
        try {
            const d = strip(item)
            if (d.slug) d.slug = `${d.slug}-copy`
            const { item: created } = await api.post(`/admin/content/${type}`, { data: { ...d, [def.title]: `${d[def.title] || ''} (copy)` }, status: 'draft' })
            setData(list => [...list, created])
            toast('Duplicated as draft')
        } catch (e) { toast(e.message, 'error') }
    }

    const remove = async item => {
        if (!await confirm(`Delete “${item[def.title] || def.singular}”? This cannot be undone. Its images are also deleted from ImageKit unless used elsewhere.`)) return
        try {
            await api.del(`/admin/content/${type}/${item.id}`)
            setData(list => list.filter(x => x.id !== item.id))
            toast('Deleted')
            afterChange()
        } catch (e) { toast(e.message, 'error') }
    }

    const persistOrder = async () => {
        try {
            await api.post(`/admin/content/${type}/reorder`, { ids: items.map(i => i.id) })
            setData(items)
            afterChange()
        } catch (e) { toast(e.message, 'error'); reload() }
    }

    // The item being edited replaces (or joins) the live list in the preview — drafts included.
    const patch = useMemo(() => {
        if (!editing) return null
        const item = { ...editing.data, id: editing.id ?? -1 }
        return { content: { [type]: withItem(live[type], item) }, ...(type === 'popups' ? { popup: item } : {}) }
    }, [editing, live, type])
    const [path, setPath] = useState('/')
    const editingTitle = editing?.data?.[def.title]
    useEffect(() => { if (editing) setPath(previewPath(type, editing.data || {})) }, [type, !!editing, editingTitle]) // eslint-disable-line react-hooks/exhaustive-deps

    const filtered = q ? items.filter(i => JSON.stringify(i).toLowerCase().includes(q.toLowerCase())) : items

    return (
        <>
            <PageTitle title={def.label} subtitle={def.help}>
                <input className="adm-input search" placeholder="Search…" value={q} onChange={e => setQ(e.target.value)} />
                <button className="adm-btn primary" onClick={() => setEditing({ data: blank(def), status: 'published' })}><Icon name="plus" size={16} /> Add {def.singular}</button>
            </PageTitle>
            {loading ? <Spinner /> : error ? <p className="adm-hint warn">{error}</p> : filtered.length === 0 ? (
                <Empty>No {def.label.toLowerCase()} yet.</Empty>
            ) : (
                <Reorder.Group axis="y" values={items} onReorder={q ? () => {} : setItems} className="adm-list" onPointerUp={() => !q && JSON.stringify(items.map(i => i.id)) !== JSON.stringify((data || []).map(i => i.id)) && persistOrder()}>
                    {filtered.map(item => (
                        <Row key={item.id} item={item} def={def}
                            onEdit={() => setEditing({ id: item.id, data: strip(item), status: item._status, starts_at: toLocalInput(item._starts_at), ends_at: toLocalInput(item._ends_at) })}
                            onToggle={on => toggle(item, on)} onDuplicate={() => duplicate(item)} onDelete={() => remove(item)}
                            onEmail={ANNOUNCE[type] ? () => setAnnouncing(item) : undefined} />
                    ))}
                </Reorder.Group>
            )}
            <p className="adm-hint">Drag the handle to reorder — the website follows this order.{ANNOUNCE[type] ? ' Use Email to tell users and newsletter subscribers about a new ' + (type === 'blogs' ? 'post.' : 'issue.') : ''}</p>
            {announcing && <AnnounceModal type={type} item={announcing} onClose={() => setAnnouncing(null)} />}

            <Drawer open={!!editing} title={`${editing?.id ? 'Edit' : 'New'} ${def.singular}`} onClose={() => setEditing(null)}
                preview={editing && <PreviewFrame path={path} patch={patch} focus={PREVIEW_FOCUS[type]} />}
                footer={<>
                    <select className="adm-input" value={editing?.status || 'published'} onChange={e => setEditing(s => ({ ...s, status: e.target.value }))} style={{ maxWidth: 160 }}>
                        <option value="published">Published</option><option value="draft">Draft</option>
                    </select>
                    <button className="adm-btn ghost" onClick={() => setEditing(null)}>Cancel</button>
                    <button className="adm-btn primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
                </>}>
                {editing && <>
                    <FieldForm fields={def.fields} value={editing.data} onChange={d => setEditing(s => ({ ...s, data: d }))} />
                    <fieldset className="adm-fieldset">
                        <legend>Schedule (optional)</legend>
                        <div className="adm-grid-2">
                            <label className="adm-field"><span>Show from</span><input type="datetime-local" className="adm-input" value={editing.starts_at || ''} onChange={e => setEditing(s => ({ ...s, starts_at: e.target.value }))} /></label>
                            <label className="adm-field"><span>Hide after</span><input type="datetime-local" className="adm-input" value={editing.ends_at || ''} onChange={e => setEditing(s => ({ ...s, ends_at: e.target.value }))} /></label>
                        </div>
                        <div className="adm-hint">Times are in UTC. Leave empty to show whenever the item is published.</div>
                    </fieldset>
                </>}
            </Drawer>
        </>
    )
}
