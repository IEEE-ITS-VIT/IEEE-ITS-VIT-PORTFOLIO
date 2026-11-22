/**
 * ImageKit integration.
 * The browser uploads straight to ImageKit using a short-lived signature generated here,
 * so the private key never leaves the server.
 * Env: IMAGEKIT_PUBLIC_KEY, IMAGEKIT_PRIVATE_KEY, IMAGEKIT_URL_ENDPOINT
 */
import crypto from 'crypto'
import { fail } from './http.js'

export const imagekitConfigured = () =>
    !!(process.env.IMAGEKIT_PUBLIC_KEY && process.env.IMAGEKIT_PRIVATE_KEY && process.env.IMAGEKIT_URL_ENDPOINT)

export function uploadAuth() {
    if (!imagekitConfigured()) fail(503, 'ImageKit is not configured. Set IMAGEKIT_PUBLIC_KEY, IMAGEKIT_PRIVATE_KEY and IMAGEKIT_URL_ENDPOINT.')
    const token = crypto.randomUUID()
    const expire = Math.floor(Date.now() / 1000) + 30 * 60
    const signature = crypto.createHmac('sha1', process.env.IMAGEKIT_PRIVATE_KEY).update(token + expire).digest('hex')
    return {
        token, expire, signature,
        publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
        urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT,
        folder: process.env.IMAGEKIT_FOLDER || '/ieee-its',
    }
}

export async function deleteFile(fileId) {
    if (!fileId || !imagekitConfigured()) return
    const auth = Buffer.from(`${process.env.IMAGEKIT_PRIVATE_KEY}:`).toString('base64')
    const res = await fetch(`https://api.imagekit.io/v1/files/${encodeURIComponent(fileId)}`, {
        method: 'DELETE', headers: { Authorization: `Basic ${auth}` },
    })
    if (!res.ok && res.status !== 404) fail(502, `ImageKit delete failed (${res.status})`)
}

export async function deleteFileByUrl(url) {
    if (!url || !imagekitConfigured() || !/ik\.imagekit\.io/.test(url)) return false
    const cleanUrl = url.split('?')[0]
    const auth = Buffer.from(`${process.env.IMAGEKIT_PRIVATE_KEY}:`).toString('base64')
    try {
        const u = new URL(cleanUrl)
        const fileName = u.pathname.split('/').pop()
        if (!fileName) return false
        const searchRes = await fetch(`https://api.imagekit.io/v1/files?name=${encodeURIComponent(fileName)}`, {
            headers: { Authorization: `Basic ${auth}` },
        })
        if (!searchRes.ok) return false
        const list = await searchRes.json()
        if (Array.isArray(list) && list.length > 0) {
            const match = list.find(f => f.url === cleanUrl || f.name === fileName) || list[0]
            if (match?.fileId) {
                await deleteFile(match.fileId)
                return true
            }
        }
    } catch (e) {
        console.error('[imagekit] deleteFileByUrl failed for', url, e.message)
    }
    return false
}
