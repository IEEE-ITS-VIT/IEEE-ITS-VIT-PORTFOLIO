/**
 * IEEE ITS API
 *
 *  Public    GET  /api/public/bootstrap        published site content
 *            GET  /api/sitemap.xml · /api/robots.txt
 *            POST /api/queries · /api/subscribe
 *  Auth      POST /api/auth/register · login · logout · password   GET /api/auth/me   PUT /api/auth/profile
 *  Member    POST /api/orders   GET /api/orders/mine
 *  Admin     /api/admin/*  (editor: content, events, moments, media, orders, queries · admin: everything)
 */
import { getDb, parseJson, usingD1 } from './db.js'
import { HttpError, fail, send, readBody, clientIp, str, isEmail, safeUrl, emailList } from './http.js'
import {
    currentUser, publicUser, hashPassword, verifyPassword, passwordProblem, sessionCookie, clearSessionCookie,
    memberTypeFor, assertNotThrottled, recordFailure, clearFailures, encrypt,
    generateOtp, hashOtp, otpMatches, OTP_TTL_MS, OTP_MAX_ATTEMPTS,
} from './auth.js'
import { ensureReady } from './seed.js'
import { notifyOrder, notifyQuery, notifySubscriber, sendMail, smtpConfig, sendPasswordResetCode } from './mailer.js'
import { uploadAuth, deleteFile, imagekitConfigured } from './imagekit.js'
import { DEFAULT_SETTINGS, DEFAULT_PRIVATE_SETTINGS, PUBLIC_SETTING_KEYS } from '../shared/defaults.js'
import { cleanLayout, cleanImageStyle } from '../shared/layout.js'
import { installRecruitment } from './recruit.js'
import { installPortals } from './portals.js'
import { installConnect } from './connect.js'
import { quotaStatus, setDailyLimit, drainCampaigns, createCampaign, resendFailed } from './campaigns.js'
import { CONTENT_TYPES, EVENT_FIELDS, MOMENT_FIELDS, SETTINGS_FORMS, PRIVATE_SETTINGS, slugify, eventStatus, getPath, setPath } from '../shared/cms.js'

/* ───────────── helpers ───────────── */
const nowIso = () => new Date().toISOString().replace('T', ' ').slice(0, 19)

const ROLE_RANK = { member: 1, editor: 2, admin: 3 }
const requireRole = (user, role) => {
    if (!user) fail(401, 'Please sign in.')
    if ((ROLE_RANK[user.role] || 0) < ROLE_RANK[role]) fail(403, 'You do not have permission for this action.')
}

async function audit(user, action, entity, entityId = '', details = '') {
    await getDb().run('INSERT INTO audit_logs (user_id, user_email, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?, ?)',
        [user?.id, user?.email || '', action, entity, String(entityId), String(details).slice(0, 1000)])
}

/** Strip scripts/handlers from admin-authored HTML (the client also sanitises with DOMPurify). */
const cleanHtml = html => String(html || '')
    .replace(/<\s*(script|style|iframe|object|embed|form)[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|iframe|object|embed)[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["']?)\s*(javascript|vbscript|data):[^"'\s>]*/gi, '$1=$2#')

/** The site uses no emoji: pictographs, flags and their joiners are removed from text on save. */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{E0020}-\u{E007F}]|\u{FE0F}|\u{200D}|\u{20E3}/gu
export const stripEmoji = v => (typeof v === 'string' ? v.replace(EMOJI, '').replace(/[ \t]{2,}/g, ' ').replace(/^[ \t]+|[ \t]+$/gm, '') : v)

/** Coerce a value according to its CMS field definition. */
function cleanField(field, value) {
    if (['text', 'textarea', 'html', 'strings', 'rows', undefined].includes(field.type)) value = Array.isArray(value)
        ? value.map(v => (v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stripEmoji(x)])) : stripEmoji(v)))
        : stripEmoji(value)
    switch (field.type) {
        case 'url': return safeUrl(value)
        case 'image': return safeUrl(value)
        case 'file': return safeUrl(value)
        case 'images': return (Array.isArray(value) ? value : []).map(safeUrl).filter(Boolean).slice(0, 200)
        case 'number': return value === '' || value == null ? null : Number(value) || 0
        case 'toggle': return !!value
        case 'html': return cleanHtml(value).slice(0, 200_000)
        case 'textarea': return str(value, 20_000)
        case 'strings': return (Array.isArray(value) ? value : String(value || '').split('\n')).map(v => cleanHtml(str(v, 2000))).filter(Boolean)
        case 'colors': return (Array.isArray(value) ? value : []).map(c => str(c, 30)).filter(c => /^#[0-9a-f]{3,8}$|^[a-z]+$|^rgba?\(/i.test(c))
        case 'select': return field.options?.includes(value) ? value : field.options?.[0] || ''
        case 'rows': return (Array.isArray(value) ? value : []).slice(0, 100).map(row => Object.fromEntries(
            (field.fields || []).map(sf => [sf.name, sf.type === 'url' ? safeUrl(row?.[sf.name]) : str(row?.[sf.name], 1000)])))
        case 'organizers': return (Array.isArray(value) ? value : []).slice(0, 50).map(o => ({
            name: str(o.name, 120),
            role: str(o.role, 120),
            linkedin: safeUrl(o.linkedin),
            image: safeUrl(o.image)
        })).filter(o => o.name)
        case 'date': return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? value : null
        case 'event': return value ? Number(value) || null : null
        case 'color': return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value).toLowerCase() : null
        case 'seo-pages': return value && typeof value === 'object' ? value : {}
        default: return str(value, 2000)
    }
}

function cleanByFields(fields, input) {
    let out = {}
    for (const f of fields) {
        const v = cleanField(f, getPath(input, f.name))
        if (f.required && (v === '' || v == null || (Array.isArray(v) && !v.length))) fail(400, `${f.label} is required.`)
        out = setPath(out, f.name, v)
    }
    return out
}

const isLive = (row, now) => row.status === 'published' && (!row.starts_at || row.starts_at <= now) && (!row.ends_at || row.ends_at >= now)

const contentRow = r => ({ id: r.id, ...parseJson(r.data, {}), _status: r.status, _sort: r.sort_order, _starts_at: r.starts_at, _ends_at: r.ends_at, _updated_at: r.updated_at })

const eventRow = r => ({ ...r, extra: parseJson(r.extra, {}), featured: !!r.featured, show_in_timeline: !!r.show_in_timeline, state: eventStatus(r) })

async function loadSettings(keys) {
    const rows = await getDb().all(`SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`, keys)
    const stored = Object.fromEntries(rows.map(r => [r.key, parseJson(r.value, {})]))
    const defaults = { ...DEFAULT_SETTINGS, ...DEFAULT_PRIVATE_SETTINGS }
    return Object.fromEntries(keys.map(k => [k, deepMerge(defaults[k], stored[k])]))
}

function deepMerge(base, over) {
    if (over === undefined) return base
    if (Array.isArray(over) || typeof over !== 'object' || over === null || typeof base !== 'object' || Array.isArray(base) || !base) return over
    const out = { ...base }
    for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v)
    return out
}

async function loadEvents({ includeDrafts = false } = {}) {
    const rows = await getDb().all(`SELECT * FROM events ${includeDrafts ? '' : "WHERE status = 'published'"} ORDER BY start_date ASC, id ASC`)
    return rows.map(eventRow)
}

async function loadMoments({ includeDrafts = false, events }) {
    const rows = await getDb().all(`SELECT * FROM moments ${includeDrafts ? '' : "WHERE status = 'published'"} ORDER BY sort_order ASC, id ASC`)
    const byId = Object.fromEntries(events.map(e => [e.id, e]))
    return rows.map(r => {
        const ev = byId[r.event_id]
        return {
            ...r, photos: parseJson(r.photos, []), show_on_home: !!r.show_on_home,
            event: ev ? { id: ev.id, slug: ev.slug, title: ev.title, start_date: ev.start_date } : null,
            effective_date: ev?.start_date || r.album_date || '',
        }
    }).sort((a, b) => (b.effective_date || '').localeCompare(a.effective_date || '') || a.sort_order - b.sort_order)
}

/* ───────────── ImageKit cleanup ─────────────
 * When content stops using an uploaded image (item deleted or photo replaced), the file is
 * removed from ImageKit — but only if nothing else on the site still uses it. */
