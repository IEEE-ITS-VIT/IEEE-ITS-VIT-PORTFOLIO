import { useState } from 'react'
import { img } from '../lib/safe'
import { useSite } from '../context/SiteContext'
import { getImageStyle, getFramingStyle } from '../lib/imageStyles'

/**
 * Uniform image frame. Every image of a given kind uses the specified aspect ratio and crop.
 * If an image has been adjusted in the admin (fit, focal point, zoom — settings.image_styles),
 * it is fetched uncropped and framed with precision in the browser so admin edits are faithfully rendered.
 */
export default function Img({ src, alt = '', ratio = '16x9', width = 800, focus, face, contain, fallback, className = '', children, eager }) {
    const [err, setErr] = useState(false)
    const { settings } = useSite()
    const st = getImageStyle(settings.image_styles, src)
    const effectiveFit = st?.fit || (contain ? 'contain' : 'cover')
    const isFramed = !!(st || focus)

    let url = ''
    if (src && !err) {
        if (ratio === 'auto' || isFramed) {
            url = img(src, { w: width })
        } else {
            const [h] = ratio.split('x').map(Number).reverse()
            const w = Number(ratio.split('x')[0]) || 16
            url = img(src, { w: width, h: h ? Math.round((width * h) / w) : undefined, face })
        }
    }

    const imgStyle = {
        objectFit: effectiveFit,
        objectPosition: st ? `${st.x ?? 50}% ${st.y ?? 50}%` : focus || undefined,
        transformOrigin: st ? `${st.x ?? 50}% ${st.y ?? 50}%` : undefined,
        transform: st?.zoom && st.zoom > 1 ? `scale(var(--img-zoom, ${st.zoom}))` : undefined,
        '--img-zoom': st?.zoom || 1,
    }

    return (
        <div className={`frame r-${ratio}${effectiveFit === 'contain' ? ' contain' : ''} ${className}`}>
            {url
                ? <img src={url} alt={alt} loading={eager ? 'eager' : 'lazy'} decoding="async" onError={() => setErr(true)} style={imgStyle} />
                : <span className="ph" aria-hidden="true">{fallback}</span>}
            {children}
        </div>
    )
}

/**
 * Circular avatar component that respects admin photo framing (zoom, focal point).
 */
export function Avatar({ src, alt = '', size = 34, fallback = 'U', className = '', style }) {
    const { settings } = useSite()
    const [err, setErr] = useState(false)
    const framing = getFramingStyle(settings.image_styles, src)
    const url = !src || err ? '' : img(src, { w: Math.max(120, size * 2) })

    return (
        <div
            className={`adm-avatar-circle ${className}`}
            style={{
                width: size,
                height: size,
                borderRadius: '50%',
                overflow: 'hidden',
                position: 'relative',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                background: 'var(--a-blue-soft, #e6f2fa)',
                ...style,
            }}
        >
            {url ? (
                <img
                    src={url}
                    alt={alt}
                    onError={() => setErr(true)}
                    style={{
                        width: '100%',
                        height: '100%',
                        display: 'block',
                        objectFit: 'cover',
                        ...framing,
                    }}
                />
            ) : (
                typeof fallback === 'string' ? (
                    <span style={{ fontWeight: 600, color: 'var(--a-blue, #00629b)', fontSize: `${Math.round(size * 0.42)}px` }}>
                        {fallback.toUpperCase()}
                    </span>
                ) : fallback
            )}
        </div>
    )
}
