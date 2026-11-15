/* Plain text written by an admin, with web links made clickable (PDF links then open in the site's viewer). */
const URL_RE = /(https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?])/g

export default function LinkedText({ text, as: Tag = 'span', ...rest }) {
    const parts = String(text || '').split(URL_RE)
    return (
        <Tag {...rest}>
            {parts.map((p, i) => (i % 2 ? <a key={i} href={p} target="_blank" rel="noreferrer">{p}</a> : p))}
        </Tag>
    )
}
