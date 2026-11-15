/** Is this link a PDF? (ImageKit and most hosts keep the .pdf extension in the path.) */
export const isPdfUrl = u => /\.pdf(?:[?#]|$)/i.test(String(u || '').trim())

/** "DSA-Guide.pdf" from a URL, without ImageKit's random suffix ("DSA-Guide_a1B2c3.pdf"). */
export const fileName = u => {
    try {
        const last = decodeURIComponent(new URL(u, window.location.href).pathname.split('/').pop() || '')
        return last.replace(/_[A-Za-z0-9-]{6,12}(\.[a-z0-9]+)$/i, '$1') || 'Document'
    } catch { return 'Document' }
}

/** Only files on ImageKit (or this site) may be shown through the /view page. */
export const viewable = u => {
    try {
        const url = new URL(u, window.location.href)
        return url.protocol === 'https:' && (/(^|\.)imagekit\.io$/.test(url.hostname) || url.origin === window.location.origin) && isPdfUrl(url.href)
    } catch { return false }
}

/** Shareable page on this site that shows a PDF in the viewer. */
export const viewerLink = (u, title) => `${window.location.origin}/view?file=${encodeURIComponent(u)}${title ? `&title=${encodeURIComponent(title)}` : ''}`