const IK_URL = /https:\/\/ik\.imagekit\.io\/[^"'\s\\)<>]+/g
const imageUrls = (...values) => new Set(values.flatMap(v => String(typeof v === 'string' ? v : JSON.stringify(v ?? '')).match(IK_URL) || []))
const dropped = (before, after) => [...before].filter(u => !after.has(u))

/** Public page where each kind of content appears (for "Used in" links in the Media Library). */
const CONTENT_PAGE = {
    banners: () => '/', popups: () => '/', announcements: () => '/', gallery: () => '/', domains: () => '/', board: () => '/',
    faculty: () => '/faculty', web_team: () => '/web-team', advisory: () => '/advisory-board', vlogs: () => '/vlogs', faqs: () => '/faq', merch: () => '/merch',
    magazines: () => '/blogs', blogs: d => `/blogs/${d.slug || slugify(d.title)}`,
    projects: d => `/projects/${d.slug || slugify(d.title)}`, resources: d => `/resources/${d.slug || slugify(d.title)}`,
}

/** Everywhere an uploaded file (image or document) is used: a label, where to edit it and the public page. */
async function mediaUsage(url) {
    const db = getDb()
    const [content, events, moments, settings, portals, domains] = await Promise.all([
        db.all('SELECT id, type, data FROM content WHERE instr(data, ?) > 0', [url]),
        db.all('SELECT id, slug, title FROM events WHERE instr(poster_url, ?) > 0 OR instr(extra, ?) > 0 OR instr(body_html, ?) > 0', [url, url, url]),
        db.all('SELECT id, title FROM moments WHERE instr(photos, ?) > 0', [url]),
        db.all("SELECT key FROM settings WHERE key != 'image_styles' AND instr(value, ?) > 0", [url]),
        db.all('SELECT id, slug, title FROM ev_portals WHERE instr(config, ?) > 0', [url]).catch(() => []),
        db.all('SELECT id, title FROM rec_domains WHERE instr(description, ?) > 0 OR instr(questions, ?) > 0', [url, url]).catch(() => []),
    ])
    return [
        ...content.map(r => {
            const t = CONTENT_TYPES[r.type]
            const d = parseJson(r.data, {})
            return { label: `${t?.label || r.type}: ${d[t?.title] || 'item'}`, admin: `/admin/c/${r.type}`, page: CONTENT_PAGE[r.type]?.(d) || null }
        }),
        ...events.map(r => ({ label: `Event: ${r.title}`, admin: '/admin/events', page: `/events/${r.slug}` })),
        ...moments.map(r => ({ label: `Album: ${r.title}`, admin: '/admin/moments', page: '/moments' })),
        ...settings.map(r => ({ label: `Settings: ${SETTINGS_FORMS[r.key]?.label || r.key}`, admin: `/admin/s/${r.key}`, page: null })),
        ...portals.map(r => ({ label: `Event portal: ${r.title}`, admin: `/admin/portals/${r.id}`, page: `/e/${r.slug}` })),
        ...domains.map(r => ({ label: `Recruitment domain: ${r.title}`, admin: '/admin/recruitment', page: '/recruitment' })),
    ]
}
const imageUsage = async url => (await mediaUsage(url)).map(u => u.label)

async function releaseImages(user, urls) {
    const db = getDb()
    for (const url of urls) {
        try {
            const m = await db.first('SELECT * FROM media WHERE url = ?', [url])
            if (!m) continue // not uploaded through this site — leave it alone
            if ((await imageUsage(url)).length) continue
            await deleteFile(m.file_id)
            await db.run('DELETE FROM media WHERE id = ?', [m.id])
            await forgetImageStyle(url)
            await audit(user, 'delete', 'media', m.id, `Removed from ImageKit (no longer used): ${m.name || url}`)
        } catch (e) {
            console.error('[media] cleanup failed for', url, e.message)
        }
    }
}

/** Drop the crop settings of an image that no longer exists. */
async function forgetImageStyle(url) {
    const row = await getDb().first("SELECT value FROM settings WHERE key = 'image_styles'")
    const styles = parseJson(row?.value, {})
    if (!styles[url]) return
    delete styles[url]
    await getDb().run("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = 'image_styles'", [JSON.stringify(styles)])
}

/* ───────────── route table ───────────── */
const routes = []
const route = (method, pattern, handler) => {
    const keys = []
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)' }) + '/?$')
    routes.push({ method, re, keys, handler })
}

/* ── public ── */
route('GET', '/api/health', async () => ({ ok: true, database: usingD1() ? 'cloudflare-d1' : 'local-sqlite', imagekit: imagekitConfigured() }))

route('GET', '/api/public/bootstrap', async ({ res }) => {
    const db = getDb()
    const now = nowIso()
    const [settings, contentRows, events] = await Promise.all([
        loadSettings(PUBLIC_SETTING_KEYS),
        db.all('SELECT * FROM content ORDER BY type, sort_order ASC, id ASC'),
        loadEvents(),
    ])
    const moments = await loadMoments({ events })
    const content = Object.fromEntries(Object.keys(CONTENT_TYPES).map(t => [t, []]))
    for (const r of contentRows) if (content[r.type] && isLive(r, now)) content[r.type].push(contentRow(r))
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=30, stale-while-revalidate=300')
    return { settings, content, events, moments, generatedAt: new Date().toISOString() }
})

/* Sitemap URLs must be on the host the sitemap is fetched from (Search Console rejects others),
   so use the requesting host and fall back to the admin-set site URL. */
const siteBase = (site, req) => {
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim()
    const proto = /^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? 'http' : 'https'
    return (host ? `${proto}://${host}` : site.url || '').replace(/\/$/, '')
}

/*
 * /sitemap.xml — built from the database, so new events, blogs and event portals appear automatically.
 * Includes last-modified dates, change frequency and event posters as image entries.
 */
route('GET', '/api/sitemap.xml', async ({ req, res }) => {
    const db = getDb()
    const [{ site, recruitment }, events, blogs, portals, touched] = await Promise.all([
        loadSettings(['site', 'recruitment']), loadEvents(),
        db.all("SELECT type, data, updated_at FROM content WHERE type IN ('blogs', 'projects', 'resources') AND status = 'published'"),
        db.all("SELECT slug, title, config, updated_at FROM ev_portals WHERE status != 'draft'"),
        db.first("SELECT MAX(t) t FROM (SELECT MAX(updated_at) t FROM content UNION ALL SELECT MAX(updated_at) FROM settings UNION ALL SELECT MAX(updated_at) FROM events)"),
    ])
    const base = siteBase(site, req)
    const day = v => (v ? String(v).slice(0, 10) : undefined)
    const siteDay = day(touched?.t) || new Date().toISOString().slice(0, 10)
    const abs = u => (!u ? '' : /^https?:/i.test(u) ? u : `${base}${u.startsWith('/') ? '' : '/'}${u}`)
    const pages = [
        ['/', '1.0', 'weekly'], ['/timeline', '0.9', 'weekly'], ['/moments', '0.7', 'monthly'], ['/blogs', '0.7', 'weekly'],
        ['/vlogs', '0.6', 'monthly'], ['/faculty', '0.6', 'yearly'], ['/advisory-board', '0.6', 'yearly'], ['/connect', '0.7', 'weekly'], ['/projects', '0.8', 'weekly'], ['/web-team', '0.5', 'yearly'], ['/merch', '0.6', 'monthly'],
        ['/games', '0.4', 'yearly'], ['/faq', '0.6', 'monthly'], ['/join', '0.7', 'monthly'], ['/contact', '0.6', 'yearly'],
        ['/suggestions', '0.4', 'yearly'], ...(recruitment?.open ? [['/recruitment', '0.9', 'daily']] : []),
    ]
    const urls = [
        ...pages.map(([p, priority, changefreq]) => ({ loc: base + p, lastmod: siteDay, changefreq, priority })),
        ...events.map(e => ({
            loc: `${base}/events/${e.slug}`, lastmod: day(e.updated_at), changefreq: e.state === 'past' ? 'yearly' : 'weekly',
            priority: e.state === 'upcoming' ? '0.9' : e.state === 'ongoing' ? '0.8' : '0.5', image: abs(e.poster_url), title: e.title,
        })),
        ...portals.map(p => {
            const c = parseJson(p.config, {})
            return { loc: `${base}/e/${p.slug}`, lastmod: day(p.updated_at), changefreq: 'daily', priority: '0.8', image: abs(c.banner), title: p.title }
        }),
        ...blogs.map(b => {
            const d = parseJson(b.data, {})
            const path = { blogs: 'blogs', projects: 'projects', resources: 'resources' }[b.type]
            return { loc: `${base}/${path}/${d.slug || slugify(d.title)}`, lastmod: day(b.updated_at), changefreq: 'monthly', priority: b.type === 'blogs' ? '0.6' : '0.7', image: abs(d.image || d.diagram), title: d.title }
        }),
    ]
    const x = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]))
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${urls.map(u => `  <url>
    <loc>${x(u.loc)}</loc>${u.lastmod ? `\n    <lastmod>${u.lastmod}</lastmod>` : ''}
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>${u.image ? `\n    <image:image><image:loc>${x(u.image)}</image:loc>${u.title ? `<image:title>${x(u.title)}</image:title>` : ''}</image:image>` : ''}
  </url>`).join('\n')}
</urlset>
`
    send(res, 200, xml, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400' })
})

/* /robots.txt — crawl the public site; keep private and personal pages out of search results. */
route('GET', '/api/robots.txt', async ({ req, res }) => {
    const { site } = await loadSettings(['site'])
    const base = siteBase(site, req)
    const txt = `# IEEE ITS - VIT Chapter — ${base}
User-agent: *
Allow: /
Allow: /sitemap.xml
Disallow: /admin
Disallow: /api/
Disallow: /login
Disallow: /recruitment/test/
Disallow: /e/*/judge

Sitemap: ${base}/sitemap.xml
`
    send(res, 200, txt, { 'Cache-Control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400' })
})

route('POST', '/api/queries', async ({ req, body, user }) => {
    if (body.website) return { ok: true } // honeypot
    const kind = ['query', 'suggestion', 'contact'].includes(body.kind) ? body.kind : 'query'
    if (kind === 'suggestion' && !user) fail(401, 'Please sign in to share suggestions.')
    const ipKey = [`query:${clientIp(req)}`]
    await assertNotThrottled(ipKey)
    const q = {
        kind, user_id: user?.id || null,
        name: str(user?.name || body.name, 120), email: str(user?.email || body.email, 200).toLowerCase(),
        subject: str(body.subject, 200), message: str(body.message, 5000),
    }
    if (!isEmail(q.email)) fail(400, 'Please enter a valid email address.')
    if (q.message.length < 3) fail(400, 'Please enter a message.')
    await recordFailure(ipKey) // counts submissions per IP per 15 minutes
    const r = await getDb().run('INSERT INTO queries (user_id, kind, name, email, subject, message) VALUES (?, ?, ?, ?, ?, ?)',
        [q.user_id, q.kind, q.name, q.email, q.subject, q.message])
    const saved = await getDb().first('SELECT * FROM queries WHERE id = ?', [r.lastId])
    await notifyQuery(saved).catch(e => console.error('[mail]', e.message))
    return { ok: true, id: r.lastId }
})

route('POST', '/api/subscribe', async ({ body }) => {
    const email = str(body.email, 200).toLowerCase()
    const list = body.list === 'vlogs' ? 'vlogs' : 'newsletter'
    if (!isEmail(email)) fail(400, 'Please enter a valid email address.')
    const r = await getDb().run('INSERT OR IGNORE INTO subscribers (email, list) VALUES (?, ?)', [email, list])
    if (r.changes) await notifySubscriber(email, list)?.catch?.(() => {})
    return { ok: true, already: !r.changes }
})

/* ── auth ── */
/* Accounts created by an admin (recruitment "add directly" or Excel import) have no password yet. */
const INVITED = 'invited'
const SET_PASSWORD_MSG = 'Welcome! IEEE ITS VIT has already created an account for this email. Set your password to sign in — we will email you a 6-digit code (if it is not in your inbox, check your Spam / Junk folder).'

