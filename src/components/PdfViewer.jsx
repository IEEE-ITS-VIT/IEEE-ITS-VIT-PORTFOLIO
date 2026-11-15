/*
 * In-page PDF viewer built on pdf.js. Browsers on Android cannot show PDFs inside a page (an <iframe>
 * just offers a download), so every page is drawn onto a canvas instead — the same on phones and laptops.
 * pdf.js (~1 MB) is only downloaded the first time someone opens a PDF.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { isPdfUrl, fileName } from '../lib/pdf'

let pdfjs
const loadPdfjs = () => (pdfjs ||= Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
]).then(([lib, worker]) => {
    lib.GlobalWorkerOptions.workerSrc = worker.default
    return lib
}).catch(e => { pdfjs = null; throw e }))

/** Opens a PDF document (cached per URL while the page is open). */
const docs = new Map()
function openPdf(url) {
    if (!docs.has(url)) {
        docs.set(url, loadPdfjs().then(lib => lib.getDocument({ url, isEvalSupported: false }).promise).catch(e => { docs.delete(url); throw e }))
    }
    return docs.get(url)
}

const dpr = () => Math.min(2, window.devicePixelRatio || 1)

function PdfPage({ doc, n, width, ratio, setRef }) {
    const box = useRef(null)
    const canvas = useRef(null)
    const [near, setNear] = useState(n <= 2)
    const [height, setHeight] = useState(null)

    useEffect(() => {
        const el = box.current
        if (!el || near) return
        const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) setNear(true) }, { rootMargin: '800px 0px' })
        io.observe(el)
        return () => io.disconnect()
    }, [near])

    useEffect(() => {
        if (!near || !width) return
        let task
        let cancelled = false
        doc.getPage(n).then(page => {
            if (cancelled) return
            const base = page.getViewport({ scale: 1 })
            const scale = width / base.width
            const vp = page.getViewport({ scale: scale * dpr() })
            const c = canvas.current
            c.width = Math.floor(vp.width)
            c.height = Math.floor(vp.height)
            setHeight(base.height * scale)
            task = page.render({ canvasContext: c.getContext('2d'), viewport: vp })
            return task.promise
        }).catch(() => { /* cancelled by a newer render */ })
        return () => { cancelled = true; task?.cancel() }
    }, [doc, n, width, near])

    return (
        <div className="pdfv-page" ref={el => { box.current = el; setRef(n, el) }} style={{ width, height: height ?? width * ratio }} data-page={n}>
            <canvas ref={canvas} style={{ width: '100%', height: '100%' }} aria-label={`Page ${n}`} />
        </div>
    )
}

/**
 * The viewer: toolbar (page x / n, zoom, open, download) above the scrollable pages.
 * `height` is the scroll area's height (CSS value, or 'fill' to take the rest of a flex parent); `onInfo` receives { pages } once loaded.
 */
