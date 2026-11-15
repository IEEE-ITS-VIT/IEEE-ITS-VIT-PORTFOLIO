import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api'
import { isPdfUrl, fileName, viewerLink } from '../../lib/pdf'
import { uploadToImageKit, thumb, isImageUrl, fileExt } from '../fields'
import { Drawer, PageTitle, Empty, Spinner, useToast, useConfirm, useLoader, fmtDate } from '../ui'
import Icon from '../icons'

const PdfViewer = lazy(() => import('../../components/PdfViewer'))
const PdfThumb = lazy(() => import('../../components/PdfViewer').then(m => ({ default: m.PdfThumb })))

const FILTERS = [['all', 'All'], ['image', 'Images'], ['pdf', 'PDFs'], ['doc', 'Other documents']]
const kindOf = m => (isImageUrl(m.url) ? 'image' : isPdfUrl(m.url) ? 'pdf' : 'doc')
const kb = n => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
const officeViewer = u => `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(u)}`

/** One copyable link with a label. */
function LinkRow({ label, value, hint }) {
    const toast = useToast()
    return (
        <div className="adm-field">
            <span>{label}</span>
            <div className="adm-linkrow">
                <input className="adm-input" readOnly value={value} onFocus={e => e.target.select()} />
                <button type="button" className="adm-btn small" onClick={() => navigator.clipboard.writeText(value).then(() => toast('Copied'))}>Copy</button>
            </div>
            {hint && <small className="adm-hint">{hint}</small>}
        </div>
    )
}