route('POST', '/api/auth/register', async ({ req, res, body }) => {
    const name = str(body.name, 120)
    const email = str(body.email, 200).toLowerCase()
    if (name.length < 2) fail(400, 'Please enter your full name.')
    if (!isEmail(email)) fail(400, 'Please enter a valid email address.')
    const problem = passwordProblem(body.password)
    if (problem) fail(400, problem)
    await assertNotThrottled([`ip:${clientIp(req)}`])
    const db = getDb()
    const existing = await db.first('SELECT id, password_hash FROM users WHERE email = ?', [email])
    // An admin-created account is claimed by proving the email with a code, never by simply registering over it.
    if (existing?.password_hash === INVITED) fail(409, SET_PASSWORD_MSG, 'SET_PASSWORD')
    if (existing) fail(409, 'An account with this email already exists. Please sign in.')
    const r = await db.run(
        'INSERT INTO users (name, email, password_hash, mobile, reg_no, member_type, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [name, email, await hashPassword(body.password), str(body.mobile, 15).replace(/\D/g, '').slice(0, 10), str(body.regNo, 12).toUpperCase(), memberTypeFor(email), nowIso()]
    )
    const user = await db.first('SELECT * FROM users WHERE id = ?', [r.lastId])
    await db.run("INSERT INTO activity_logs (user_id, email, type) VALUES (?, ?, 'REGISTER')", [user.id, email])
    res.setHeader('Set-Cookie', sessionCookie(req, user))
    return { user: publicUser(user) }
})

route('POST', '/api/auth/login', async ({ req, res, body }) => {
    const email = str(body.email, 200).toLowerCase()
    const keys = [`ip:${clientIp(req)}`, `email:${email}`]
    await assertNotThrottled(keys)
    const db = getDb()
    const user = await db.first('SELECT * FROM users WHERE email = ?', [email])
    if (user?.password_hash === INVITED && user.active) fail(409, SET_PASSWORD_MSG, 'SET_PASSWORD')
    const ok = user && await verifyPassword(String(body.password || ''), user.password_hash)
    if (!ok) { await recordFailure(keys); fail(401, 'Incorrect email or password.') }
    if (!user.active) fail(403, 'This account has been disabled. Please contact the chapter.')
    await clearFailures([`email:${email}`])
    await db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [nowIso(), user.id])
    await db.run("INSERT INTO activity_logs (user_id, email, type) VALUES (?, ?, 'LOGIN')", [user.id, email])
    res.setHeader('Set-Cookie', sessionCookie(req, user))
    return { user: publicUser(user) }
})

route('POST', '/api/auth/logout', async ({ req, res }) => {
    res.setHeader('Set-Cookie', clearSessionCookie(req))
    return { ok: true }
})

route('GET', '/api/auth/me', async ({ user, res }) => {
    res.setHeader('Cache-Control', 'no-store')
    return { user: publicUser(user) }
})

route('PUT', '/api/auth/profile', async ({ user, body }) => {
    requireRole(user, 'member')
    const name = str(body.name, 120) || user.name
    const mobile = str(body.mobile, 15).replace(/\D/g, '').slice(0, 10)
    const regNo = str(body.regNo, 12).toUpperCase()
    if (mobile && mobile.length !== 10) fail(400, 'Mobile number must be 10 digits.')
    await getDb().run("UPDATE users SET name = ?, mobile = ?, reg_no = ?, avatar_url = ?, updated_at = datetime('now') WHERE id = ?",
        [name, mobile, regNo, safeUrl(body.picture ?? user.avatar_url), user.id])
    return { user: publicUser(await getDb().first('SELECT * FROM users WHERE id = ?', [user.id])) }
})

/* ───────────── Web Team Likhith Protection ───────────── */
async function getWebteamProtection() {
    const db = getDb()
    let row = await db.first("SELECT value FROM settings WHERE key = 'webteam_protection'")
    if (!row) {
        const hash = await hashPassword('2007')
        const initial = { password_hash: hash, enabled: true, member_name: 'Likhith' }
        await db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('webteam_protection', ?)", [JSON.stringify(initial)])
        return initial
    }
    return parseJson(row.value, { password_hash: '', enabled: true })
}

function isLikhith(rowOrData) {
    if (!rowOrData) return false
    const strVal = typeof rowOrData === 'string' ? rowOrData : JSON.stringify(rowOrData)
    return /likhith/i.test(strVal)
}

route('GET', '/api/auth/webteam-protection', async ({ user }) => {
    requireRole(user, 'member')
    if (user?.email?.toLowerCase() !== 'liki123456m@gmail.com') fail(403, 'Forbidden')
    const prot = await getWebteamProtection()
    return { ok: true, enabled: !!prot.enabled }
})

route('POST', '/api/auth/webteam-protection/verify', async ({ user, body }) => {
    requireRole(user, 'editor')
    const prot = await getWebteamProtection()
    if (!prot.enabled) return { ok: true, valid: true }
    const pw = body?.password || ''
    if (!pw || !(await verifyPassword(pw, prot.password_hash))) {
        fail(403, 'Incorrect password.')
    }
    return { ok: true, valid: true }
})

route('PUT', '/api/auth/webteam-protection', async ({ user, body }) => {
    requireRole(user, 'member')
    if (user?.email?.toLowerCase() !== 'liki123456m@gmail.com') fail(403, 'Only liki123456m@gmail.com can manage Web Team password protection.')
    const prot = await getWebteamProtection()
    const db = getDb()

    if (body.enabled !== undefined && body.enabled !== prot.enabled) {
        if (!body.currentPassword || !(await verifyPassword(body.currentPassword, prot.password_hash))) {
            fail(400, 'Current password is required to change protection status.')
        }
        prot.enabled = !!body.enabled
    }

    if (body.newPassword) {
        if (!body.currentPassword || !(await verifyPassword(body.currentPassword, prot.password_hash))) {
            fail(400, 'Current password is incorrect.')
        }
        if (typeof body.newPassword !== 'string' || body.newPassword.length < 3) {
            fail(400, 'New password must be at least 3 characters.')
        }
        prot.password_hash = await hashPassword(body.newPassword)
    }

    await db.run("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = 'webteam_protection'",
        [JSON.stringify(prot)])
    await audit(user, 'update', 'webteam_protection', '', `Web team protection enabled: ${prot.enabled}`)
    return { ok: true, enabled: !!prot.enabled, message: 'Web team protection updated successfully.' }
})

/* Forgot password: email a 6-digit code. The response never reveals whether the account exists. */
route('POST', '/api/auth/forgot', async ({ req, body }) => {
    const email = str(body.email, 200).toLowerCase()
    if (!isEmail(email)) fail(400, 'Please enter a valid email address.')
    const smtp = await smtpConfig('auth')
    if (!smtp.host || !smtp.user || !smtp.pass) fail(503, 'Password reset by email is not available right now. Please contact the chapter.')
    const keys = [`reset-ip:${clientIp(req)}`, `reset-email:${email}`]
    await assertNotThrottled(keys)
    await recordFailure(keys) // counts requests per IP and per email (15-minute window)
    const db = getDb()
    const user = await db.first('SELECT * FROM users WHERE email = ? AND active = 1', [email])
    if (user) {
        const code = generateOtp()
        await db.run('UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0', [user.id])
        await db.run('INSERT INTO password_resets (user_id, code_hash, expires_at) VALUES (?, ?, ?)', [user.id, hashOtp(code, user.id), Date.now() + OTP_TTL_MS])
        const site = (await loadSettings(['site'])).site
        const base = (site.url || `https://${req.headers['x-forwarded-host'] || req.headers.host}`).replace(/\/$/, '')
        const setup = user.password_hash === INVITED
        const link = `${base}/login?mode=forgot${setup ? '&setup=1' : ''}&email=${encodeURIComponent(user.email)}&code=${code}`
        const sent = await sendPasswordResetCode(user, code, link, { setup })
        if (!sent.ok) console.error('[reset] email failed:', sent.error)
    }
    return { ok: true, message: 'If an account exists for that email, a 6-digit code is on its way. Not in your inbox within a minute? Check your Spam / Junk folder (and Promotions in Gmail).' }
})

route('POST', '/api/auth/reset', async ({ req, res, body }) => {
    const email = str(body.email, 200).toLowerCase()
    const code = str(body.code, 10).replace(/\s/g, '')
    if (!/^\d{6}$/.test(code)) fail(400, 'Enter the 6-digit code from the email.')
    const problem = passwordProblem(body.password)
    if (problem) fail(400, problem)
    const ipKey = [`reset-verify-ip:${clientIp(req)}`]
    await assertNotThrottled(ipKey)
    const db = getDb()
    const user = await db.first('SELECT * FROM users WHERE email = ? AND active = 1', [email])
    const reset = user && await db.first('SELECT * FROM password_resets WHERE user_id = ? AND used = 0 ORDER BY id DESC LIMIT 1', [user.id])
    const invalid = async () => { await recordFailure(ipKey); fail(400, 'That code is invalid or has expired. Request a new one.') }
    if (!reset || reset.expires_at < Date.now() || reset.attempts >= OTP_MAX_ATTEMPTS) return invalid()
    if (!otpMatches(code, user.id, reset.code_hash)) {
        await db.run('UPDATE password_resets SET attempts = attempts + 1 WHERE id = ?', [reset.id])
        return invalid()
    }
    await db.run('UPDATE password_resets SET used = 1 WHERE user_id = ?', [user.id])
    await db.run("UPDATE users SET password_hash = ?, token_version = token_version + 1, last_login_at = ?, updated_at = datetime('now') WHERE id = ?",
        [await hashPassword(body.password), nowIso(), user.id])
    await clearFailures([`email:${email}`, `reset-email:${email}`])
    await db.run("INSERT INTO activity_logs (user_id, email, type) VALUES (?, ?, 'PASSWORD_RESET')", [user.id, email])
    const fresh = await db.first('SELECT * FROM users WHERE id = ?', [user.id])
    res.setHeader('Set-Cookie', sessionCookie(req, fresh))
    return { user: publicUser(fresh) }
})