export default function PdfViewer({ url, title, height = '75vh', onInfo, toolbarExtra }) {
    const [doc, setDoc] = useState(null)
    const [error, setError] = useState(null)
    const [ratio, setRatio] = useState(1.414)
    const [zoom, setZoom] = useState(1)
    const [width, setWidth] = useState(0)
    const [current, setCurrent] = useState(1)
    const scroller = useRef(null)
    const pages = useRef({})
    const name = title || fileName(url)

    useEffect(() => {
        // A different URL mounts a new viewer (callers pass key={url}), so state never needs resetting here.
        let alive = true
        openPdf(url).then(async d => {
            const first = await d.getPage(1)
            const vp = first.getViewport({ scale: 1 })
            if (!alive) return
            setRatio(vp.height / vp.width)
            setDoc(d)
            onInfo?.({ pages: d.numPages })
        }).catch(e => { if (alive) setError(e) })
        return () => { alive = false }
    }, [url]) // eslint-disable-line react-hooks/exhaustive-deps -- onInfo is a notification only

    // Fit-to-width follows the viewer's size (phone rotation, window resize).
    useEffect(() => {
        const el = scroller.current
        if (!el) return
        const ro = new ResizeObserver(([e]) => setWidth(Math.max(200, Math.floor(e.contentRect.width) - 24)))
        ro.observe(el)
        return () => ro.disconnect()
    }, [doc])

    const setRef = useCallback((n, el) => { pages.current[n] = el }, [])
    const onScroll = () => {
        const el = scroller.current
        const mark = el.scrollTop + el.clientHeight / 3
        let p = 1
        for (const [n, node] of Object.entries(pages.current)) if (node && node.offsetTop <= mark) p = Math.max(p, Number(n))
        setCurrent(p)
    }
    const go = n => {
        const node = pages.current[Math.min(doc.numPages, Math.max(1, n))]
        if (node) scroller.current.scrollTo({ top: node.offsetTop - 12, behavior: 'smooth' })
    }

    const pageWidth = Math.round(width * zoom)
    return (
        <div className={`pdfv${height === 'fill' ? ' fill' : ''}`}>
            <div className="pdfv-bar">
                <span className="pdfv-name" title={name}>{name}</span>
                {doc && (
                    <span className="pdfv-nav">
                        <button type="button" onClick={() => go(current - 1)} disabled={current <= 1} aria-label="Previous page">‹</button>
                        <span>{current} / {doc.numPages}</span>
                        <button type="button" onClick={() => go(current + 1)} disabled={current >= doc.numPages} aria-label="Next page">›</button>
                        <span className="pdfv-sep" />
                        <button type="button" onClick={() => setZoom(z => Math.max(0.5, +(z - 0.25).toFixed(2)))} aria-label="Zoom out">−</button>
                        <button type="button" className="pdfv-zoom" onClick={() => setZoom(1)} title="Fit to width">{Math.round(zoom * 100)}%</button>
                        <button type="button" onClick={() => setZoom(z => Math.min(3, +(z + 0.25).toFixed(2)))} aria-label="Zoom in">+</button>
                    </span>
                )}
                <span className="pdfv-actions">
                    {toolbarExtra}
                    <a href={url} target="_blank" rel="noreferrer" data-no-viewer>Open ↗</a>
                    <a href={url} download data-no-viewer>Download</a>
                </span>
            </div>
            <div className="pdfv-scroll" ref={scroller} onScroll={doc ? onScroll : undefined} style={height === 'fill' ? undefined : { height }}>
                {error ? (
                    <div className="pdfv-msg">
                        <p>This PDF can't be shown here{isPdfUrl(url) ? '' : ' (it may not be a PDF)'}.</p>
                        <a className="btn sm" href={url} target="_blank" rel="noreferrer" data-no-viewer>Open it in a new tab ↗</a>
                    </div>
                ) : !doc ? (
                    <div className="pdfv-msg"><span className="pdfv-spin" aria-hidden="true" /> Loading PDF…</div>
                ) : width > 0 && (
                    Array.from({ length: doc.numPages }, (_, i) => <PdfPage key={i + 1} doc={doc} n={i + 1} width={pageWidth} ratio={ratio} setRef={setRef} />)
                )}
            </div>
        </div>
    )
}

/** First page as a small thumbnail (Media Library cards). Draws only when scrolled into view. */
export function PdfThumb({ url, size = 300 }) {
    const box = useRef(null)
    const canvas = useRef(null)
    const [state, setState] = useState('idle')
    useEffect(() => {
        const el = box.current
        let task
        let cancelled = false
        const io = new IntersectionObserver(([e]) => {
            if (!e.isIntersecting) return
            io.disconnect()
            setState('loading')
            openPdf(url).then(d => d.getPage(1)).then(page => {
                if (cancelled) return
                const base = page.getViewport({ scale: 1 })
                const vp = page.getViewport({ scale: (size / Math.max(base.width, base.height)) * dpr() })
                const c = canvas.current
                c.width = Math.floor(vp.width); c.height = Math.floor(vp.height)
                task = page.render({ canvasContext: c.getContext('2d'), viewport: vp })
                return task.promise
            }).then(() => !cancelled && setState('ok')).catch(() => !cancelled && setState('error'))
        }, { rootMargin: '200px' })
        io.observe(el)
        return () => { cancelled = true; io.disconnect(); task?.cancel() }
    }, [url, size])
    return (
        <span className={`pdfv-thumb ${state}`} ref={box}>
            <canvas ref={canvas} />
            {state !== 'ok' && <b>PDF</b>}
        </span>
    )
}
