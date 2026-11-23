/**
 * Normalizes an image URL for matching against settings.image_styles.
 * Strips query parameters, hashes, protocols and trailing slashes.
 */
export function normalizeImageUrl(u) {
    if (!u || typeof u !== 'string') return ''
    return u.split('?')[0].split('#')[0].trim().replace(/\/+$/, '')
}

/**
 * Looks up custom crop, focal point, and zoom for an image URL from settings.image_styles.
 * Matches exact URL, stripped URL, or ImageKit pathname.
 */
export function getImageStyle(styles, src) {
    if (!styles || !src || typeof src !== 'string') return null
    if (styles[src]) return styles[src]
    const base = normalizeImageUrl(src)
    if (styles[base]) return styles[base]
    for (const [k, v] of Object.entries(styles)) {
        if (!k || !v) continue
        if (normalizeImageUrl(k) === base) return v
        try {
            const u1 = new URL(base)
            const u2 = new URL(normalizeImageUrl(k))
            if (u1.pathname === u2.pathname && u1.pathname.length > 2) return v
        } catch {
            // ignore non-URL keys
        }
    }
    return null
}

/**
 * Computes CSS styles for an image to apply the admin's exact focal point and zoom.
 */
export function getFramingStyle(styles, src, fallbackFocus) {
    const st = getImageStyle(styles, src)
    if (st) {
        const fit = st.fit || 'cover'
        const x = st.x ?? 50
        const y = st.y ?? 50
        const zoom = st.zoom || 1
        return {
            objectFit: fit,
            objectPosition: `${x}% ${y}%`,
            transformOrigin: `${x}% ${y}%`,
            ...(zoom > 1 ? { transform: `scale(var(--img-zoom, ${zoom}))`, '--img-zoom': zoom } : {}),
        }
    }
    if (fallbackFocus) {
        return { objectPosition: fallbackFocus }
    }
    return undefined
}