route('POST', '/api/auth/password', async ({ req, res, user, body }) => {
    requireRole(user, 'member')
    if (!await verifyPassword(String(body.current || ''), user.password_hash)) fail(400, 'Current password is incorrect.')
    const problem = passwordProblem(body.next)
    if (problem) fail(400, problem)
    await getDb().run("UPDATE users SET password_hash = ?, token_version = token_version + 1, updated_at = datetime('now') WHERE id = ?",
        [await hashPassword(body.next), user.id])
    const fresh = await getDb().first('SELECT * FROM users WHERE id = ?', [user.id])
    res.setHeader('Set-Cookie', sessionCookie(req, fresh))
    return { ok: true }
})

/* ── member: orders ── */
route('POST', '/api/orders', async ({ user, body }) => {
    requireRole(user, 'member')
    const db = getDb()
    const [{ merch: cfg }, itemRow] = await Promise.all([
        loadSettings(['merch']),
        db.first("SELECT * FROM content WHERE type = 'merch' AND id = ? AND status = 'published'", [Number(body.itemId)]),
    ])
    if (!itemRow) fail(404, 'This product is no longer available.')
    const item = parseJson(itemRow.data, {})
    if (item.comingSoon) fail(400, 'This product is not open for booking yet.')
    const size = str(body.size, 10)
    if (!cfg.sizes.includes(size)) fail(400, 'Please choose a size.')
    const qty = Math.max(1, Math.min(Number(cfg.maxQty) || 5, Math.floor(Number(body.qty) || 1)))
    if (cfg.requireMobile && !user.mobile) fail(400, 'MOBILE_REQUIRED')
    const colors = item.colors || []
    const color = colors.includes(body.color) ? body.color : colors[0] || ''
    const price = Number(item.price) || 0
    const r = await db.run(
        'INSERT INTO orders (user_id, name, email, mobile, reg_no, item_id, item, size, color, qty, unit_price, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [user.id, user.name, user.email, user.mobile, user.reg_no, itemRow.id, item.name, size, color, qty, price, price * qty]
    )
    const order = await db.first('SELECT * FROM orders WHERE id = ?', [r.lastId])
    await notifyOrder(order).catch(e => console.error('[mail]', e.message))
    return { order }
})

route('GET', '/api/orders/mine', async ({ user, res }) => {
    requireRole(user, 'member')
    res.setHeader('Cache-Control', 'no-store')
    return { orders: await getDb().all('SELECT * FROM orders WHERE user_id = ? OR email = ? ORDER BY id DESC', [user.id, user.email]) }
})

/* ── admin: dashboard ── */
route('GET', '/api/admin/stats', async ({ user }) => {
    requireRole(user, 'editor')
    const db = getDb()
    const one = sql => db.first(sql).then(r => r?.n || 0)
    const [users, orders, newOrders, queries, newQueries, subscribers, events] = await Promise.all([
        one('SELECT COUNT(*) n FROM users'), one('SELECT COUNT(*) n FROM orders'), one("SELECT COUNT(*) n FROM orders WHERE status = 'Booked'"),
        one('SELECT COUNT(*) n FROM queries'), one("SELECT COUNT(*) n FROM queries WHERE status = 'New'"),
        one('SELECT COUNT(*) n FROM subscribers'), loadEvents({ includeDrafts: true }),
    ])
    const [recentOrders, recentQueries, recentAudit, emailFailures] = await Promise.all([
        db.all('SELECT * FROM orders ORDER BY id DESC LIMIT 5'), db.all('SELECT * FROM queries ORDER BY id DESC LIMIT 5'),
        db.all('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 8'), one("SELECT COUNT(*) n FROM email_logs WHERE status != 'sent' AND created_at > datetime('now', '-7 days')"),
    ])
    const smtp = await smtpConfig()
    return {
        counts: { users, orders, newOrders, queries, newQueries, subscribers, events: events.length, upcoming: events.filter(e => e.state !== 'past').length },
        upcoming: events.filter(e => e.state !== 'past').slice(0, 5),
        recentOrders, recentQueries, recentAudit, emailFailures,
        integrations: { database: usingD1() ? 'Cloudflare D1' : 'Local SQLite (dev)', imagekit: imagekitConfigured(), smtp: !!(smtp.host && smtp.user && smtp.pass) },
    }
})

/* ── admin: generic content ── */
const typeDef = type => CONTENT_TYPES[type] || fail(404, 'Unknown content type')

route('GET', '/api/admin/content/:type', async ({ user, params }) => {
    requireRole(user, 'editor'); typeDef(params.type)
    const rows = await getDb().all('SELECT * FROM content WHERE type = ? ORDER BY sort_order ASC, id ASC', [params.type])
    return { items: rows.map(contentRow) }
})

function contentMeta(body) {
    return {
        status: body.status === 'draft' ? 'draft' : 'published',
        starts_at: body.starts_at ? str(body.starts_at, 25).replace('T', ' ') : null,
        ends_at: body.ends_at ? str(body.ends_at, 25).replace('T', ' ') : null,
    }
}

function prepareContent(type, data) {
    const def = typeDef(type)
    const clean = cleanByFields(def.fields, data || {})
    if (type === 'blogs') clean.slug = slugify(clean.slug || clean.title)
    return clean
}

route('POST', '/api/admin/content/:type', async ({ req, user, params, body }) => {
    requireRole(user, 'editor')
    const data = prepareContent(params.type, body.data)
    const meta = contentMeta(body)
    if (params.type === 'web_team' && isLikhith(data)) {
        const prot = await getWebteamProtection()
        if (prot.enabled) {
            const pw = req.headers['x-admin-password'] || body?.admin_password || body?.password
            if (!pw || !(await verifyPassword(pw, prot.password_hash))) {
                fail(403, 'Password required to add or edit Likhith Medarametla in Web Team.')
            }
        }
    }
    const db = getDb()
    const max = await db.first('SELECT COALESCE(MAX(sort_order), -1) AS m FROM content WHERE type = ?', [params.type])
    const r = await db.run('INSERT INTO content (type, data, sort_order, status, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, ?)',
        [params.type, JSON.stringify(data), max.m + 1, meta.status, meta.starts_at, meta.ends_at])
    await audit(user, 'create', params.type, r.lastId, data[CONTENT_TYPES[params.type].title] || '')
    return { item: contentRow(await db.first('SELECT * FROM content WHERE id = ?', [r.lastId])) }
})

route('PUT', '/api/admin/content/:type/:id', async ({ req, user, params, body }) => {
    requireRole(user, 'editor')
    const data = prepareContent(params.type, body.data)
    const meta = contentMeta(body)
    const db = getDb()
    const before = await db.first('SELECT data FROM content WHERE id = ? AND type = ?', [Number(params.id), params.type])
    if (!before) fail(404, 'Item not found')

    if (params.type === 'web_team' && (isLikhith(before.data) || isLikhith(body?.data))) {
        const prot = await getWebteamProtection()
        if (prot.enabled) {
            const pw = req.headers['x-admin-password'] || body?.admin_password || body?.password
            if (!pw || !(await verifyPassword(pw, prot.password_hash))) {
                fail(403, 'Password required to edit, change, or disable Likhith Medarametla in Web Team.')
            }
        }
    }
    await db.run("UPDATE content SET data = ?, status = ?, starts_at = ?, ends_at = ?, updated_at = datetime('now') WHERE id = ? AND type = ?",
        [JSON.stringify(data), meta.status, meta.starts_at, meta.ends_at, Number(params.id), params.type])
    await audit(user, 'update', params.type, params.id, data[CONTENT_TYPES[params.type].title] || '')
    await releaseImages(user, dropped(imageUrls(before.data), imageUrls(data)))
    return { item: contentRow(await db.first('SELECT * FROM content WHERE id = ?', [Number(params.id)])) }
})

route('DELETE', '/api/admin/content/:type/:id', async ({ req, user, params, body }) => {
    requireRole(user, 'editor'); typeDef(params.type)
    const before = await getDb().first('SELECT data FROM content WHERE id = ? AND type = ?', [Number(params.id), params.type])
    if (!before) fail(404, 'Item not found')

    if (params.type === 'web_team' && isLikhith(before.data)) {
        const prot = await getWebteamProtection()
        if (prot.enabled) {
            const pw = req.headers['x-admin-password'] || body?.admin_password || body?.password || (req.url && req.url.includes('password=') ? new URL(req.url, 'http://l').searchParams.get('password') : null)
            if (!pw || !(await verifyPassword(pw, prot.password_hash))) {
                fail(403, 'Password required to delete Likhith Medarametla in Web Team.')
            }
        }
    }
    await getDb().run('DELETE FROM content WHERE id = ? AND type = ?', [Number(params.id), params.type])
    await audit(user, 'delete', params.type, params.id)
    await releaseImages(user, imageUrls(before.data))
    return { ok: true }
})

