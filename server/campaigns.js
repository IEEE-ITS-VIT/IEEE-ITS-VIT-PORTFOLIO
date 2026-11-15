/**
 * Bulk email that fits free SMTP limits (Gmail allows roughly 500 messages a day).
 *
 *  • A mail-out is one email_campaigns row holding every recipient and their merge fields.
 *  • processCampaigns() sends the next small batch, never more than the daily limit
 *    (settings.mail_limits.dailyLimit, default 400 — the rest is left for password codes etc.).
 *  • It is driven by the admin Outbox page while open and by a daily Vercel cron job,
 *    so a 1,500-person mail-out simply continues the next day.
 *  • Failures heal themselves where they can:
 *      – the mail server cannot be reached / refuses the login → the mail-out pauses and tries again later;
 *      – the provider says its sending limit is used up → everything waits for tomorrow;
 *      – single addresses that failed for a temporary reason → resent once automatically;
 *      – single emails sent outside a mail-out (confirmations, notifications) that failed → queued here.
 *    Whatever still fails is listed with its reason and can be resent with one click.
 */
import { getDb, parseJson } from './db.js'
import { fail } from './http.js'
import { openTransport, fillTemplate, messageHtml } from './mailer.js'

export const DEFAULT_DAILY_LIMIT = 400
const BATCH = 20
const istDate = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10)
/** SQLite-style UTC timestamp `minutes` from now (for retry_at). */
const later = minutes => new Date(Date.now() + minutes * 60_000).toISOString().slice(0, 19).replace('T', ' ')

/* How a failed send should be treated. */
const errText = e => `${e?.responseCode || ''} ${e?.response || ''} ${e?.message || ''}`
/** The provider's own quota is used up (Gmail: "550 5.4.5 Daily user sending limit exceeded"). */
const isProviderLimit = e => /5\.4\.5|4\.5\.3|daily (user )?sending (limit|quota)|sending limit exceeded|quota exceeded|too many (messages|recipients|emails)|rate limit/i.test(errText(e))
/** Nothing wrong with this address — the mail server itself is unreachable or refusing us. */
const isTransport = e => ['EAUTH', 'ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETLS'].includes(e?.code) || [421, 454].includes(e?.responseCode)
/** This address will never work (unknown user, bad domain) — retrying is pointless. */
const isPermanent = e => /5\.1\.[0-9]|user unknown|no such user|does not exist|invalid (address|recipient|mailbox)|mailbox (not found|unavailable)|address rejected/i.test(errText(e)) || (e?.code === 'EENVELOPE' && (e.responseCode >= 500 || /rejected: 5\d\d/.test(e.message || '')))

async function readSetting(key, fallback) {
    const row = await getDb().first('SELECT value FROM settings WHERE key = ?', [key])
    return { ...fallback, ...parseJson(row?.value, {}) }
}
const writeSetting = (key, value) => getDb().run(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    [key, JSON.stringify(value)])

export async function quotaStatus() {
    const { dailyLimit } = await readSetting('mail_limits', { dailyLimit: DEFAULT_DAILY_LIMIT })
    const q = await readSetting('mail_quota', { date: istDate(), count: 0 })
    const used = q.date === istDate() ? q.count : 0
    return { dailyLimit, used, remaining: Math.max(0, dailyLimit - used) }
}

export async function setDailyLimit(n) {
    const dailyLimit = Math.max(10, Math.min(2000, Math.round(Number(n) || DEFAULT_DAILY_LIMIT)))
    await writeSetting('mail_limits', { dailyLimit })
    return dailyLimit
}

/** Reserve up to `n` sends from today's allowance; returns how many may be sent. */
async function reserve(n) {
    const { used, dailyLimit } = await quotaStatus()
    const allowed = Math.max(0, Math.min(n, dailyLimit - used))
    if (allowed) await writeSetting('mail_quota', { date: istDate(), count: used + allowed })
    return allowed
}

/**
 * Queue a mail-out. recipients: [{ email, vars }] — vars fill {{placeholders}} in subject and body.
 * Duplicate addresses are merged (first one wins).
 */
export async function createCampaign({ kind, label, subject, body, recipients, user, html = '', retryAt = null, retries = 0, note = '' }) {
    const seen = new Set()
    const list = recipients.filter(r => r.email && !seen.has(r.email.toLowerCase()) && seen.add(r.email.toLowerCase()))
    if (!list.length) fail(400, 'Nobody matches this audience.')
    if (!String(subject || '').trim() || !String(body || '').trim()) fail(400, 'Subject and message are required.')
    const json = JSON.stringify(list)
    if (json.length > 1_800_000) fail(413, 'Too many recipients for one mail-out — split it by domain or round.')
    const r = await getDb().run('INSERT INTO email_campaigns (kind, label, subject, body, recipients, total, created_by, html, retry_at, retries, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [kind, String(label || '').slice(0, 200), String(subject).slice(0, 300), String(body).slice(0, 20_000), json, list.length, user?.email || '',
            String(html || '').slice(0, 200_000), retryAt, retries, String(note || '').slice(0, 300)])
    return { id: r.lastId, total: list.length }
}

