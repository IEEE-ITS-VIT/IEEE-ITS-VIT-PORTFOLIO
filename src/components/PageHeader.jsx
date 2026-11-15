import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useSite } from '../context/SiteContext'
import { RevealText } from './Reveal'
import Section from './Section'

/** Page header; text comes from Admin → Page Headers unless explicit props are given. */
/** `sectionId` lets one kind of page (e.g. blog articles) get its own Admin → Design style; `article` uses the smaller article title. */
export default function PageHeader({ page, title, overline, subtitle, wide, children, sectionId = 'page.header', article }) {
    const { settings } = useSite()
    const h = { ...(settings.pages?.[page] || {}), ...(title ? { title } : {}), ...(overline ? { overline } : {}), ...(subtitle !== undefined ? { subtitle } : {}) }
    return (
        <Section id={sectionId} as="header" className={`page-head${article ? ' article' : ''}`}>
            <div className="wrap">
                <div className="crumbs"><Link to="/">Home</Link> / {h.overline}</div>
                <RevealText as="h1" className={`display h-xl${wide ? ' wide' : ''}${article ? ' article-title' : ''}`} text={(h.title || '').replace(/[^\p{L}\p{N}\s'&.,:!?—–-]/gu, '').trim()} inView={false} />
                {h.subtitle && <motion.p className="lead" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }}>{h.subtitle}</motion.p>}
                {children}
            </div>
        </Section>
    )
}
