/* "Tell people about it" emails: new blog post, new magazine issue, newly published Connect questions. */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { Modal, useToast, queuedText } from './ui'
import Icon from './icons'

/* Default wording (editable before sending). */
export const ANNOUNCE = {
    blogs: {
        subject: 'New on the IEEE ITS VIT blog: {{title}}',
        body: 'Hi {{name}},\n\nWe just published a new article on the IEEE ITS VIT blog:\n\n{{title}}\n{{summary}}\n\nRead it here ({{readTime}}):\n{{link}}\n\nIEEE ITS VIT',
        placeholders: '{{name}} {{title}} {{summary}} {{readTime}} {{link}}', linkHint: '{{link}} opens the article.',
    },
    magazines: {
        subject: 'The new {{title}} is out — check it out',
        body: 'Hi {{name}},\n\nThe latest edition of {{title}} {{edition}} is out.\n\n{{summary}}\n\nCheck it out here:\n{{link}}\n\nIEEE ITS VIT',
        placeholders: '{{name}} {{title}} {{summary}} {{edition}} {{link}}', linkHint: '{{link}} opens the PDF in the website\'s viewer.',
    },
    connect: {
        subject: '{{count}} new interview questions on IEEE ITS VIT Connect',
        body: 'Hi {{name}},\n\nNew interview questions and topics shared by students are now on Connect:\n\n{{list}}\n\nCheck them out — answers, company, year and resources:\n{{link}}\n\nGot asked something interesting? Share it on the same page.\n\nIEEE ITS VIT',
        placeholders: '{{name}} {{count}} {{list}} {{companies}} {{link}}', linkHint: '{{list}} is the list of questions (company — question); {{link}} opens the Connect page.',
    },
}

/**
 * The email form. `type` picks the defaults, `payload` says what is being announced ({ id } or { ids }),
 * `vars` fill the preview, `draft` warns that the item is not public yet.
 */
export function AnnounceModal({ type, payload, heading, vars = {}, draft, onClose }) {
    const toast = useToast()
    const navigate = useNavigate()
    const def = ANNOUNCE[type]
    const [aud, setAud] = useState({ users: true, subscribers: true })
    const [custom, setCustom] = useState('')
    const [subject, setSubject] = useState(def.subject)
    const [body, setBody] = useState(def.body)
    const [counts, setCounts] = useState(null)
    const [busy, setBusy] = useState(false)
    useEffect(() => { api.get('/admin/announce/audience').then(setCounts).catch(() => {}) }, [])
    const typed = custom.split(/[\s,;]+/).filter(Boolean)
    const badTyped = typed.filter(e => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
    const upTo = (aud.users ? counts?.users || 0 : 0) + (aud.subscribers ? counts?.subscribers || 0 : 0) + typed.length
    const send = async () => {
        setBusy(true)
        try {
            const r = await api.post('/admin/announce', { type, ...payload, audiences: Object.keys(aud).filter(k => aud[k]), custom, subject, body })
            toast(queuedText(r.queued)); navigate('/admin/outbox')
        } catch (e) { toast(e.message, 'error') }
        setBusy(false)
    }
    const sample = { name: 'Aditi', link: `(link to the ${type === 'blogs' ? 'article' : type === 'magazines' ? 'magazine' : 'Connect page'})`, ...vars }
    const fill = t => t.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => String(sample[k] ?? ''))
    return (
        <Modal open onClose={onClose} title={heading} wide>
            <div className="adm-form">
                {draft && <p className="adm-hint warn">This is not public yet — publish it first, otherwise the link in the email will not show it.</p>}
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
                <label className="adm-field"><span>Message</span><textarea className="adm-input" rows={10} value={body} onChange={e => setBody(e.target.value)} /></label>
                <p className="adm-hint" style={{ margin: 0 }}>Placeholders: {def.placeholders}. {def.linkHint} Everyone gets their own email; people in more than one list get it once. Large lists go out within the daily email limit.</p>
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
