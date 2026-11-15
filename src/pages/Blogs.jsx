import { useEffect, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { useSite } from '../context/SiteContext'
import { api } from '../lib/api'
import { sanitizeHtml, label } from '../lib/safe'
import SmartLink from '../components/SmartLink'
import Seo from '../components/Seo'
import Img from '../components/Img'
import PageHeader from '../components/PageHeader'
import { Reveal } from '../components/Reveal'
import { SectionHead } from '../components/Cards'
import Section from '../components/Section'

function Subscribe({ cfg }) {
    const [email, setEmail] = useState('')
    const [msg, setMsg] = useState(null)
    const [busy, setBusy] = useState(false)
    const submit = async e => {
        e.preventDefault()
        setBusy(true)
        try {
            const r = await api.post('/subscribe', { email, list: 'newsletter' })
            setMsg({ ok: true, text: r.already ? 'You are already subscribed.' : "You're on the list. Welcome aboard." })
            setEmail('')
        } catch (err) { setMsg({ ok: false, text: err.message }) } finally { setBusy(false) }
    }
    return (
        <div className="band">
            <div><h2 className="display h-md">{cfg.newsletterTitle}</h2><p>{cfg.newsletterText}</p></div>
            <form onSubmit={submit} className="hero-cta" style={{ marginTop: 0, flex: '1 1 320px', maxWidth: 480 }}>
                <input className="input" type="email" required placeholder="you@vitstudent.ac.in" value={email} onChange={e => setEmail(e.target.value)} style={{ flex: 1, minWidth: 200, borderColor: 'var(--accent-ink)', background: 'transparent', color: 'var(--accent-ink)' }} aria-label="Email" />
                <button className="btn light" disabled={busy}>{busy ? '…' : 'Subscribe'}</button>
                {msg && <p style={{ width: '100%', margin: 0 }}>{msg.text}</p>}
            </form>
        </div>
    )
}

export default function Blogs() {
    const { list, settings, ready } = useSite()
    const { slug } = useParams()
    const blogs = list('blogs')
    const mags = list('magazines')
    const cfg = settings.blogs || {}
    // "Magazines" in the More menu links to /blogs#magazines: scroll there once the page has rendered.
    const location = useLocation()
    useEffect(() => {
        if (slug || location.hash !== '#magazines') return
        let tries = 0
        const t = setInterval(() => {
            const el = document.getElementById('magazines')
            if (!el && ++tries <= 20) return
            clearInterval(t)
            if (!el) return
            const target = () => Math.max(0, el.getBoundingClientRect().top + window.scrollY - 80)
            window.scrollTo({ top: target(), behavior: 'smooth' })
            // Smooth scrolling can be cut short (images loading above, reduced motion, background tabs): make sure we arrive.
            settle = setTimeout(() => { if (Math.abs(el.getBoundingClientRect().top - 80) > 40) window.scrollTo({ top: target(), behavior: 'instant' }) }, 900)
        }, 150)
        let settle
        return () => { clearInterval(t); clearTimeout(settle) }
    }, [slug, location.hash, location.key])

    if (slug) {
        const b = blogs.find(x => x.slug === slug)
        if (!b) return <PageHeader title={ready ? 'Article not found' : 'Loading'} overline="Blogs"><Link className="btn" to="/blogs" style={{ marginTop: 20 }}>All articles</Link></PageHeader>
        const jsonLd = { '@context': 'https://schema.org', '@type': 'BlogPosting', headline: b.title, description: b.desc, datePublished: b.date, image: b.image ? new URL(b.image, window.location.origin).href : undefined, author: { '@type': 'Organization', name: settings.site?.name } }
        return (
            <>
                <Seo title={b.title} description={b.desc} image={b.image} type="article" jsonLd={jsonLd} />
                <PageHeader title={b.title} overline={`Blogs / ${b.tag || 'Article'}`} subtitle={[b.date, b.readTime].filter(Boolean).join(' · ')} wide article sectionId="blog.article" />
                <section className="section" style={{ borderTop: 0 }}>
                    <div className="wrap">
                        {b.image && <Reveal><Img src={b.image} alt={b.title} ratio="21x9" width={1600} eager /></Reveal>}
                        <div className="prose" style={{ margin: '48px auto 0' }} dangerouslySetInnerHTML={{ __html: sanitizeHtml(b.content) }} />
                        <div style={{ maxWidth: 720, margin: '48px auto 0' }}><Link to="/blogs" className="link-arrow">← All articles</Link></div>
                    </div>
                </section>
                <section className="section tight"><div className="wrap"><Subscribe cfg={cfg} /></div></section>
            </>
        )
    }

    return (
        <>
            <Seo />
            <PageHeader page="blogs" />
            <Section id="blogs.list" className="section" style={{ borderTop: 0 }}>
                <div className="wrap">
                    <div className="grid g-3">
                        {blogs.map((b, i) => (
                            <Reveal key={b.id} delay={(i % 3) * 0.06}>
                                <Link to={`/blogs/${b.slug}`} className="card">
                                    <Img src={b.image} alt={b.title} ratio="16x9" width={800}>{b.tag && <span className="chip">{b.tag}</span>}</Img>
                                    <div className="card-body">
                                        <div className="card-meta"><span>{b.date}</span><span>{b.readTime}</span></div>
                                        <h3 className="display h-sm">{b.title}</h3>
                                        <p>{b.desc}</p>
                                    </div>
                                </Link>
                            </Reveal>
                        ))}
                    </div>
                    {!blogs.length && <p className="empty">No articles yet</p>}
                </div>
            </Section>
            {cfg.magazineEnabled !== false && (
                <section className="section" id="magazines" style={{ scrollMarginTop: 90 }}>
                    <div className="wrap">
                        <SectionHead overline={cfg.magazineTag} title={cfg.magazineTitle} text={cfg.magazineText} />
                        <div className="grid g-2">
                            {mags.map(m => (
                                <div key={m.id} className="boxed form" style={{ gap: 10 }}>
                                    {m.image && (m.url ? <SmartLink to={m.url} data-title={m.title} aria-label={`Read ${m.title}`}><Img src={m.image} alt={`${m.title} cover`} ratio="16x9" width={900} /></SmartLink> : <Img src={m.image} alt={`${m.title} cover`} ratio="16x9" width={900} />)}
                                    <span className="label">{m.edition}</span>
                                    <h3 className="display h-sm">{m.title}</h3>
                                    <p className="muted" style={{ margin: 0 }}>{m.desc}</p>
                                    {m.url ? <SmartLink to={m.url} data-title={m.title} className="link-arrow" style={{ alignSelf: 'flex-start' }}>Read →</SmartLink> : <span className="chip" style={{ alignSelf: 'flex-start' }}>{cfg.magazineCtaLabel}</span>}
                                </div>
                            ))}
                        </div>
                        {cfg.magazineCtaUrl && <SmartLink to={cfg.magazineCtaUrl} className="btn solid" style={{ marginTop: 24 }}>{label(cfg.magazineCtaLabel)} <span className="arr">→</span></SmartLink>}
                    </div>
                </section>
            )}
            <section className="section tight"><div className="wrap"><Subscribe cfg={cfg} /></div></section>
        </>
    )
}
