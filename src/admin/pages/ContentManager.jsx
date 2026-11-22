import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Reorder, useDragControls } from 'framer-motion'
import { api } from '../../lib/api'
import { useSite } from '../../context/SiteContext'
import { CONTENT_TYPES, slugify } from '../../../shared/cms.js'
import { FieldForm, thumb } from '../fields'
import { Drawer, PageTitle, Badge, Empty, Spinner, useToast, useConfirm, useLoader, Switch, Modal } from '../ui'
import { ANNOUNCE, AnnounceModal } from '../Announce'
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

function Row({ item, def, onEdit, onToggle, onDuplicate, onDelete, onEmail, onMoveToAdvisory }) {
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
                {onMoveToAdvisory && (
                    <button className="adm-btn small ghost" onClick={onMoveToAdvisory} title="Make as Advisory Board">
                        <Icon name="award" size={14} /> Advisory
                    </button>
                )}
                {onEmail && <button className="adm-btn small ghost" onClick={onEmail} title="Email this to users"><Icon name="send" size={14} /> Email</button>}
                <button className="adm-btn small ghost" onClick={onDuplicate} title="Duplicate" aria-label="Duplicate"><Icon name="copy" size={16} /></button>
                <button className="adm-btn small ghost danger-text" onClick={onDelete} title="Delete" aria-label="Delete"><Icon name="trash" size={16} /></button>
            </div>
        </Reorder.Item>
    )
}