/** Preview, file details, links to share or paste, and every place on the site that uses the file. */
function MediaDetails({ media, onClose, onDelete }) {
    const [info, setInfo] = useState(null)
    const [pages, setPages] = useState(null)
    useEffect(() => {
        let alive = true
        api.get(`/admin/media/${media.id}/usage`).then(r => alive && setInfo(r)).catch(() => alive && setInfo({ usedIn: null }))
        return () => { alive = false }
    }, [media.id])
    const kind = kindOf(media)
    const ext = fileExt(media.url).toUpperCase() || 'FILE'
    const name = media.name || fileName(media.url)
    const usedIn = info?.usedIn
    return (
        <Drawer open title={name} onClose={onClose} wide
            footer={<>
                <a className="adm-btn ghost" href={media.url} target="_blank" rel="noreferrer">Open original <Icon name="external" size={14} /></a>
                <button className="adm-btn ghost danger-text" onClick={() => onDelete(media)}><Icon name="trash" size={16} /> Delete</button>
            </>}>
            <div className="adm-media-detail">
                {kind === 'image' && <img className="preview-img" src={`${media.url}${media.url.includes('?') ? '&' : '?'}tr=w-1400,c-at_max`} alt={name} />}
                {kind === 'pdf' && <Suspense fallback={<Spinner />}><PdfViewer url={media.url} title={name} height="60vh" onInfo={i => setPages(i.pages)} /></Suspense>}
                {kind === 'doc' && (['DOC', 'DOCX', 'PPT', 'PPTX', 'XLS', 'XLSX'].includes(ext)
                    ? <iframe className="pr-viewer" style={{ height: '60vh', width: '100%', border: '1px solid var(--a-border)', borderRadius: 12 }} src={officeViewer(media.url)} title={name} />
                    : <span className="adm-file-tile" style={{ height: 160, borderRadius: 12 }}><Icon name="book" size={30} /><b>{ext}</b><small>No preview for this file type</small></span>)}

                <section className="adm-panel">
                    <h3>Details</h3>
                    <dl className="adm-kv">
                        <dt>File name</dt><dd>{name}</dd>
                        <dt>Type</dt><dd>{ext}{media.mime ? ` (${media.mime})` : ''}</dd>
                        {media.size > 0 && <><dt>Size</dt><dd>{kb(media.size)}</dd></>}
                        {media.width > 0 && <><dt>Dimensions</dt><dd>{media.width} × {media.height} px</dd></>}
                        {pages && <><dt>Pages</dt><dd>{pages}</dd></>}
                        {media.folder && <><dt>ImageKit folder</dt><dd>{media.folder}</dd></>}
                        <dt>Uploaded</dt><dd>{fmtDate(media.created_at)}{info?.item?.uploader ? ` by ${info.item.uploader}` : ''}</dd>
                    </dl>
                </section>

                <section className="adm-panel adm-form">
                    <h3>Links</h3>
                    <LinkRow label="Direct file link (CDN)" value={media.url} hint="Paste into any image / file field, or share it. Opens the file itself." />
                    {kind === 'pdf' && <LinkRow label="Viewer page on the website" value={viewerLink(media.url, name)} hint="A page on the site that shows this PDF in the built-in viewer — good for WhatsApp / Instagram posts. Works on phones." />}
                    {kind === 'image' && <LinkRow label="Resized for the web (1200 px wide)" value={`${media.url}${media.url.includes('?') ? '&' : '?'}tr=w-1200`} />}
                    <LinkRow label="HTML link (for blog posts / rich text)" value={kind === 'image' ? `<img src="${media.url}" alt="${name.replace(/"/g, '')}" />` : `<a href="${media.url}">${name}</a>`} />
                    {kind === 'pdf' && <p className="adm-hint" style={{ margin: 0 }}>Any link to this PDF on the website opens in the built-in viewer automatically.</p>}
                </section>

                <section className="adm-panel">
                    <h3>Used in {usedIn ? `(${usedIn.length})` : ''}</h3>
                    {!info ? <Spinner /> : usedIn === null ? <p className="adm-hint">Could not check where this file is used.</p>
                        : usedIn.length === 0 ? <p className="adm-hint" style={{ margin: 0 }}>Not used anywhere on the site yet. Copy the link above and paste it into a resource, event, portal or page.</p> : (
                            <ul className="adm-usage">
                                {usedIn.map((u, i) => (
                                    <li key={i}>
                                        <span>{u.label}</span>
                                        <span className="adm-row" style={{ flex: 'none' }}>
                                            {u.admin && <Link className="adm-btn small ghost" to={u.admin}>Edit</Link>}
                                            {u.page && <a className="adm-btn small ghost" href={u.page} target="_blank" rel="noreferrer">View page <Icon name="external" size={12} /></a>}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        )}
                </section>
            </div>
        </Drawer>
    )
}

export default function MediaLibrary() {
    const toast = useToast()
    const confirm = useConfirm()
    const { data, loading, setData } = useLoader(() => api.get('/admin/media'), [])
    const [progress, setProgress] = useState('')
    const [q, setQ] = useState('')
    const [filter, setFilter] = useState('all')
    const [open, setOpen] = useState(null)
    const fileRef = useRef()

    const upload = async files => {
        let ok = 0
        for (const [i, f] of [...files].entries()) {
            try {
                // Images and documents (PDF, Word, slides…) both go to ImageKit; documents into the docs folder.
                const item = await uploadToImageKit(f, p => setProgress(`${i + 1}/${files.length} · ${Math.round(p * 100)}%`), { document: !f.type.startsWith('image/') })
                setData(d => ({ ...d, items: [item, ...d.items] }))
                ok++
            } catch (e) { toast(e.message, 'error') }
        }
        setProgress('')
        if (ok) toast(`Uploaded ${ok} file${ok > 1 ? 's' : ''}`)
    }

    const remove = async m => {
        if (!await confirm(`Delete “${m.name}” from ImageKit permanently?`)) return
        try { await api.del(`/admin/media/${m.id}`); setData(d => ({ ...d, items: d.items.filter(x => x.id !== m.id) })); setOpen(null); toast('Deleted') }
        catch (e) { toast(e.message, 'error') }
    }

    const all = data?.items || []
    const counts = Object.fromEntries(FILTERS.map(([k]) => [k, k === 'all' ? all.length : all.filter(m => kindOf(m) === k).length]))
    const items = all.filter(m => (filter === 'all' || kindOf(m) === filter) && (!q || `${m.name} ${m.url}`.toLowerCase().includes(q.toLowerCase())))

    return (
        <>
            <PageTitle title="Media Library" subtitle="Images and documents are stored on ImageKit (optimised + CDN). Click a file to preview it (PDFs open in the viewer), copy its links and see where it is used. Drag files anywhere on this page to upload.">
                <input className="adm-input search" placeholder="Search files…" value={q} onChange={e => setQ(e.target.value)} />
                <button className="adm-btn primary" disabled={!data?.imagekit || !!progress} onClick={() => fileRef.current.click()}>{progress ? `Uploading ${progress}` : '⬆ Upload images / PDFs'}</button>
                <input ref={fileRef} type="file" accept="image/*,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.csv,.txt,.md,.zip" multiple hidden onChange={e => { upload(e.target.files); e.target.value = '' }} />
            </PageTitle>
            {data && !data.imagekit && <p className="adm-hint warn">ImageKit is not connected. Add IMAGEKIT_PUBLIC_KEY, IMAGEKIT_PRIVATE_KEY and IMAGEKIT_URL_ENDPOINT to the environment to enable uploads.</p>}
            <div className="adm-media-filters adm-seg">
                {FILTERS.map(([k, l]) => <button key={k} type="button" className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l} ({counts[k]})</button>)}
            </div>
            <div onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (data?.imagekit) upload(e.dataTransfer.files) }}>
                {loading ? <Spinner /> : items.length === 0 ? <Empty icon="image">{all.length ? 'No files match.' : 'No uploads yet.'}</Empty> : (
                    <div className="adm-media-grid large">
                        {items.map(m => {
                            const kind = kindOf(m)
                            return (
                                <figure key={m.id} className="adm-media-card">
                                    <button type="button" className="adm-media-open" onClick={() => setOpen(m)} aria-label={`Preview and details: ${m.name}`}>
                                        {kind === 'image' ? <img src={thumb(m.url)} alt={m.name} loading="lazy" />
                                            : kind === 'pdf' ? <Suspense fallback={<span className="pdfv-thumb"><b>PDF</b></span>}><PdfThumb url={m.url} /></Suspense>
                                                : <span className="adm-file-tile"><Icon name="book" size={26} /><b>{fileExt(m.url).toUpperCase() || 'FILE'}</b></span>}
                                    </button>
                                    {kind !== 'image' && <span className="adm-media-type">{fileExt(m.url).toUpperCase() || 'FILE'}</span>}
                                    <figcaption>
                                        <strong title={m.name}>{m.name || 'file'}</strong>
                                        <small>{m.width ? `${m.width}×${m.height} · ` : ''}{m.size ? `${kb(m.size)} · ` : ''}{fmtDate(m.created_at)}</small>
                                        <div className="adm-row">
                                            <button className="adm-btn small" onClick={() => setOpen(m)}>{kind === 'pdf' ? 'View & details' : 'Details'}</button>
                                            <button className="adm-btn small ghost" onClick={() => { navigator.clipboard.writeText(m.url); toast('Link copied') }}>Copy link</button>
                                            <button className="adm-btn small ghost danger-text" onClick={() => remove(m)} aria-label="Delete"><Icon name="trash" size={16} /></button>
                                        </div>
                                    </figcaption>
                                </figure>
                            )
                        })}
                    </div>
                )}
            </div>
            {open && <MediaDetails media={open} onClose={() => setOpen(null)} onDelete={remove} />}
        </>
    )
}