/**
 * A single email (confirmation, notification…) that could not be sent: keep it and try again in a few
 * minutes. It then follows the same rules as any mail-out (waits for tomorrow when the limit is used up).
 */
export async function queueResend({ kind, recipients, subject, html, text, replyTo }) {
    return createCampaign({
        kind: `resend-${kind}`.slice(0, 60), label: `Resend: ${subject}`, subject, body: text || subject, html,
        recipients: recipients.map(email => ({ email, vars: replyTo ? { _replyTo: replyTo } : {} })),
        user: { email: 'automatic' }, retryAt: later(10), retries: 1, note: 'Could not be sent the first time — retrying automatically.',
    })
}

/** Failed addresses of a mail-out go out again as a new one (manual "Resend failed" or the automatic retry). */
async function requeueFailed(c, failures, { user, auto }) {
    const emails = new Set(failures.map(f => f.email))
    const recipients = parseJson(c.recipients, []).filter(r => emails.has(r.email))
    if (!recipients.length) return null
    return createCampaign({
        kind: c.kind, label: `${auto ? 'Auto-retry' : 'Resend'} of #${c.id}: ${c.label || c.kind}`.slice(0, 200), subject: c.subject, body: c.body, html: c.html || '',
        recipients, user: user || { email: 'automatic' }, retries: (c.retries || 0) + 1, retryAt: auto ? later(20) : null,
        note: auto ? 'These addresses failed the first time — trying once more automatically.' : '',
    })
}

/** Manual resend of everything that failed in one mail-out. */
export async function resendFailed(id, user) {
    const c = await getDb().first('SELECT * FROM email_campaigns WHERE id = ?', [Number(id)])
    if (!c) fail(404, 'Mail-out not found.')
    const failures = parseJson(c.failures, [])
    if (!failures.length) fail(400, 'Nothing failed in this mail-out (or it was already resent).')
    const queued = await requeueFailed(c, failures, { user })
    if (!queued) fail(400, 'Those addresses are no longer in this mail-out.')
    await getDb().run("UPDATE email_campaigns SET failures = '[]', note = ?, updated_at = datetime('now') WHERE id = ?", [`${failures.length} failed — resent in mail-out #${queued.id}.`, c.id])
    return queued
}

/** Send the next batch of the oldest queued mail-out that is due. Safe to call from several tabs at once. */
export async function processCampaigns() {
    const db = getDb()
    const camp = await db.first("SELECT id, kind, label, subject, body, html, total, cursor, retries FROM email_campaigns WHERE status = 'queued' AND (retry_at IS NULL OR retry_at <= datetime('now')) ORDER BY id LIMIT 1")
    if (!camp) {
        const waiting = await db.first("SELECT COUNT(*) n, MIN(retry_at) next FROM email_campaigns WHERE status = 'queued'")
        return waiting.n ? { sent: 0, waiting: true, next: waiting.next } : { idle: true, sent: 0 }
    }
    if (camp.cursor >= camp.total) { await finish(camp.id); return { sent: 0 } }
    const want = Math.min(BATCH, camp.total - camp.cursor)
    const allowed = await reserve(want)
    if (!allowed) return { sent: 0, quotaReached: true }
    // Claim the slice first so a second caller cannot send the same recipients.
    const claim = await db.run("UPDATE email_campaigns SET cursor = ?, updated_at = datetime('now') WHERE id = ? AND cursor = ?", [camp.cursor + allowed, camp.id, camp.cursor])
    if (!claim.changes) { await refund(allowed); return { sent: 0, busy: true } }
    const row = await db.first('SELECT recipients FROM email_campaigns WHERE id = ?', [camp.id])
    const slice = parseJson(row.recipients, []).slice(camp.cursor, camp.cursor + allowed)
    const mailer = await openTransport()
    if (!mailer) {
        await db.run('UPDATE email_campaigns SET cursor = ? WHERE id = ?', [camp.cursor, camp.id])
        await refund(allowed)
        fail(503, 'SMTP is not configured — set it up in Admin → Email & SMTP.')
    }
    let sent = 0
    let done = 0           // recipients dealt with (sent or failed for good) in this slice
    let stop = null        // { limit } | { transport } — the batch could not go on
    const failures = []
    try {
        for (const r of slice) {
            try {
                const subject = fillTemplate(camp.subject, r.vars)
                const text = fillTemplate(camp.body, r.vars)
                await mailer.send({ to: r.email, subject, html: camp.html || messageHtml(subject, text), text, replyTo: r.vars?._replyTo })
                sent++; done++
            } catch (e) {
                if (isProviderLimit(e)) { stop = { limit: true, error: e.message }; break }
                if (isTransport(e)) { stop = { transport: true, error: e.message }; break }
                failures.push({ email: r.email, error: String(e.message).slice(0, 200), permanent: isPermanent(e) || undefined })
                done++
            }
        }
    } finally { mailer.close() }

    const prev = parseJson((await db.first('SELECT failures FROM email_campaigns WHERE id = ?', [camp.id]))?.failures, [])
    const all = [...prev, ...failures].slice(-500)
    let note = null
    if (stop) {
        // Put the unsent part of the slice back; nobody is skipped and nobody gets it twice.
        const unsent = allowed - done
        if (stop.limit) {
            const { dailyLimit } = await quotaStatus()
            await writeSetting('mail_quota', { date: istDate(), count: dailyLimit }) // nothing more today
            note = "Paused: the email provider's daily sending limit is used up. The rest goes out automatically tomorrow."
        } else {
            await refund(unsent)
            note = `Paused: could not reach the mail server (${String(stop.error).slice(0, 120)}). Trying again automatically.`
        }
        await db.run(`UPDATE email_campaigns SET cursor = ?, sent = sent + ?, failed = failed + ?, failures = ?, note = ?, retry_at = ?, updated_at = datetime('now') WHERE id = ?`,
            [camp.cursor + done, sent, failures.length, JSON.stringify(all), note, stop.limit ? null : later(15), camp.id])
    } else {
        await db.run(`UPDATE email_campaigns SET sent = sent + ?, failed = failed + ?, failures = ?, note = CASE WHEN note LIKE 'Paused:%' THEN '' ELSE note END, retry_at = NULL, updated_at = datetime('now') WHERE id = ?`,
            [sent, failures.length, JSON.stringify(all), camp.id])
        if (camp.cursor + allowed >= camp.total) await finish(camp.id)
    }
    await db.run('INSERT INTO email_logs (kind, recipient, subject, status, error) VALUES (?, ?, ?, ?, ?)',
        [camp.kind, `${done} recipients (mail-out #${camp.id})`, camp.subject, failures.length || stop ? 'failed' : 'sent',
            [failures.length ? `${failures.length} failed` : '', stop ? note : ''].filter(Boolean).join(' · ')])
    return { sent, failed: failures.length, campaign: camp.id, ...(stop?.limit ? { quotaReached: true, providerLimit: true } : {}), ...(stop?.transport ? { paused: true, error: stop.error } : {}) }
}