export default function ContentManager({ type }) {
    const def = CONTENT_TYPES[type]
    const { refresh, content: live, settings: liveSettings } = useSite()
    const toast = useToast()
    const confirm = useConfirm()
    const { data, loading, error, reload, setData } = useLoader(() => api.get(`/admin/content/${type}`).then(r => r.items), [type])
    const [items, setItems] = useState([])
    const [editing, setEditing] = useState(null) // { id?, data, status, starts_at, ends_at, _password? }
    const [announcing, setAnnouncing] = useState(null)
    const [saving, setSaving] = useState(false)
    const [q, setQ] = useState('')

    const [advisoryModal, setAdvisoryModal] = useState(null) // { all: boolean, item?: object }
    const [advisoryYear, setAdvisoryYear] = useState('')
    const [advisoryKeepCopy, setAdvisoryKeepCopy] = useState(false)
    const [advisoryBusy, setAdvisoryBusy] = useState(false)
    const [advisoryErr, setAdvisoryErr] = useState('')

    const currentYr = new Date().getFullYear()
    const suggestedYears = useMemo(() => [
        `${currentYr - 1}-${currentYr}`,
        `${currentYr}-${currentYr + 1}`,
        `${currentYr - 2}-${currentYr - 1}`,
    ], [currentYr])

    const openAdvisoryModal = ({ all = false, item = null }) => {
        setAdvisoryErr('')
        setAdvisoryKeepCopy(false)
        setAdvisoryYear(suggestedYears[0])
        setAdvisoryModal({ all, item })
    }

    const handleMoveToAdvisory = async e => {
        e.preventDefault()
        const yr = advisoryYear.trim()
        if (!yr) return setAdvisoryErr('Please enter the board year (e.g. 2024-2025).')
        setAdvisoryBusy(true)
        setAdvisoryErr('')
        try {
            if (advisoryModal.all) {
                const res = await api.post('/admin/board/move-to-advisory', { all: true, year: yr, keepCopy: advisoryKeepCopy })
                if (!advisoryKeepCopy) {
                    setData([])
                    setEditing(null)
                }
                toast(res.message || `Moved all board members to Advisory Board (${yr}).`)
            } else {
                const res = await api.post('/admin/board/move-to-advisory', { id: advisoryModal.item.id, year: yr, keepCopy: advisoryKeepCopy })
                if (!advisoryKeepCopy) {
                    setData(list => list.filter(x => x.id !== advisoryModal.item.id))
                    if (editing?.id === advisoryModal.item.id) setEditing(null)
                }
                toast(res.message || `Moved "${advisoryModal.item.name}" to Advisory Board (${yr}).`)
            }
            setAdvisoryModal(null)
            afterChange()
        } catch (err) {
            setAdvisoryErr(err.message || 'Failed to move to Advisory Board.')
        } finally {
            setAdvisoryBusy(false)
        }
    }

    const isProtected = target => type === 'web_team' && /likhith/i.test(typeof target === 'string' ? target : JSON.stringify(target || ''))
    const [pwPrompt, setPwPrompt] = useState(null)
    const [passwordInput, setPasswordInput] = useState('')
    const [pwBusy, setPwBusy] = useState(false)
    const [pwError, setPwError] = useState('')

    const promptPassword = (message, onSubmit) => {
        setPasswordInput('')
        setPwError('')
        setPwPrompt({ message, onSubmit })
    }

    const handlePwSubmit = async e => {
        e.preventDefault()
        if (!passwordInput) return setPwError('Password is required.')
        setPwBusy(true)
        setPwError('')
        try {
            await api.post('/auth/webteam-protection/verify', { password: passwordInput })
            const verifiedPw = passwordInput
            const callback = pwPrompt?.onSubmit
            setPwPrompt(null)
            if (callback) await callback(verifiedPw)
        } catch (err) {
            setPwError(err.message || 'Incorrect password.')
        } finally {
            setPwBusy(false)
        }
    }

    useEffect(() => { setItems(data || []) }, [data])

    const afterChange = () => { refresh(true) }

    const doSave = async suppliedPw => {
        setSaving(true)
        try {
            const pw = suppliedPw || editing._password
            const headers = pw ? { 'x-admin-password': pw } : {}
            const body = { data: editing.data, status: editing.status, starts_at: editing.starts_at || null, ends_at: editing.ends_at || null, admin_password: pw }
            const { item } = editing.id ? await api.put(`/admin/content/${type}/${editing.id}`, body, { headers }) : await api.post(`/admin/content/${type}`, body, { headers })
            setData(list => (editing.id ? list.map(x => (x.id === item.id ? item : x)) : [...list, item]))
            toast(`${def.singular} ${editing.id ? 'updated' : 'created'}`)
            setEditing(null)
            afterChange()
        } catch (e) { toast(e.message, 'error') }
        finally { setSaving(false) }
    }

    const save = async () => {
        const needsPw = isProtected(editing?.data) || isProtected(editing)
        if (needsPw && !editing?._password) {
            promptPassword('Enter password to save changes for Likhith Medarametla in Web Team.', async verifiedPw => {
                setEditing(s => ({ ...s, _password: verifiedPw }))
                await doSave(verifiedPw)
            })
            return
        }
        await doSave(editing?._password)
    }

    const toggle = async (item, on, password) => {
        try {
            const pw = password || item._password
            const headers = pw ? { 'x-admin-password': pw } : {}
            const { item: updated } = await api.put(`/admin/content/${type}/${item.id}`, { data: strip(item), status: on ? 'published' : 'draft', starts_at: item._starts_at, ends_at: item._ends_at, admin_password: pw }, { headers })
            setData(list => list.map(x => (x.id === item.id ? updated : x)))
            toast(on ? 'Published' : 'Moved to drafts')
            afterChange()
        } catch (e) { toast(e.message, 'error'); throw e }
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

    const remove = async (item, password) => {
        if (!await confirm(`Delete “${item[def.title] || def.singular}”? This cannot be undone. Its images are also deleted from ImageKit unless used elsewhere.`)) return
        try {
            const pw = password || item._password
            const headers = pw ? { 'x-admin-password': pw } : {}
            await api.del(`/admin/content/${type}/${item.id}`, { admin_password: pw }, { headers })
            setData(list => list.filter(x => x.id !== item.id))
            toast('Deleted')
            afterChange()
        } catch (e) { toast(e.message, 'error'); throw e }
    }

    const handleEdit = item => {
        if (isProtected(item)) {
            promptPassword('Enter password to edit Likhith Medarametla in Web Team.', async verifiedPw => {
                setEditing({ id: item.id, data: strip(item), status: item._status, starts_at: toLocalInput(item._starts_at), ends_at: toLocalInput(item._ends_at), _password: verifiedPw })
            })
        } else {
            setEditing({ id: item.id, data: strip(item), status: item._status, starts_at: toLocalInput(item._starts_at), ends_at: toLocalInput(item._ends_at) })
        }
    }

    const handleToggle = (item, on) => {
        if (isProtected(item)) {
            promptPassword(`Enter password to ${on ? 'publish' : 'disable (move to draft)'} Likhith Medarametla in Web Team.`, async verifiedPw => {
                await toggle(item, on, verifiedPw)
            })
        } else {
            toggle(item, on)
        }
    }

    const handleRemove = item => {
        if (isProtected(item)) {
            promptPassword('Enter password to delete Likhith Medarametla from Web Team.', async verifiedPw => {
                await remove(item, verifiedPw)
            })
        } else {
            remove(item)
        }
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
                {type === 'board' && (
                    <button
                        className="adm-btn ghost"
                        onClick={() => openAdvisoryModal({ all: true })}
                        disabled={items.length === 0}
                        title="Make all current board as Advisory Board and keep current blank"
                    >
                        <Icon name="award" size={16} /> Make all Advisory Board
                    </button>
                )}
                <button className="adm-btn primary" onClick={() => setEditing({ data: blank(def), status: 'published' })}><Icon name="plus" size={16} /> Add {def.singular}</button>
            </PageTitle>
            {type === 'board' && (
                <p className="adm-hint" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
                    <Icon name="award" size={14} /> <span><strong>Tenure Transition:</strong> Use <strong>"Advisory"</strong> on a member or <strong>"Make all Advisory Board"</strong> above to graduate board members to the Advisory Board under a specific year and clear the current board.</span>
                </p>
            )}
            {type === 'magazines' && liveSettings?.blogs?.magazineEnabled === false && (
                <p className="adm-hint warn">The Magazines section is switched off, so these magazines are not shown on the website. <Link to="/admin/s/blogs">Turn it on in Blogs Page settings</Link>.</p>
            )}

            {loading ? <Spinner /> : error ? <p className="adm-hint warn">{error}</p> : filtered.length === 0 ? (
                <Empty>No {def.label.toLowerCase()} yet.</Empty>
            ) : (
                <Reorder.Group axis="y" values={items} onReorder={q ? () => {} : setItems} className="adm-list" onPointerUp={() => !q && JSON.stringify(items.map(i => i.id)) !== JSON.stringify((data || []).map(i => i.id)) && persistOrder()}>
                    {filtered.map(item => (
                        <Row key={item.id} item={item} def={def}
                            onEdit={() => handleEdit(item)}
                            onToggle={on => handleToggle(item, on)} onDuplicate={() => duplicate(item)} onDelete={() => handleRemove(item)}
                            onEmail={ANNOUNCE[type] ? () => setAnnouncing(item) : undefined}
                            onMoveToAdvisory={type === 'board' ? () => openAdvisoryModal({ item }) : undefined} />
                    ))}
                </Reorder.Group>
            )}
            <p className="adm-hint">Drag the handle to reorder — the website follows this order.{ANNOUNCE[type] ? ' Use Email to tell users and newsletter subscribers about a new ' + (type === 'blogs' ? 'post.' : 'issue.') : ''}</p>
            {announcing && <AnnounceModal type={type} payload={{ id: announcing.id }} heading={`Email “${announcing.title || 'this'}” to readers`} draft={announcing._status !== 'published'}
                vars={{ title: announcing.title || '', summary: announcing.desc || '', edition: announcing.edition || '', readTime: announcing.readTime || '2 min read' }} onClose={() => setAnnouncing(null)} />}

            <Drawer open={!!editing} title={`${editing?.id ? 'Edit' : 'New'} ${def.singular}`} onClose={() => setEditing(null)}
                preview={editing && <PreviewFrame path={path} patch={patch} focus={PREVIEW_FOCUS[type]} />}
                footer={<>
                    {type === 'board' && editing?.id && (
                        <button type="button" className="adm-btn ghost" onClick={() => { const it = { id: editing.id, ...editing.data }; openAdvisoryModal({ item: it }) }} title="Make as Advisory Board">
                            <Icon name="award" size={14} /> Make Advisory Board
                        </button>
                    )}
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

            <Modal open={!!pwPrompt} onClose={() => setPwPrompt(null)} title="Password Required">
                {pwPrompt && (
                    <form className="adm-form" onSubmit={handlePwSubmit}>
                        <p style={{ margin: '0 0 16px', color: 'var(--adm-muted)' }}>{pwPrompt.message}</p>
                        <label className="adm-field">
                            <span>Password</span>
                            <input
                                className="adm-input"
                                type="password"
                                placeholder="Enter password"
                                value={passwordInput}
                                onChange={e => setPasswordInput(e.target.value)}
                                autoFocus
                                required
                            />
                        </label>
                        {pwError && <p className="adm-err" role="alert">{pwError}</p>}
                        <div className="adm-row end" style={{ marginTop: 20 }}>
                            <button type="button" className="adm-btn ghost" onClick={() => setPwPrompt(null)}>Cancel</button>
                            <button type="submit" className="adm-btn primary" disabled={pwBusy}>{pwBusy ? 'Verifying…' : 'Confirm'}</button>
                        </div>
                    </form>
                )}
            </Modal>

            <Modal open={!!advisoryModal} onClose={() => setAdvisoryModal(null)} title={advisoryModal?.all ? 'Make All Advisory Board' : `Make "${advisoryModal?.item?.name || 'Board Member'}" Advisory Board`}>
                {advisoryModal && (
                    <form className="adm-form" onSubmit={handleMoveToAdvisory}>
                        <p style={{ margin: '0 0 16px', color: 'var(--adm-muted)' }}>
                            {advisoryModal.all
                                ? `Transfer all ${items.length} active board members to the Advisory Board under the selected tenure year, and keep the current board blank for the new board.`
                                : `Transfer ${advisoryModal.item?.name || 'this member'} (${advisoryModal.item?.role || 'Board'}) into the Advisory Board under the selected tenure year.`
                            }
                        </p>
                        <label className="adm-field">
                            <span>Board Tenure Year (required)</span>
                            <input
                                className="adm-input"
                                type="text"
                                placeholder="e.g. 2024-2025"
                                value={advisoryYear}
                                onChange={e => setAdvisoryYear(e.target.value)}
                                autoFocus
                                required
                            />
                        </label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '8px 0 16px', flexWrap: 'wrap' }}>
                            <span style={{ fontSize: '.8rem', color: 'var(--adm-muted)' }}>Suggested:</span>
                            {suggestedYears.map(sy => (
                                <button
                                    key={sy}
                                    type="button"
                                    className="adm-btn small ghost"
                                    style={{ padding: '2px 8px', fontSize: '.75rem', height: 'auto' }}
                                    onClick={() => setAdvisoryYear(sy)}
                                >
                                    {sy}
                                </button>
                            ))}
                        </div>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '12px 0 16px', fontSize: '.9rem', cursor: 'pointer' }}>
                            <input
                                type="checkbox"
                                checked={!advisoryKeepCopy}
                                onChange={e => setAdvisoryKeepCopy(!e.target.checked)}
                            />
                            <span>{advisoryModal.all ? 'Keep current board blank (clears active board)' : 'Remove from active board'}</span>
                        </label>
                        {advisoryErr && <p className="adm-err" role="alert">{advisoryErr}</p>}
                        <div className="adm-row end" style={{ marginTop: 20 }}>
                            <button type="button" className="adm-btn ghost" onClick={() => setAdvisoryModal(null)}>Cancel</button>
                            <button type="submit" className="adm-btn primary" disabled={advisoryBusy}>
                                {advisoryBusy ? 'Moving…' : advisoryModal.all ? 'Confirm & Make All Advisory Board' : 'Confirm & Move to Advisory'}
                            </button>
                        </div>
                    </form>
                )}
            </Modal>
        </>
    )
}