/* ── Move Board Member(s) to Advisory Board ── */
route('POST', '/api/admin/board/move-to-advisory', async ({ user, body }) => {
    requireRole(user, 'editor')
    const db = getDb()
    const year = String(body?.year || '').trim()
    if (!year) fail(400, 'Board year is required (e.g. 2024-2025).')
    const keepCopy = !!body?.keepCopy

    if (body?.all) {
        const boardRows = await db.all("SELECT * FROM content WHERE type = 'board' ORDER BY sort_order ASC, id ASC")
        if (!boardRows.length) return { ok: true, count: 0, message: 'No board members to move.' }

        const maxAdv = await db.first("SELECT COALESCE(MAX(sort_order), -1) AS m FROM content WHERE type = 'advisory'")
        let sortOrder = (maxAdv?.m ?? -1) + 1

        for (const row of boardRows) {
            const b = parseJson(row.data, {})
            const advData = {
                year,
                group: 'Board',
                name: b.name || '',
                role: b.role || '',
                initials: b.initials || '',
                image: b.image || '',
                focus: b.focus || '',
                linkedin: b.linkedin || '',
                instagram: b.instagram || ''
            }
            await db.run(
                "INSERT INTO content (type, data, sort_order, status, starts_at, ends_at) VALUES ('advisory', ?, ?, 'published', null, null)",
                [JSON.stringify(advData), sortOrder++]
            )
        }

        if (!keepCopy) {
            await db.run("DELETE FROM content WHERE type = 'board'")
        }

        await audit(user, 'move_to_advisory', 'board', 'all', `Moved ${boardRows.length} board members to Advisory Board (${year})`)
        return { ok: true, count: boardRows.length, year, message: `Moved ${boardRows.length} board members to Advisory Board (${year}). Current board is now blank.` }
    }

    const id = Number(body?.id)
    if (!id) fail(400, 'Board member id is required.')
    const row = await db.first("SELECT * FROM content WHERE id = ? AND type = 'board'", [id])
    if (!row) fail(404, 'Board member not found.')

    const b = parseJson(row.data, {})
    const advData = {
        year,
        group: 'Board',
        name: b.name || '',
        role: b.role || '',
        initials: b.initials || '',
        image: b.image || '',
        focus: b.focus || '',
        linkedin: b.linkedin || '',
        instagram: b.instagram || ''
    }

    const maxAdv = await db.first("SELECT COALESCE(MAX(sort_order), -1) AS m FROM content WHERE type = 'advisory'")
    const sortOrder = (maxAdv?.m ?? -1) + 1

    const r = await db.run(
        "INSERT INTO content (type, data, sort_order, status, starts_at, ends_at) VALUES ('advisory', ?, ?, 'published', null, null)",
        [JSON.stringify(advData), sortOrder]
    )

    if (!keepCopy) {
        await db.run("DELETE FROM content WHERE id = ? AND type = 'board'", [id])
    }

    await audit(user, 'move_to_advisory', 'board', String(id), `Moved "${b.name}" to Advisory Board (${year})`)
    return { ok: true, id: r.lastId, count: 1, year, message: `Moved "${b.name}" to Advisory Board (${year}).` }
})

/*
 * "New blog post / new magazine issue" emails. Audience: every active registered user, newsletter
 * subscribers, and/or custom addresses (separated by spaces, commas or new lines), de-duplicated.
 * Queued in the Outbox so large lists go out within the daily email limit.
 */
const ANNOUNCE_TYPES = ['blogs', 'magazines', 'connect']
route('GET', '/api/admin/announce/audience', async ({ user }) => {
    requireRole(user, 'editor')
    const db = getDb()
    const [u, s] = await Promise.all([
        db.first("SELECT COUNT(*) n FROM users WHERE active = 1 AND password_hash != 'invited'"),
        db.first("SELECT COUNT(*) n FROM subscribers WHERE list = 'newsletter'"),
    ])
    return { users: u.n, subscribers: s.n }
})

route('POST', '/api/admin/announce', async ({ req, user, body }) => {
    requireRole(user, 'editor')
    if (!ANNOUNCE_TYPES.includes(body.type)) fail(400, 'Only blog posts, magazines and Connect posts can be emailed.')
    const db = getDb()
    const { site } = await loadSettings(['site'])
    const base = (site.url || `https://${req.headers['x-forwarded-host'] || req.headers.host}`).replace(/\/$/, '')
    let d, link, extra = {}
    if (body.type === 'connect') {
        // Published Connect posts: the chosen ones, or everything published in the last 7 days.
        const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(Number).filter(Boolean))].slice(0, 90)
        const posts = ids.length
            ? await db.all(`SELECT title, company, year FROM connect_posts WHERE status = 'approved' AND id IN (${ids.map(() => '?').join(',')}) ORDER BY reviewed_at DESC`, ids)
            : await db.all("SELECT title, company, year FROM connect_posts WHERE status = 'approved' AND reviewed_at > datetime('now', '-7 days') ORDER BY reviewed_at DESC LIMIT 50")
        if (!posts.length) fail(400, ids.length ? 'None of those posts are published yet — publish them first.' : 'Nothing was published on Connect in the last 7 days.')
        const shown = posts.slice(0, 15)
        d = { title: `${posts.length} new on Connect` }
        link = `${base}/connect`
        extra = {
            count: String(posts.length),
            list: shown.map(p => `• ${p.company ? `${p.company}${p.year ? ` (${p.year})` : ''} — ` : ''}${p.title}`).join('\n') + (posts.length > shown.length ? `\n…and ${posts.length - shown.length} more` : ''),
            companies: [...new Set(posts.map(p => p.company).filter(Boolean))].slice(0, 8).join(', '),
        }
    } else {
        const row = await db.first("SELECT data FROM content WHERE id = ? AND type = ?", [Number(body.id), body.type])
        if (!row) fail(404, 'Item not found.')
        d = parseJson(row.data, {})
        const isPdf = /\.pdf(?:[?#]|$)/i.test(d.url || '') && /^https:\/\/ik\.imagekit\.io\//.test(d.url || '')
        link = body.type === 'blogs' ? `${base}/blogs/${d.slug || slugify(d.title)}`
            : isPdf ? `${base}/view?file=${encodeURIComponent(d.url)}&title=${encodeURIComponent(d.title || 'Magazine')}`
                : d.url ? (/^https?:/.test(d.url) ? d.url : `${base}${d.url}`) : `${base}/blogs`
    }

    const people = new Map() // email -> name
    const add = (email, name = '') => { const e = String(email || '').trim().toLowerCase(); if (isEmail(e) && !people.has(e)) people.set(e, name) }
    const aud = Array.isArray(body.audiences) ? body.audiences : []
    if (aud.includes('users')) for (const u of await db.all("SELECT name, email FROM users WHERE active = 1 AND password_hash != 'invited'")) add(u.email, u.name)
    if (aud.includes('subscribers')) for (const r of await db.all("SELECT email FROM subscribers WHERE list = 'newsletter'")) add(r.email)
    const custom = String(body.custom || '').split(/[\s,;]+/).filter(Boolean)
    const bad = custom.filter(e => !isEmail(e.toLowerCase()))
    if (bad.length) fail(400, `Not valid email address${bad.length > 1 ? 'es' : ''}: ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? '…' : ''}`)
    for (const e of custom.slice(0, 5000)) add(e)
    if (!people.size) fail(400, 'Choose who to email: all users, newsletter subscribers, or type some email addresses.')

    const subject = str(body.subject, 300)
    const text = str(body.body, 10_000)
    if (!subject || !text) fail(400, 'Write a subject and a message.')
    const vars = { title: d.title || '', summary: d.desc || '', edition: d.edition || '', readTime: d.readTime || '', link, site: site.name || 'IEEE ITS VIT', ...extra }
    const recipients = [...people].map(([email, name]) => ({ email, vars: { ...vars, name: String(name || '').split(' ')[0] || 'there' } }))
    const label = `${body.type === 'blogs' ? 'New blog' : body.type === 'connect' ? 'Connect' : 'Newsletter'}: ${d.title || 'item'} (${recipients.length})`
    const queued = await createCampaign({ kind: `announce-${body.type}`, label, subject, body: text, recipients, user })
    await audit(user, 'email', body.type, body.id || (body.ids || []).join(',') || 'last-7-days', `${label} — ${aud.join(' + ') || 'custom'}${custom.length ? ` + ${custom.length} custom` : ''}`)
    return { queued: [queued] }
})

route('POST', '/api/admin/content/:type/reorder', async ({ user, params, body }) => {
    requireRole(user, 'editor'); typeDef(params.type)
    const ids = (body.ids || []).map(Number).filter(Boolean)
    for (let i = 0; i < ids.length; i++) await getDb().run('UPDATE content SET sort_order = ? WHERE id = ? AND type = ?', [i, ids[i], params.type])
    await audit(user, 'reorder', params.type, '', ids.join(','))
    return { ok: true }
})

/* ── admin: events ── */
async function uniqueSlug(table, base, id) {
    let slug = slugify(base), n = 1
    while (await getDb().first(`SELECT id FROM ${table} WHERE slug = ? AND id != ?`, [slug, id || 0])) slug = `${slugify(base)}-${++n}`
    return slug
}

function prepareEvent(body) {
    const e = cleanByFields(EVENT_FIELDS, body)
    if (e.end_date && e.end_date < e.start_date) fail(400, 'End date cannot be before the start date.')
    const rawOrg = body?.extra?.organizers || body?.organizers
    if (Array.isArray(rawOrg)) {
        e.extra = e.extra || {}
        e.extra.organizers = rawOrg.map(o => ({
            name: str(o.name, 120),
            role: str(o.role, 120),
            linkedin: safeUrl(o.linkedin),
            image: safeUrl(o.image)
        })).filter(o => o.name)
    }
    return { ...e, status: body.status === 'draft' ? 'draft' : 'published' }
}

const EVENT_COLS = ['slug', 'title', 'tag', 'summary', 'body_html', 'start_date', 'end_date', 'date_label', 'time_text', 'venue', 'poster_url', 'registration_url', 'cta_label', 'extra', 'featured', 'show_in_timeline', 'status']

route('GET', '/api/admin/events', async ({ user }) => {
    requireRole(user, 'editor')
    return { items: (await loadEvents({ includeDrafts: true })).reverse() }
})

route('POST', '/api/admin/events', async ({ user, body }) => {
    requireRole(user, 'editor')
    const e = prepareEvent(body)
    e.slug = await uniqueSlug('events', e.slug || e.title)
    const r = await getDb().run(`INSERT INTO events (${EVENT_COLS.join(',')}) VALUES (${EVENT_COLS.map(() => '?').join(',')})`, EVENT_COLS.map(c => e[c]))
    await audit(user, 'create', 'event', r.lastId, e.title)
    return { item: eventRow(await getDb().first('SELECT * FROM events WHERE id = ?', [r.lastId])) }
})

