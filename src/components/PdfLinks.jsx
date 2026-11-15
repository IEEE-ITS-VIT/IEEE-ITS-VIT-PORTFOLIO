/*
 * Any link to a PDF on the public site (resources, event portals, recruitment, blog posts, footer…) opens in
 * the built-in viewer instead of leaving the site or downloading. The open viewer is part of the browser
 * history, so the phone's Back button closes it. Ctrl/Cmd-click, middle-click and download links work as usual.
 */
import { lazy, Suspense, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { isPdfUrl, fileName } from '../lib/pdf'

const PdfViewer = lazy(() => import('./PdfViewer'))

export default function PdfLinks() {
    const location = useLocation()
    const navigate = useNavigate()
    const open = location.state?.pdf

    useEffect(() => {
        const onClick = e => {
            if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
            const a = e.target.closest?.('a[href]')
            if (!a || a.hasAttribute('download') || a.hasAttribute('data-no-viewer') || !isPdfUrl(a.href)) return
            e.preventDefault()
            const title = a.getAttribute('data-title') || a.getAttribute('title') || ''
            navigate(`${location.pathname}${location.search}${location.hash}`, { state: { ...(location.state || {}), pdf: a.href, pdfTitle: title } })
        }
        document.addEventListener('click', onClick)
        return () => document.removeEventListener('click', onClick)
    }, [navigate, location])

    const close = () => {
        if (window.history.state?.idx > 0) navigate(-1)
        else {
            const rest = { ...(location.state || {}) }
            delete rest.pdf; delete rest.pdfTitle
            navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, state: rest })
        }
    }

    useEffect(() => {
        if (!open) return
        const onKey = e => e.key === 'Escape' && close()
        window.addEventListener('keydown', onKey)
        const prev = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
    })

    if (!open) return null
    const title = location.state?.pdfTitle || fileName(open)
    return (
        <div className="pdfv-modal" role="dialog" aria-modal="true" aria-label={title}>
            <Suspense fallback={<div className="pdfv-msg"><span className="pdfv-spin" aria-hidden="true" /> Loading viewer…</div>}>
                <PdfViewer key={open} url={open} title={title} height="fill"
                    toolbarExtra={<button type="button" className="pdfv-close" onClick={close} aria-label="Close PDF">✕ Close</button>} />
            </Suspense>
        </div>
    )
}
