/* /magazines — every published magazine / newsletter with its cover; PDFs open in the site's viewer. */
import { useSite } from '../context/SiteContext'
import PageHeader from '../components/PageHeader'
import Seo from '../components/Seo'
import Section from '../components/Section'
import Img from '../components/Img'
import SmartLink from '../components/SmartLink'
import { isPdfUrl } from '../lib/pdf'

export default function Magazines() {
    const { list, ready } = useSite()
    const mags = list('magazines')
    return (
        <>
            <Seo />
            <PageHeader page="magazines" />
            <Section id="magazines.list" className="section" style={{ borderTop: 0 }}>
                <div className="wrap">
                    {!mags.length ? <p className="empty">{ready ? 'The first issue is on its way.' : 'Loading…'}</p> : (
                        <div className="grid g-2 mag-grid">
                            {mags.map(m => (
                                <article key={m.id} className="mag-card">
                                    {m.url ? (
                                        <SmartLink to={m.url} data-title={m.title} className="mag-cover" aria-label={`Read ${m.title}`}>
                                            <Img src={m.image} alt={`${m.title} cover`} ratio="16x9" width={1000} fallback={<span className="mag-cover-blank">{m.title}</span>} />
                                        </SmartLink>
                                    ) : <div className="mag-cover"><Img src={m.image} alt={`${m.title} cover`} ratio="16x9" width={1000} /></div>}
                                    <div className="mag-body">
                                        {m.edition && <span className="label">{m.edition}</span>}
                                        <h2 className="display h-sm">{m.title}</h2>
                                        {m.desc && <p className="muted">{m.desc}</p>}
                                        <div className="mag-actions">
                                            {m.url ? <>
                                                <SmartLink to={m.url} data-title={m.title} className="btn solid sm">{isPdfUrl(m.url) ? 'Read online' : 'Open'} <span className="arr">→</span></SmartLink>
                                                {isPdfUrl(m.url) && <a className="btn sm" href={m.url} download data-no-viewer>Download PDF</a>}
                                            </> : <span className="chip">Coming soon</span>}
                                        </div>
                                    </div>
                                </article>
                            ))}
                        </div>
                    )}
                </div>
            </Section>
        </>
    )
}