route('PUT', '/api/admin/events/:id', async ({ user, params, body }) => {
    requireRole(user, 'editor')
    const id = Number(params.id)
    const e = prepareEvent(body)
    e.slug = await uniqueSlug('events', e.slug || e.title, id)
    const before = await getDb().first('SELECT poster_url, extra, body_html FROM events WHERE id = ?', [id])
    if (!before) fail(404, 'Event not found')
    await getDb().run(`UPDATE events SET ${EVENT_COLS.map(c => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`, [...EVENT_COLS.map(c => e[c]), id])
    await audit(user, 'update', 'event', id, e.title)
    await releaseImages(user, dropped(imageUrls(before.poster_url, before.extra, before.body_html), imageUrls(e.poster_url, e.extra, e.body_html)))
    return { item: eventRow(await getDb().first('SELECT * FROM events WHERE id = ?', [id])) }
})

route('DELETE', '/api/admin/events/:id', async ({ user, params }) => {
    requireRole(user, 'editor')
    const id = Number(params.id)
    const before = await getDb().first('SELECT poster_url, extra, body_html FROM events WHERE id = ?', [id])
    if (!before) fail(404, 'Event not found')
    await getDb().run('UPDATE moments SET event_id = NULL WHERE event_id = ?', [id])
    await getDb().run('DELETE FROM events WHERE id = ?', [id])
    await audit(user, 'delete', 'event', id)
    await releaseImages(user, imageUrls(before.poster_url, before.extra, before.body_html))
    return { ok: true }
})

/* ── admin: event organizers / directory ── */
route('GET', '/api/admin/organizers', async ({ user }) => {
    requireRole(user, 'editor')
    const db = getDb()
    try {
        const items = await db.all('SELECT * FROM event_organizers ORDER BY name ASC')
        return { items }
    } catch {
        return { items: [] }
    }
})

route('POST', '/api/admin/organizers', async ({ user, body }) => {
    requireRole(user, 'editor')
    const name = str(body.name, 120)
    if (!name) fail(400, 'Organizer name is required.')
    const role = str(body.role, 120)
    const linkedin = safeUrl(body.linkedin)
    const image = safeUrl(body.image)
    const db = getDb()
    const r = await db.run(
        'INSERT INTO event_organizers (name, role, linkedin, image) VALUES (?, ?, ?, ?)',
        [name, role, linkedin, image]
    )
    const item = await db.first('SELECT * FROM event_organizers WHERE id = ?', [r.lastId])
    await audit(user, 'create', 'event_organizer', r.lastId, name)
    return { item }
})

route('DELETE', '/api/admin/organizers/:id', async ({ user, params }) => {
    requireRole(user, 'editor')
    const db = getDb()
    await db.run('DELETE FROM event_organizers WHERE id = ?', [Number(params.id)])
    await audit(user, 'delete', 'event_organizer', params.id)
    return { ok: true }
})

/* ── admin: moments ── */
const MOMENT_COLS = ['title', 'event_id', 'album_date', 'photos', 'show_on_home', 'status']
const prepareMoment = body => ({ ...cleanByFields(MOMENT_FIELDS, body), status: body.status === 'draft' ? 'draft' : 'published' })

route('GET', '/api/admin/moments', async ({ user }) => {
    requireRole(user, 'editor')
    const events = await loadEvents({ includeDrafts: true })
    return { items: await loadMoments({ includeDrafts: true, events }) }
})

route('POST', '/api/admin/moments', async ({ user, body }) => {
    requireRole(user, 'editor')
    const m = prepareMoment(body)
    const max = await getDb().first('SELECT COALESCE(MAX(sort_order), -1) AS m FROM moments')
    const r = await getDb().run(`INSERT INTO moments (${MOMENT_COLS.join(',')}, sort_order) VALUES (${MOMENT_COLS.map(() => '?').join(',')}, ?)`, [...MOMENT_COLS.map(c => m[c]), max.m + 1])
    await audit(user, 'create', 'moment', r.lastId, m.title)
    return { id: r.lastId }
})

route('PUT', '/api/admin/moments/:id', async ({ user, params, body }) => {
    requireRole(user, 'editor')
    const m = prepareMoment(body)
    const before = await getDb().first('SELECT photos FROM moments WHERE id = ?', [Number(params.id)])
    if (!before) fail(404, 'Album not found')
    await getDb().run(`UPDATE moments SET ${MOMENT_COLS.map(c => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`, [...MOMENT_COLS.map(c => m[c]), Number(params.id)])
    await audit(user, 'update', 'moment', params.id, m.title)
    await releaseImages(user, dropped(imageUrls(before.photos), imageUrls(m.photos)))
    return { ok: true }
})

route('DELETE', '/api/admin/moments/:id', async ({ user, params }) => {
    requireRole(user, 'editor')
    const before = await getDb().first('SELECT photos FROM moments WHERE id = ?', [Number(params.id)])
    if (!before) fail(404, 'Album not found')
    await getDb().run('DELETE FROM moments WHERE id = ?', [Number(params.id)])
    await audit(user, 'delete', 'moment', params.id)
    await releaseImages(user, imageUrls(before.photos))
    return { ok: true }
})

route('POST', '/api/admin/moments/reorder', async ({ user, body }) => {
    requireRole(user, 'editor')
    const ids = (body.ids || []).map(Number).filter(Boolean)
    for (let i = 0; i < ids.length; i++) await getDb().run('UPDATE moments SET sort_order = ? WHERE id = ?', [i, ids[i]])
    return { ok: true }
})

/* ── admin: settings ── */
route('GET', '/api/admin/settings', async ({ user }) => {
    requireRole(user, 'editor')
    const keys = user.role === 'admin' ? [...PUBLIC_SETTING_KEYS, ...PRIVATE_SETTINGS] : PUBLIC_SETTING_KEYS
    const s = await loadSettings(keys)
    if (s.smtp) { s.smtp = { ...s.smtp, hasPassword: !!s.smtp.passEnc || !!process.env.SMTP_PASS }; delete s.smtp.passEnc }
    if (s.smtp_auth) { s.smtp_auth = { ...s.smtp_auth, hasPassword: !!s.smtp_auth.passEnc || !!process.env.SMTP_AUTH_PASS }; delete s.smtp_auth.passEnc }
    return { settings: s }
})

route('PUT', '/api/admin/settings/:key', async ({ user, params, body }) => {
    const { key } = params
    if (PRIVATE_SETTINGS.includes(key)) requireRole(user, 'admin')
    else if (PUBLIC_SETTING_KEYS.includes(key)) requireRole(user, 'editor')
    else fail(404, 'Unknown setting')
    let value = body.value && typeof body.value === 'object' ? body.value : fail(400, 'Invalid value')
    const db = getDb()
    if (SETTINGS_FORMS[key]) {
        const current = (await loadSettings([key]))[key]
        let cleaned = { ...current }
        for (const f of SETTINGS_FORMS[key].fields) cleaned = setPath(cleaned, f.name, cleanField(f, getPath(value, f.name)))
        value = cleaned
    } else if (key === 'layout') {
        value = cleanLayout(value)
    } else if (key === 'image_styles') {
        // The admin sends only the images it changed; null removes an image's crop.
        const current = (await loadSettings(['image_styles'])).image_styles || {}
        value = { ...current }
        for (const [url, style] of Object.entries(body.value).slice(0, 200)) {
            const u = safeUrl(url)
            if (!u) continue
            const clean = cleanImageStyle(style)
            if (clean) value[u] = clean
            else delete value[u]
        }
    } else if (key === 'notifications') {
        value = {
            orderRecipients: emailList(value.orderRecipients).join(', '), queryRecipients: emailList(value.queryRecipients).join(', '),
            notifyOrders: !!value.notifyOrders, notifyQueries: !!value.notifyQueries, notifySuggestions: !!value.notifySuggestions,
            notifySubscribers: !!value.notifySubscribers, sendUserConfirmation: !!value.sendUserConfirmation,
        }
    } else if (key === 'smtp' || key === 'smtp_auth') {
        const { smtp: main, [key]: current } = await loadSettings(['smtp', key])
        // "Copy from main" reuses the main account's encrypted password without the admin re-typing it.
        const passEnc = value.pass ? encrypt(String(value.pass)) : value.clearPassword ? '' : value.copyMainPassword && key === 'smtp_auth' ? main.passEnc || '' : current.passEnc || ''
        value = {
            host: str(value.host, 200), port: Number(value.port) || 587, secure: !!value.secure, user: str(value.user, 200),
            fromName: str(value.fromName, 100), fromEmail: isEmail(value.fromEmail) ? str(value.fromEmail, 200) : '', passEnc,
        }
    }
    const json = JSON.stringify(value)
    if (json.length > 500_000) fail(413, 'Setting is too large')
    const before = await db.first('SELECT value FROM settings WHERE key = ?', [key])
    await db.run("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", [key, json])
    await audit(user, 'update', 'settings', key)
    if (key !== 'image_styles') await releaseImages(user, dropped(imageUrls(before?.value), imageUrls(json)))
    return { ok: true, value }
})

/* ── admin: media ── */
route('GET', '/api/admin/media/auth', async ({ user, res }) => {
    requireRole(user, 'editor')
    res.setHeader('Cache-Control', 'no-store')
    return uploadAuth()
})

route('GET', '/api/admin/media', async ({ user }) => {
    requireRole(user, 'editor')
    return { items: await getDb().all('SELECT * FROM media ORDER BY id DESC LIMIT 500'), imagekit: imagekitConfigured() }
})

/* Details for one file in the Media Library: where it is used (with edit and page links) and who uploaded it. */
route('GET', '/api/admin/media/:id/usage', async ({ user, params }) => {
    requireRole(user, 'editor')
    const m = await getDb().first('SELECT m.*, u.name AS uploader FROM media m LEFT JOIN users u ON u.id = m.uploaded_by WHERE m.id = ?', [Number(params.id)])
    if (!m) fail(404, 'File not found')
    return { item: m, usedIn: await mediaUsage(m.url) }
})

