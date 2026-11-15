/**
 * Connect: members share interview questions / topics (company, year, answer, resource links).
 * Submissions wait for an admin; only approved posts are public. Admins can also add posts by hand.
 */
import { getDb, parseJson } from './db.js'
import { fail, str, safeUrl } from './http.js'
import { sendMail } from './mailer.js'

export const CONNECT_WEEKLY_LIMIT = 5
const KINDS = ['interview', 'topic']
const DIFFICULTY = ['', 'easy', 'medium', 'hard']
const STATUSES = ['pending', 'approved', 'rejected']

/** Resource link type from its address (GitHub, YouTube, LinkedIn, LeetCode…). */
export function linkType(url) {
    const h = (() => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' } })()
    if (/github\.com$/.test(h)) return 'github'
    if (/youtube\.com$|youtu\.be$/.test(h)) return 'youtube'
    if (/linkedin\.com$/.test(h)) return 'linkedin'
    if (/leetcode\.(com|cn)$/.test(h)) return 'leetcode'
    if (/geeksforgeeks\.org$/.test(h)) return 'gfg'
    if (/hackerrank\.com$/.test(h)) return 'hackerrank'
    if (/codeforces\.com$/.test(h)) return 'codeforces'
    if (/medium\.com$|dev\.to$|hashnode\.(dev|com)$/.test(h)) return 'article'
    if (/drive\.google\.com$|docs\.google\.com$/.test(h)) return 'drive'
    return 'link'
}

/** Validates a post from a member or an admin. */
function cleanPost(b, { admin } = {}) {
    const title = str(b.title, 300).trim()
    if (title.length < 8) fail(400, 'Write the question or topic (at least 8 characters).')
    const year = b.year === '' || b.year == null ? null : Math.round(Number(b.year))
    const thisYear = new Date().getFullYear()
    if (year !== null && !(year >= 2000 && year <= thisYear + 1)) fail(400, `Year must be between 2000 and ${thisYear + 1}.`)
    const links = (Array.isArray(b.links) ? b.links : []).map(l => safeUrl(typeof l === 'string' ? l : l?.url)).filter(u => /^https?:\/\//i.test(u)).slice(0, 6)
    const tags = [...new Set((Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(/[,#\n]+/)).map(t => str(t, 30).trim()).filter(Boolean))].slice(0, 8)
    const out = {
        kind: KINDS.includes(b.kind) ? b.kind : 'interview', title,
        answer: str(b.answer, 8000).trim(), company: str(b.company, 80).trim(), role: str(b.role, 80).trim(), year,
        round: str(b.round, 60).trim(), difficulty: DIFFICULTY.includes(b.difficulty) ? b.difficulty : '',
        tags: JSON.stringify(tags), links: JSON.stringify(links.map(url => ({ type: linkType(url), url }))), anonymous: b.anonymous ? 1 : 0,
    }
    if (out.kind === 'interview' && !out.company) fail(400, 'Add the company for an interview question.')
    if (admin) out.author_name = str(b.author_name, 80).trim()
    return out
}

const view = (r, { admin } = {}) => ({
    id: r.id, kind: r.kind, title: r.title, answer: r.answer, company: r.company, role: r.role, year: r.year, round: r.round,
    difficulty: r.difficulty, tags: parseJson(r.tags, []), links: parseJson(r.links, []),
    author: r.anonymous ? 'Anonymous' : (r.author_name || String(r.user_name || '').trim() || 'IEEE ITS VIT'),
    created_at: r.created_at, reviewed_at: r.reviewed_at,
    ...(admin ? { status: r.status, admin_note: r.admin_note, anonymous: !!r.anonymous, author_name: r.author_name, user_id: r.user_id, user_name: r.user_name, user_email: r.user_email, reg_no: r.reg_no } : {}),
})

const SELECT = `SELECT p.*, u.name AS user_name, u.email AS user_email, u.reg_no FROM connect_posts p LEFT JOIN users u ON u.id = p.user_id`

export function installConnect({ route, requireRole, audit, loadSettings }) {
    const db = () => getDb()

    /* Public: approved posts only. */
    route('GET', '/api/connect', async ({ res }) => {
        const rows = await db().all(`${SELECT} WHERE p.status = 'approved' ORDER BY COALESCE(p.reviewed_at, p.created_at) DESC LIMIT 1000`)
        res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=30, stale-while-revalidate=300')
        return { items: rows.map(r => view(r)), weeklyLimit: CONNECT_WEEKLY_LIMIT }
    })

    /* Signed-in member: their own submissions and how many they can still send this week. */
    route('GET', '/api/connect/mine', async ({ user }) => {
        requireRole(user, 'member')
        const rows = await db().all(`${SELECT} WHERE p.user_id = ? ORDER BY p.id DESC LIMIT 100`, [user.id])
        const week = await db().first("SELECT COUNT(*) n FROM connect_posts WHERE user_id = ? AND created_at > datetime('now', '-7 days')", [user.id])
        return { items: rows.map(r => ({ ...view(r), status: r.status, admin_note: r.status === 'rejected' ? r.admin_note : '' })), left: Math.max(0, CONNECT_WEEKLY_LIMIT - week.n) }
    })

    route('POST', '/api/connect', async ({ user, body }) => {
        requireRole(user, 'member')
        const week = await db().first("SELECT COUNT(*) n FROM connect_posts WHERE user_id = ? AND created_at > datetime('now', '-7 days')", [user.id])
        if (week.n >= CONNECT_WEEKLY_LIMIT) fail(429, `You can share up to ${CONNECT_WEEKLY_LIMIT} posts a week. Please try again in a few days.`)
        const p = cleanPost(body)
        const r = await db().run(`INSERT INTO connect_posts (user_id, kind, title, answer, company, role, year, round, difficulty, tags, links, anonymous)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [user.id, p.kind, p.title, p.answer, p.company, p.role, p.year, p.round, p.difficulty, p.tags, p.links, p.anonymous])
        return { ok: true, id: r.lastId, left: Math.max(0, CONNECT_WEEKLY_LIMIT - week.n - 1) }
    })

    /* A member can withdraw a post that has not been reviewed yet. */
    route('DELETE', '/api/connect/mine/:id', async ({ user, params }) => {
        requireRole(user, 'member')
        const r = await db().run("DELETE FROM connect_posts WHERE id = ? AND user_id = ? AND status = 'pending'", [Number(params.id), user.id])
        if (!r.changes) fail(400, 'Only posts still waiting for review can be withdrawn.')
        return { ok: true }
    })

    /* ── admin ── */
    route('GET', '/api/admin/connect', async ({ user }) => {
        requireRole(user, 'editor')
        const rows = await db().all(`${SELECT} ORDER BY p.id DESC LIMIT 3000`)
        return { items: rows.map(r => view(r, { admin: true })) }
    })

    route('POST', '/api/admin/connect', async ({ user, body }) => {
        requireRole(user, 'editor')
        const p = cleanPost(body, { admin: true })
        const status = STATUSES.includes(body.status) ? body.status : 'approved'
        const r = await db().run(`INSERT INTO connect_posts (user_id, kind, title, answer, company, role, year, round, difficulty, tags, links, anonymous, author_name, status, reviewed_by, reviewed_at)
            VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        [p.kind, p.title, p.answer, p.company, p.role, p.year, p.round, p.difficulty, p.tags, p.links, p.anonymous, p.author_name, status, user.id])
        await audit(user, 'create', 'connect', r.lastId, `${p.company ? p.company + ': ' : ''}${p.title.slice(0, 80)} (${status})`)
        return { item: view(await db().first(`${SELECT} WHERE p.id = ?`, [r.lastId]), { admin: true }) }
    })

    route('PUT', '/api/admin/connect/:id', async ({ user, params, body }) => {
        requireRole(user, 'editor')
        const before = await db().first('SELECT * FROM connect_posts WHERE id = ?', [Number(params.id)])
        if (!before) fail(404, 'Post not found.')
        const p = cleanPost({ ...view({ ...before, user_name: '' }, { admin: true }), ...body }, { admin: true })
        const status = STATUSES.includes(body.status) ? body.status : before.status
        const reviewed = status !== before.status
        await db().run(`UPDATE connect_posts SET kind = ?, title = ?, answer = ?, company = ?, role = ?, year = ?, round = ?, difficulty = ?, tags = ?, links = ?, anonymous = ?,
            author_name = ?, status = ?, admin_note = ?, reviewed_by = CASE WHEN ? THEN ? ELSE reviewed_by END, reviewed_at = CASE WHEN ? THEN datetime('now') ELSE reviewed_at END, updated_at = datetime('now') WHERE id = ?`,
        [p.kind, p.title, p.answer, p.company, p.role, p.year, p.round, p.difficulty, p.tags, p.links, p.anonymous, p.author_name, status, str(body.admin_note ?? before.admin_note, 500), reviewed ? 1 : 0, user.id, reviewed ? 1 : 0, before.id])
        await audit(user, reviewed ? status.replace(/ed$/, 'e') : 'update', 'connect', before.id, `${before.title.slice(0, 80)}${reviewed ? ` → ${status}` : ''}`)
        return { item: view(await db().first(`${SELECT} WHERE p.id = ?`, [before.id]), { admin: true }) }
    })

    /* Approve or reject many at once (the weekly review). */
    route('POST', '/api/admin/connect/review', async ({ user, body }) => {
        requireRole(user, 'editor')
        const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(Number).filter(Boolean))].slice(0, 90)
        if (!ids.length || !['approved', 'rejected'].includes(body.status)) fail(400, 'Choose posts and approve or reject.')
        const r = await db().run(`UPDATE connect_posts SET status = ?, admin_note = CASE WHEN ? != '' THEN ? ELSE admin_note END, reviewed_by = ?, reviewed_at = datetime('now'), updated_at = datetime('now')
            WHERE id IN (${ids.map(() => '?').join(',')})`, [body.status, str(body.note, 500), str(body.note, 500), user.id, ...ids])
        await audit(user, body.status === 'approved' ? 'approve' : 'reject', 'connect', ids.join(','), `${r.changes} Connect posts ${body.status}`)
        return { changed: r.changes }
    })

    route('DELETE', '/api/admin/connect/:id', async ({ user, params }) => {
        requireRole(user, 'editor')
        const p = await db().first('SELECT title FROM connect_posts WHERE id = ?', [Number(params.id)])
        if (!p) fail(404, 'Post not found.')
        await db().run('DELETE FROM connect_posts WHERE id = ?', [Number(params.id)])
        await audit(user, 'delete', 'connect', params.id, p.title.slice(0, 80))
        return { ok: true }
    })

    /** Weekly reminder to the admins (from the daily cron, on Mondays): how many Connect posts are waiting. */
    return async function connectDigest({ force } = {}) {
        const now = new Date(Date.now() + 5.5 * 3600_000) // IST
        if (!force && now.getUTCDay() !== 1) return { digest: 'not Monday' }
        const pending = await db().all("SELECT title, company, created_at FROM connect_posts WHERE status = 'pending' ORDER BY id")
        if (!pending.length) return { digest: 'nothing pending' }
        const { notifications, site } = await loadSettings(['notifications', 'site'])
        const to = notifications?.queryRecipients || []
        const base = (site?.url || '').replace(/\/$/, '')
        const list = pending.slice(0, 25).map(p => `<li>${p.company ? `<b>${p.company.replace(/</g, '&lt;')}</b> — ` : ''}${p.title.replace(/</g, '&lt;')}</li>`).join('')
        const r = await sendMail({ kind: 'connect-digest', to, subject: `Connect: ${pending.length} post${pending.length > 1 ? 's' : ''} waiting for review`,
            html: `<p>${pending.length} Connect post${pending.length > 1 ? 's are' : ' is'} waiting for review:</p><ul>${list}</ul>${pending.length > 25 ? `<p>…and ${pending.length - 25} more.</p>` : ''}<p><a href="${base}/admin/connect">Review them in the admin panel</a></p>` })
        return { digest: r.ok ? `sent (${pending.length})` : r.error }
    }
}
