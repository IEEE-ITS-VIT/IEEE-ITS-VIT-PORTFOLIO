/* /view?file=<pdf url>&title=… — a shareable page that shows a PDF hosted on ImageKit in the site's viewer. */
import { lazy, Suspense } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import Seo from '../components/Seo'
import { viewable, fileName } from '../lib/pdf'

const PdfViewer = lazy(() => import('../components/PdfViewer'))

export default function ViewPdf() {
    const [params] = useSearchParams()
    const file = params.get('file') || ''
    const title = params.get('title') || fileName(file)
    if (!viewable(file)) {
        return (
            <section className="section" style={{ paddingTop: 140 }}>
                <div className="wrap">
                    <h1 className="display h-md">Document not available</h1>
                    <p className="muted">This link does not point to a document hosted by IEEE ITS VIT.</p>
                    <Link className="btn" to="/projects?tab=resources" style={{ marginTop: 20 }}>Browse resources</Link>
                </div>
            </section>
        )
    }
    return (
        <>
            <Seo title={title} description={`${title} — shared by IEEE ITS VIT`} />
            <section className="section pdfv-pagewrap">
                <div className="wrap">
                    <span className="label">Document</span>
                    <h1 className="display h-md" style={{ margin: '10px 0 18px', overflowWrap: 'anywhere' }}>{title}</h1>
                    <Suspense fallback={<div className="pdfv-msg"><span className="pdfv-spin" aria-hidden="true" /> Loading viewer…</div>}>
                        <PdfViewer url={file} title={title} height="78vh" />
                    </Suspense>
                </div>
            </section>
        </>
    )
}