route('POST', '/api/admin/media', async ({ user, body }) => {
    requireRole(user, 'editor')
    const url = safeUrl(body.url)
    if (!/^https?:\/\//.test(url)) fail(400, 'A full image URL is required.')
    const r = await getDb().run('INSERT INTO media (url, file_id, name, folder, mime, size, width, height, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [url, str(body.fileId, 100), str(body.name, 200), str(body.folder, 200), str(body.mime, 60), Number(body.size) || 0, Number(body.width) || 0, Number(body.height) || 0, user.id])
    await audit(user, 'upload', 'media', r.lastId, body.name || url)
    return { item: await getDb().first('SELECT * FROM media WHERE id = ?', [r.lastId]) }
})

route('DELETE', '/api/admin/media/:id', async ({ user, params }) => {
    requireRole(user, 'editor')
    const m = await getDb().first('SELECT * FROM media WHERE id = ?', [Number(params.id)])
    if (!m) fail(404, 'File not found')
    const usedIn = await imageUsage(m.url)
    if (usedIn.length) fail(409, `This image is still used in ${usedIn.length} place${usedIn.length > 1 ? 's' : ''}: ${usedIn.slice(0, 5).join('; ')}${usedIn.length > 5 ? '; …' : ''}. Remove it there first — it will then be deleted from ImageKit automatically.`)
    await deleteFile(m.file_id)
    await getDb().run('DELETE FROM media WHERE id = ?', [m.id])
    await audit(user, 'delete', 'media', m.id, m.name)
    return { ok: true }
})

/* ── admin: orders, queries, subscribers ── */
route('GET', '/api/admin/orders', async ({ user }) => {
    requireRole(user, 'editor')
    return { items: await getDb().all('SELECT * FROM orders ORDER BY id DESC LIMIT 2000') }
})

route('PATCH', '/api/admin/orders/:id', async ({ user, params, body }) => {
    requireRole(user, 'editor')
    await getDb().run("UPDATE orders SET status = ?, admin_note = ?, updated_at = datetime('now') WHERE id = ?", [str(body.status, 40) || 'Booked', str(body.admin_note, 2000), Number(params.id)])
    await audit(user, 'update', 'order', params.id, body.status)
    return { ok: true }
})

route('DELETE', '/api/admin/orders/:id', async ({ user, params }) => {
    requireRole(user, 'admin')
    await getDb().run('DELETE FROM orders WHERE id = ?', [Number(params.id)])
    await audit(user, 'delete', 'order', params.id)
    return { ok: true }
})

route('GET', '/api/admin/queries', async ({ user }) => {
    requireRole(user, 'editor')
    return { items: await getDb().all('SELECT * FROM queries ORDER BY id DESC LIMIT 2000') }
})

route('PATCH', '/api/admin/queries/:id', async ({ user, params, body }) => {
    requireRole(user, 'editor')
    await getDb().run("UPDATE queries SET status = ?, admin_note = ?, updated_at = datetime('now') WHERE id = ?", [str(body.status, 40) || 'New', str(body.admin_note, 2000), Number(params.id)])
    await audit(user, 'update', 'query', params.id, body.status)
    return { ok: true }
})

route('DELETE', '/api/admin/queries/:id', async ({ user, params }) => {
    requireRole(user, 'admin')
    await getDb().run('DELETE FROM queries WHERE id = ?', [Number(params.id)])
    await audit(user, 'delete', 'query', params.id)
    return { ok: true }
})

route('GET', '/api/admin/subscribers', async ({ user }) => {
    requireRole(user, 'editor')
    return { items: await getDb().all('SELECT * FROM subscribers ORDER BY id DESC') }
})

route('DELETE', '/api/admin/subscribers/:id', async ({ user, params }) => {
    requireRole(user, 'admin')
    await getDb().run('DELETE FROM subscribers WHERE id = ?', [Number(params.id)])
    await audit(user, 'delete', 'subscriber', params.id)
    return { ok: true }
})

/* ── admin: members master ── */
route('GET', '/api/admin/members-master', async ({ user }) => {
    requireRole(user, 'editor')
    const db = getDb()

    // 1. All users
    const userRows = await db.all('SELECT * FROM users ORDER BY id DESC').catch(() => [])

    // 2. All recruitment applications with domain titles
    const recApps = await db.all(`
        SELECT a.id, a.user_id, a.domain_id, a.status, a.source, a.auto_score, a.manual_score, a.max_score,
               d.title AS domain_title, a.created_at
        FROM rec_applications a
        JOIN rec_domains d ON d.id = a.domain_id
        ORDER BY a.id DESC
    `).catch(() => [])

    // 3. Content items: board, advisory, web_team, faculty
    const contentItems = await db.all(`
        SELECT id, type, data, sort_order, status, created_at
        FROM content
        WHERE type IN ('board', 'advisory', 'web_team', 'faculty')
        ORDER BY sort_order, id
    `).catch(() => [])

    // Build user applications lookup
    const userApps = {}
    for (const app of recApps) {
        if (!userApps[app.user_id]) userApps[app.user_id] = []
        userApps[app.user_id].push({
            id: app.id,
            domainId: app.domain_id,
            domain: app.domain_title,
            status: app.status,
            source: app.source,
            score: (app.auto_score ?? 0) + (app.manual_score ?? 0),
            maxScore: app.max_score,
            createdAt: app.created_at,
        })
    }

    // Process CMS items
    const parsedCms = contentItems.map(c => {
        const d = parseJson(c.data, {})
        return {
            id: c.id,
            type: c.type,
            name: (d.name || '').trim(),
            role: d.role || d.designation || '',
            department: d.department || '',
            year: d.year || '',
            group: d.group || '',
            image: d.image || '',
            initials: d.initials || '',
            linkedin: d.linkedin || '',
            instagram: d.instagram || '',
            status: c.status,
            createdAt: c.created_at,
        }
    })

    const matchedCmsIds = new Set()
    const members = []

    // 1. Process all registered users
    for (const u of userRows) {
        const uNameKey = (u.name || '').trim().toLowerCase()
        const apps = userApps[u.id] || []

        // Find matching CMS entries for this user by name
        const matchedCms = parsedCms.filter(c => {
            if (c.name && c.name.toLowerCase() === uNameKey) {
                matchedCmsIds.add(c.id)
                return true
            }
            return false
        })

        const affiliations = ['user']
        let primaryPosition = ''
        let primaryCategory = 'Registered User'

        // Check if recruited or applicant
        const selectedApps = apps.filter(a => a.status === 'selected')
        if (selectedApps.length > 0) {
            affiliations.push('recruited')
            primaryPosition = `Core Member (${selectedApps.map(a => a.domain).join(', ')})`
            primaryCategory = 'Recruited Member'
        } else if (apps.length > 0) {
            affiliations.push('applicant')
            primaryPosition = `Applicant (${apps.map(a => `${a.domain}: ${a.status}`).join(', ')})`
            primaryCategory = 'Applicant'
        }

        // CMS affiliations
        for (const c of matchedCms) {
            affiliations.push(c.type)
            if (c.type === 'board') {
                primaryPosition = c.role || 'Board Member'
                primaryCategory = 'Board Member'
            } else if (c.type === 'web_team') {
                primaryPosition = c.role || 'Web Team'
                primaryCategory = 'Web Team'
            } else if (c.type === 'advisory') {
                primaryPosition = c.role || `Advisory Board (${c.year || 'Past'})`
                primaryCategory = `Advisory Board ${c.year ? `(${c.year})` : ''}`
            } else if (c.type === 'faculty') {
                primaryPosition = c.role || 'Faculty Coordinator'
                primaryCategory = 'Faculty'
            }
        }

        if (!primaryPosition) {
            primaryPosition = u.role === 'admin' ? 'Administrator' : u.role === 'editor' ? 'Editor' : 'User'
        }

        const domainList = apps.map(a => ({
            name: a.domain,
            status: a.status,
            score: a.score,
        }))

        members.push({
            id: `user-${u.id}`,
            userId: u.id,
            name: u.name,
            email: u.email,
            mobile: u.mobile || '',
            regNo: u.reg_no || '',
            memberType: u.member_type || 'External Member',
            systemRole: u.role,
            isRegistered: true,
            active: !!u.active,
            lastLoginAt: u.last_login_at,
            createdAt: u.created_at,
            affiliations: [...new Set(affiliations)],
            primaryPosition,
            primaryCategory,
            domains: domainList,
            applications: apps,
            cmsLinks: matchedCms.map(c => ({ id: c.id, type: c.type, role: c.role, year: c.year, group: c.group })),
            avatarUrl: u.avatar_url || matchedCms.find(c => c.image)?.image || '',
            linkedin: matchedCms.find(c => c.linkedin)?.linkedin || '',
            instagram: matchedCms.find(c => c.instagram)?.instagram || '',
        })
    }

    // 2. Add CMS entries that did not match an existing user
    for (const c of parsedCms) {
        if (matchedCmsIds.has(c.id)) continue

        let cat = 'Other'
        let pos = c.role
        if (c.type === 'board') { cat = 'Board Member'; pos = pos || 'Board Member' }
        else if (c.type === 'web_team') { cat = 'Web Team'; pos = pos || 'Web Team Member' }
        else if (c.type === 'advisory') { cat = `Advisory Board ${c.year ? `(${c.year})` : ''}`; pos = pos || 'Past Member' }
        else if (c.type === 'faculty') { cat = 'Faculty'; pos = pos || 'Faculty Coordinator' }

        members.push({
            id: `cms-${c.type}-${c.id}`,
            contentId: c.id,
            name: c.name || 'Unnamed',
            email: '',
            mobile: '',
            regNo: '',
            memberType: c.type === 'faculty' ? 'Faculty' : 'Member',
            systemRole: '—',
            isRegistered: false,
            active: c.status === 'published',
            lastLoginAt: null,
            createdAt: c.createdAt,
            affiliations: [c.type],
            primaryPosition: pos || '—',
            primaryCategory: cat,
            domains: [],
            applications: [],
            cmsLinks: [{ id: c.id, type: c.type, role: c.role, year: c.year, group: c.group }],
            avatarUrl: c.image || '',
            linkedin: c.linkedin || '',
            instagram: c.instagram || '',
        })
    }

    return { items: members }
})

/* ── admin: users ── */
const adminUser = u => ({ ...publicUser(u), active: !!u.active, lastLoginAt: u.last_login_at })

route('GET', '/api/admin/users', async ({ user }) => {
    requireRole(user, 'admin')
    return { items: (await getDb().all('SELECT * FROM users ORDER BY id DESC')).map(adminUser) }
})

route('POST', '/api/admin/users', async ({ user, body }) => {
    requireRole(user, 'admin')
    const email = str(body.email, 200).toLowerCase()
    if (!isEmail(email)) fail(400, 'Valid email required.')
    const problem = passwordProblem(body.password)
    if (problem) fail(400, problem)
    const role = ROLE_RANK[body.role] ? body.role : 'member'
    if (await getDb().first('SELECT id FROM users WHERE email = ?', [email])) fail(409, 'A user with this email already exists.')
    const r = await getDb().run('INSERT INTO users (name, email, password_hash, role, member_type) VALUES (?, ?, ?, ?, ?)',
        [str(body.name, 120) || email, email, await hashPassword(body.password), role, memberTypeFor(email)])
    await audit(user, 'create', 'user', r.lastId, `${email} (${role})`)
    return { item: adminUser(await getDb().first('SELECT * FROM users WHERE id = ?', [r.lastId])) }
})

route('PATCH', '/api/admin/users/:id', async ({ user, params, body }) => {
    requireRole(user, 'admin')
    const db = getDb()
    const target = await db.first('SELECT * FROM users WHERE id = ?', [Number(params.id)])
    if (!target) fail(404, 'User not found')
    const role = ROLE_RANK[body.role] ? body.role : target.role
    const active = body.active === undefined ? !!target.active : !!body.active
    if (target.role === 'admin' && (role !== 'admin' || !active)) {
        const admins = await db.first("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND active = 1")
        if (admins.n <= 1) fail(400, 'You cannot remove the last active admin.')
    }
    let bump = role !== target.role || active !== !!target.active ? 1 : 0
    let hash = target.password_hash
    if (body.newPassword) {
        const problem = passwordProblem(body.newPassword)
        if (problem) fail(400, problem)
        hash = await hashPassword(body.newPassword)
        bump = 1
    }
    await db.run("UPDATE users SET name = ?, role = ?, active = ?, password_hash = ?, token_version = token_version + ?, updated_at = datetime('now') WHERE id = ?",
        [str(body.name, 120) || target.name, role, active ? 1 : 0, hash, bump, target.id])
    await audit(user, 'update', 'user', target.id, `${target.email}: role=${role} active=${active}${body.newPassword ? ' password-reset' : ''}`)
    return { item: adminUser(await db.first('SELECT * FROM users WHERE id = ?', [target.id])) }
})

route('DELETE', '/api/admin/users/:id', async ({ user, params }) => {
    requireRole(user, 'admin')
    if (Number(params.id) === user.id) fail(400, 'You cannot delete your own account.')
    const target = await getDb().first('SELECT * FROM users WHERE id = ?', [Number(params.id)])
    if (!target) fail(404, 'User not found')
    if (target.role === 'admin') {
        const admins = await getDb().first("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND active = 1")
        if (admins.n <= 1) fail(400, 'You cannot delete the last admin.')
    }
    await getDb().run('DELETE FROM users WHERE id = ?', [target.id])
    await audit(user, 'delete', 'user', target.id, target.email)
    return { ok: true }
})

/* ── admin: email & logs ── */
route('POST', '/api/admin/email-test', async ({ user, body }) => {
    requireRole(user, 'admin')
    const to = emailList(body.to || user.email)
    const profile = body.profile === 'auth' ? 'auth' : 'main'
    const cfg = await smtpConfig(profile)
    if (profile === 'auth' && cfg.profile !== 'auth') fail(400, 'The account-email SMTP is not set up yet, so account emails currently use the main SMTP.')
    const r = await sendMail({ kind: 'test', to, profile, subject: `IEEE ITS — SMTP test (${profile === 'auth' ? 'account emails' : 'main'})`,
        html: `<p>Your ${profile === 'auth' ? 'account-email' : 'main'} SMTP settings work (sent from ${cfg.user}).</p><p>— IEEE ITS Website</p>` })
    if (!r.ok) fail(400, `Email failed: ${r.error}`)
    return { ok: true }
})

route('GET', '/api/admin/email-logs', async ({ user }) => {
    requireRole(user, 'admin')
    return { items: await getDb().all('SELECT * FROM email_logs ORDER BY id DESC LIMIT 300') }
})

route('GET', '/api/admin/audit', async ({ user }) => {
    requireRole(user, 'admin')
    const db = getDb()
    const [audits, activity] = await Promise.all([
        db.all('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 500'),
        db.all('SELECT * FROM activity_logs ORDER BY id DESC LIMIT 500'),
    ])
    return { items: audits, activity }
})

/* ───────────── dispatcher ───────────── */
/* ── bulk email outbox ── */
route('GET', '/api/admin/outbox', async ({ user }) => {
    requireRole(user, 'editor')
    const items = await getDb().all("SELECT id, kind, label, subject, total, cursor, sent, failed, status, note, retry_at, retries, (failures != '[]') AS has_failures, created_by, created_at, updated_at FROM email_campaigns ORDER BY id DESC LIMIT 100")
    return { items, quota: await quotaStatus() }
})

route('POST', '/api/admin/outbox/process', async ({ user }) => {
    requireRole(user, 'editor')
    return { ...(await drainCampaigns(14_000)), quota: await quotaStatus() }
})

route('POST', '/api/admin/outbox/:id/cancel', async ({ user, params }) => {
    requireRole(user, 'editor')
    await getDb().run("UPDATE email_campaigns SET status = 'cancelled', updated_at = datetime('now') WHERE id = ? AND status = 'queued'", [Number(params.id)])
    await audit(user, 'cancel', 'email-campaign', params.id)
    return { ok: true }
})

/* Addresses that failed in one mail-out, with the mail server's reason. */
route('GET', '/api/admin/outbox/:id/failures', async ({ user, params }) => {
    requireRole(user, 'editor')
    const c = await getDb().first('SELECT failures FROM email_campaigns WHERE id = ?', [Number(params.id)])
    if (!c) fail(404, 'Mail-out not found.')
    return { items: parseJson(c.failures, []) }
})

route('POST', '/api/admin/outbox/:id/retry', async ({ user, params }) => {
    requireRole(user, 'editor')
    const queued = await resendFailed(params.id, user)
    await audit(user, 'resend', 'email-campaign', params.id, `${queued.total} failed addresses queued again (mail-out #${queued.id})`)
    return { queued: [queued] }
})

route('PUT', '/api/admin/outbox/limits', async ({ user, body }) => {
    requireRole(user, 'admin')
    const dailyLimit = await setDailyLimit(body.dailyLimit)
    await audit(user, 'update', 'settings', 'mail_limits', `daily limit ${dailyLimit}`)
    return { quota: await quotaStatus() }
})

/* Daily Vercel cron (vercel.json) keeps long mail-outs moving when nobody has the Outbox open. */
route('GET', '/api/cron/outbox', async ({ req }) => {
    // With CRON_SECRET set, Vercel sends it and nothing else is accepted. Without it, Vercel's own cron
    // caller is let in: the job only sends mail an admin already queued (within the daily limit) and a
    // once-a-day reminder, so the worst an impostor can do is make queued mail leave a little earlier.
    const secret = process.env.CRON_SECRET
    const allowed = secret ? req.headers.authorization === `Bearer ${secret}` : /vercel-cron/i.test(req.headers['user-agent'] || '')
    if (!allowed) fail(401, 'Unauthorized')
    const sent = await drainCampaigns(40_000)
    const digest = await connectDigest().catch(e => ({ digest: `failed: ${e.message}` }))
    return { ...sent, ...digest }
})

installRecruitment({ route, requireRole, audit, loadSettings })
installPortals({ route, requireRole, audit, loadSettings, releaseImages, imageUrls })
const connectDigest = installConnect({ route, requireRole, audit, loadSettings })

export async function handle(req, res, pathOverride) {
    const url = new URL(req.url, 'http://local')
    let pathname = pathOverride || url.pathname
    if (!pathname.startsWith('/api')) pathname = `/api/${pathname.replace(/^\//, '')}`
    try {
        // CSRF: state-changing requests must carry our custom header (forces a CORS preflight cross-site).
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-requested-with'] !== 'its-web') {
            fail(403, 'Missing request header.')
        }
        const match = routes.find(r => r.method === req.method && r.re.test(pathname))
        if (!match) {
            const exists = routes.some(r => r.re.test(pathname))
            fail(exists ? 405 : 404, exists ? 'Method not allowed' : 'Not found')
        }
        await ensureReady()
        const m = pathname.match(match.re)
        const params = Object.fromEntries(match.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]))
        const [body, user] = await Promise.all([readBody(req), currentUser(req)])
        const result = await match.handler({ req, res, params, body, user, query: url.searchParams })
        if (!res.headersSent && result !== undefined) {
            if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-store')
            send(res, 200, result)
        }
    } catch (e) {
        const status = e instanceof HttpError ? e.status : e.status || 500
        if (status >= 500) console.error('[api]', req.method, pathname, e)
        send(res, status, { error: status >= 500 && !(e instanceof HttpError) && !e.status ? 'Something went wrong on the server.' : e.message, ...(e.code && typeof e.code === 'string' && /^[A-Z_]+$/.test(e.code) ? { code: e.code } : {}) })
    }
}