/** Give back allowance that was reserved but not used. */
async function refund(n) {
    if (n <= 0) return
    const q = await readSetting('mail_quota', { date: istDate(), count: 0 })
    if (q.date === istDate()) await writeSetting('mail_quota', { date: q.date, count: Math.max(0, q.count - n) })
}

/**
 * A mail-out reached its last recipient. Addresses that failed for a temporary reason are resent once,
 * automatically, a little later; anything that fails again stays listed for a manual "Resend failed".
 */
async function finish(id) {
    const db = getDb()
    const c = await db.first('SELECT * FROM email_campaigns WHERE id = ?', [id])
    if (!c || c.status !== 'queued') return
    const failures = parseJson(c.failures, [])
    const temporary = failures.filter(f => !f.permanent)
    // A finished mail-out no longer needs its "paused" / "retrying" message.
    let note = failures.length ? '' : (c.retries || 0) > 0 ? 'Delivered on retry.' : ''
    let kept = failures
    if (failures.length) {
        if ((c.retries || 0) === 0 && temporary.length) {
            const q = await requeueFailed(c, temporary, { auto: true }).catch(() => null)
            if (q) {
                kept = failures.filter(f => f.permanent)
                note = `${temporary.length} failed — being resent automatically (mail-out #${q.id}).${kept.length ? ` ${kept.length} address${kept.length > 1 ? 'es look' : ' looks'} wrong and ${kept.length > 1 ? 'were' : 'was'} not retried.` : ''}`
            }
        }
        if (!note) note = `${failures.length} could not be delivered. Check the reasons, then use "Resend failed".`
    }
    await db.run("UPDATE email_campaigns SET status = 'done', failures = ?, note = ?, retry_at = NULL, updated_at = datetime('now') WHERE id = ?", [JSON.stringify(kept), note, id])
}

/** Keep sending batches until the time budget, the queue or today's quota runs out. */
export async function drainCampaigns(budgetMs = 40_000) {
    const t0 = Date.now()
    let sent = 0, last = {}
    while (Date.now() - t0 < budgetMs) {
        last = await processCampaigns()
        sent += last.sent || 0
        if (last.idle || last.quotaReached || last.busy || last.waiting || last.paused) break
    }
    return { ...last, sent }
}

/** One email with attachments (certificates), counted against the daily quota. */
export async function sendDirect({ to, subject, text, attachments }) {
    if (!(await reserve(1))) fail(429, "Today's email limit is used up. Sending continues tomorrow.")
    const mailer = await openTransport()
    if (!mailer) fail(503, 'SMTP is not configured — set it up in Admin → Email & SMTP.')
    try {
        await mailer.send({ to, subject, html: messageHtml(subject, text), text, attachments })
        await getDb().run("INSERT INTO email_logs (kind, recipient, subject, status) VALUES ('certificate', ?, ?, 'sent')", [to, subject])
    } catch (e) {
        await getDb().run("INSERT INTO email_logs (kind, recipient, subject, status, error) VALUES ('certificate', ?, ?, 'failed', ?)", [to, subject, String(e.message).slice(0, 300)])
        fail(502, `Could not send to ${to}: ${e.message}`)
    } finally { mailer.close() }
}
