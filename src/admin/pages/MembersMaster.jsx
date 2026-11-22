import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api'
import { useAuth } from '../../hooks/useAuth'
import { PageTitle, Badge, Spinner, useToast, useConfirm, useLoader, fmtDate, Modal, Drawer, Switch, downloadCsv, Empty } from '../ui'
import Icon from '../icons'

const ROLES = {
    member: 'Member / Standard User',
    editor: 'Editor — manages content, events, media, orders & queries',
    admin: 'Admin — everything incl. users, email & audit log',
}

const TABS = [
    { key: 'all', label: 'All Directory' },
    { key: 'recruited', label: 'Recruited (Core Members)' },
    { key: 'board', label: 'Board Members' },
    { key: 'web_team', label: 'Web Team' },
    { key: 'advisory', label: 'Advisory Board' },
    { key: 'users', label: 'Users with Roles' },
    { key: 'applicant', label: 'Applicants' },
    { key: 'faculty', label: 'Faculty' },
]

export default function MembersMaster() {
    const { user: me, isAdmin } = useAuth()
    const toast = useToast()
    const confirm = useConfirm()
    const { data, loading, setData, reload } = useLoader(() => api.get('/admin/members-master').then(r => r.items), [])

    const [tab, setTab] = useState('all')
    const [q, setQ] = useState('')
    const [roleFilter, setRoleFilter] = useState('')
    const [domainFilter, setDomainFilter] = useState('')

    const [selectedMember, setSelectedMember] = useState(null)
    const [resetFor, setResetFor] = useState(null)
    const [pw, setPw] = useState('')
    const [creating, setCreating] = useState(null)

    const members = useMemo(() => data || [], [data])

    // Extract all unique domains across all members
    const allDomains = useMemo(() => {
        const set = new Set()
        for (const m of members) {
            for (const d of m.domains || []) {
                if (d.name) set.add(d.name)
            }
        }
        return Array.from(set).sort()
    }, [members])

    // Counts for tabs & summary
    const counts = useMemo(() => {
        const c = {
            all: members.length,
            recruited: 0,
            board: 0,
            web_team: 0,
            advisory: 0,
            users: 0,
            applicant: 0,
            faculty: 0,
            admins: 0,
            editors: 0,
            standardUsers: 0,
        }
        for (const m of members) {
            const aff = m.affiliations || []
            if (aff.includes('recruited')) c.recruited++
            if (aff.includes('board')) c.board++
            if (aff.includes('web_team')) c.web_team++
            if (aff.includes('advisory')) c.advisory++
            if (m.isRegistered) c.users++
            if (aff.includes('applicant')) c.applicant++
            if (aff.includes('faculty')) c.faculty++

            if (m.systemRole === 'admin') c.admins++
            else if (m.systemRole === 'editor') c.editors++
            else if (m.isRegistered) c.standardUsers++
        }
        return c
    }, [members])

    // Filter rows based on search, tab, role, and domain
    const filteredRows = useMemo(() => {
        return members.filter(m => {
            // Tab filter
            if (tab === 'recruited' && !m.affiliations?.includes('recruited')) return false
            if (tab === 'board' && !m.affiliations?.includes('board')) return false
            if (tab === 'web_team' && !m.affiliations?.includes('web_team')) return false
            if (tab === 'advisory' && !m.affiliations?.includes('advisory')) return false
            if (tab === 'users' && !m.isRegistered) return false
            if (tab === 'applicant' && !m.affiliations?.includes('applicant')) return false
            if (tab === 'faculty' && !m.affiliations?.includes('faculty')) return false

            // System Role filter
            if (roleFilter) {
                if (roleFilter === 'no_account' && m.isRegistered) return false
                if (roleFilter !== 'no_account' && m.systemRole !== roleFilter) return false
            }

            // Domain filter
            if (domainFilter) {
                const hasDomain = (m.domains || []).some(d => d.name === domainFilter)
                if (!hasDomain) return false
            }

            // Search query filter
            if (q.trim()) {
                const term = q.toLowerCase().trim()
                const searchStr = `${m.name || ''} ${m.email || ''} ${m.regNo || ''} ${m.mobile || ''} ${m.primaryPosition || ''} ${m.primaryCategory || ''} ${(m.domains || []).map(d => d.name).join(' ')} ${m.systemRole || ''}`.toLowerCase()
                if (!searchStr.includes(term)) return false
            }

            return true
        })
    }, [members, tab, roleFilter, domainFilter, q])

    // Update user role
    const patchRole = async (m, newRole) => {
        if (!m.userId) return
        try {
            await api.patch(`/admin/users/${m.userId}`, { role: newRole })
            setData(list => list.map(x => (x.userId === m.userId ? { ...x, systemRole: newRole } : x)))
            if (selectedMember?.userId === m.userId) {
                setSelectedMember(prev => ({ ...prev, systemRole: newRole }))
            }
            toast(`Role updated to ${newRole}`)
        } catch (err) {
            toast(err.message, 'error')
        }
    }

    // Toggle active state
    const patchActive = async (m, active) => {
        if (!m.userId) return
        try {
            await api.patch(`/admin/users/${m.userId}`, { active })
            setData(list => list.map(x => (x.userId === m.userId ? { ...x, active } : x)))
            if (selectedMember?.userId === m.userId) {
                setSelectedMember(prev => ({ ...prev, active }))
            }
            toast(active ? 'User activated' : 'User deactivated')
        } catch (err) {
            toast(err.message, 'error')
        }
    }

    // Create new user (admin only)
    const createUser = async e => {
        e.preventDefault()
        try {
            await api.post('/admin/users', creating)
            setCreating(null)
            toast('User created successfully')
            reload()
        } catch (err) {
            toast(err.message, 'error')
        }
    }

    // Delete user
    const removeUser = async m => {
        if (!m.userId) return
        if (!await confirm(`Delete account ${m.email}? Their orders and queries are preserved.`)) return
        try {
            await api.del(`/admin/users/${m.userId}`)
            setData(list => list.filter(x => x.userId !== m.userId))
            if (selectedMember?.userId === m.userId) setSelectedMember(null)
            toast('User account deleted')
        } catch (err) {
            toast(err.message, 'error')
        }
    }

    // Export CSV
    const exportData = () => {
        const rows = filteredRows.map(m => ({
            'Name': m.name || '',
            'Email': m.email || '',
            'Category': m.primaryCategory || '',
            'Position': m.primaryPosition || '',
            'Domains': (m.domains || []).map(d => `${d.name}${d.status ? ` (${d.status})` : ''}`).join('; '),
            'System Role': m.isRegistered ? (m.systemRole || 'member') : 'No Account',
            'Reg No': m.regNo || '',
            'Mobile': m.mobile || '',
            'Member Type': m.memberType || '',
            'Affiliations': (m.affiliations || []).join(', '),
            'Status': m.active ? 'Active' : 'Inactive',
            'Registered At': m.createdAt ? fmtDate(m.createdAt) : '',
            'Last Login': m.lastLoginAt ? fmtDate(m.lastLoginAt) : '',
        }))
        downloadCsv(`ieee-its-members-master-${tab}.csv`, rows)
    }

    return (
        <>
            <PageTitle
                title="Members Master"
                subtitle="Unified directory of all members, recruited candidates, board, advisory, web team, and users with roles across IEEE ITS."
            >
                <button className="adm-btn" disabled={!filteredRows.length} onClick={exportData} title="Export directory to CSV">
                    ⬇ Export CSV
                </button>
                {isAdmin && (
                    <>
                        <Link to="/admin/users" className="adm-btn" title="Go to Users with Roles">
                            <Icon name="lock" size={15} /> Users with Roles
                        </Link>
                        <button className="adm-btn primary" onClick={() => setCreating({ name: '', email: '', password: '', role: 'editor' })}>
                            <Icon name="plus" size={15} /> Add user
                        </button>
                    </>
                )}
            </PageTitle>

            {/* Top statistics summary cards */}
            <div className="adm-stats">
                <div className="adm-stat">
                    <span className="icon"><Icon name="users" size={24} /></span>
                    <div>
                        <strong>{counts.all}</strong>
                        <span>Total Directory</span>
                        <small>All people across ITS</small>
                    </div>
                </div>
                <div className="adm-stat">
                    <span className="icon"><Icon name="briefcase" size={24} /></span>
                    <div>
                        <strong>{counts.recruited}</strong>
                        <span>Recruited Core</span>
                        <small>Selected domain members</small>
                    </div>
                </div>
                <div className="adm-stat">
                    <span className="icon"><Icon name="award" size={24} /></span>
                    <div>
                        <strong>{counts.board + counts.advisory}</strong>
                        <span>Board & Advisory</span>
                        <small>{counts.board} current · {counts.advisory} past</small>
                    </div>
                </div>
                <div className="adm-stat">
                    <span className="icon"><Icon name="code" size={24} /></span>
                    <div>
                        <strong>{counts.web_team}</strong>
                        <span>Web Team</span>
                        <small>Developers & designers</small>
                    </div>
                </div>
                <div className="adm-stat">
                    <span className="icon"><Icon name="lock" size={24} /></span>
                    <div>
                        <strong>{counts.users}</strong>
                        <span>Users with Roles</span>
                        <small>{counts.admins} admins · {counts.editors} editors</small>
                    </div>
                </div>
            </div>

            {/* Filter Tabs */}
            <nav className="adm-tabs">
                {TABS.map(t => (
                    <button
                        key={t.key}
                        className={tab === t.key ? 'on' : ''}
                        onClick={() => setTab(t.key)}
                    >
                        {t.label} ({counts[t.key] ?? counts.all})
                    </button>
                ))}
            </nav>

            {/* Filter Bar */}
            <div className="adm-row wrap" style={{ gap: 10, marginBottom: 14 }}>
                <input
                    className="adm-input search"
                    style={{ minWidth: 260, flex: 1 }}
                    placeholder="Search name, email, reg no, mobile, position, domain, role…"
                    value={q}
                    onChange={e => setQ(e.target.value)}
                />
                <select
                    className="adm-input"
                    value={roleFilter}
                    onChange={e => setRoleFilter(e.target.value)}
                    style={{ maxWidth: 170 }}
                >
                    <option value="">All Roles</option>
                    <option value="admin">Admin</option>
                    <option value="editor">Editor</option>
                    <option value="member">Member / User</option>
                    <option value="no_account">No Account (CMS)</option>
                </select>

                {allDomains.length > 0 && (
                    <select
                        className="adm-input"
                        value={domainFilter}
                        onChange={e => setDomainFilter(e.target.value)}
                        style={{ maxWidth: 170 }}
                    >
                        <option value="">All Domains</option>
                        {allDomains.map(d => (
                            <option key={d} value={d}>{d}</option>
                        ))}
                    </select>
                )}

                {(q || roleFilter || domainFilter) && (
                    <button
                        className="adm-btn small ghost"
                        onClick={() => { setQ(''); setRoleFilter(''); setDomainFilter('') }}
                    >
                        Clear filters
                    </button>
                )}
            </div>

            {/* Members Table */}
            {loading ? (
                <Spinner />
            ) : filteredRows.length === 0 ? (
                <Empty icon="users">
                    No members match your search or filter.
                </Empty>
            ) : (
                <div className="adm-table-wrap">
                    <table className="adm-table">
                        <thead>
                            <tr>
                                <th>Person</th>
                                <th>Category / Affiliation</th>
                                <th>Position / Designation</th>
                                <th>Domain(s)</th>
                                <th>Role</th>
                                <th>Reg No / Mobile</th>
                                <th>Status</th>
                                <th style={{ textAlign: 'right' }}>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filteredRows.map(m => {
                                const isMe = m.userId && me && m.userId === me.id
                                return (
                                    <tr key={m.id}>
                                        {/* Person Name, Avatar & Email */}
                                        <td>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                                {m.avatarUrl ? (
                                                    <img
                                                        src={m.avatarUrl}
                                                        alt=""
                                                        style={{ width: 34, height: 34, borderRadius: '50%', objectFit: 'cover' }}
                                                    />
                                                ) : (
                                                    <span className="adm-avatar" style={{ width: 34, height: 34, fontSize: '0.9rem' }}>
                                                        {(m.name?.[0] || 'U').toUpperCase()}
                                                    </span>
                                                )}
                                                <div>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                                        <strong>{m.name || 'Unnamed'}</strong>
                                                        {isMe && <Badge tone="accent">You</Badge>}
                                                    </div>
                                                    <small style={{ color: 'var(--a-muted)' }}>{m.email || '—'}</small>
                                                </div>
                                            </div>
                                        </td>

                                        {/* Category / Affiliation Pills */}
                                        <td>
                                            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', maxWidth: 190 }}>
                                                {m.affiliations?.includes('board') && <Badge tone="ok">Board</Badge>}
                                                {m.affiliations?.includes('web_team') && <Badge tone="info">Web Team</Badge>}
                                                {m.affiliations?.includes('advisory') && <Badge tone="accent">Advisory</Badge>}
                                                {m.affiliations?.includes('recruited') && <Badge tone="ok">Recruited</Badge>}
                                                {m.affiliations?.includes('applicant') && !m.affiliations?.includes('recruited') && (
                                                    <Badge tone="warn">Applicant</Badge>
                                                )}
                                                {m.affiliations?.includes('faculty') && <Badge tone="neutral">Faculty</Badge>}
                                                {m.isRegistered && !m.affiliations?.some(a => ['board', 'web_team', 'advisory', 'recruited', 'faculty'].includes(a)) && (
                                                    <Badge tone="neutral">User</Badge>
                                                )}
                                            </div>
                                            <small style={{ display: 'block', marginTop: 3, color: 'var(--a-muted)' }}>
                                                {m.primaryCategory}
                                            </small>
                                        </td>

                                        {/* Position / Designation */}
                                        <td>
                                            <div style={{ fontWeight: 500 }}>{m.primaryPosition || '—'}</div>
                                            {m.cmsLinks?.[0]?.year && (
                                                <small style={{ color: 'var(--a-muted)' }}>Year: {m.cmsLinks[0].year}</small>
                                            )}
                                        </td>

                                        {/* Domain(s) */}
                                        <td>
                                            {m.domains && m.domains.length > 0 ? (
                                                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', maxWidth: 200 }}>
                                                    {m.domains.map((d, i) => (
                                                        <span
                                                            key={i}
                                                            className={`adm-badge ${d.status === 'selected' ? 'ok' : d.status === 'interview' ? 'warn' : d.status === 'applied' ? 'info' : 'neutral'}`}
                                                            title={`Status: ${d.status || 'applied'}${d.score != null ? ` · Score: ${d.score}` : ''}`}
                                                        >
                                                            {d.name}{d.status === 'selected' ? ' ✓' : ''}
                                                        </span>
                                                    ))}
                                                </div>
                                            ) : (
                                                <span className="adm-hint">—</span>
                                            )}
                                        </td>

                                        {/* System Role */}
                                        <td>
                                            {m.isRegistered ? (
                                                isAdmin ? (
                                                    <select
                                                        className="adm-input"
                                                        value={m.systemRole || 'member'}
                                                        disabled={isMe}
                                                        onChange={e => patchRole(m, e.target.value)}
                                                        style={{ padding: '4px 8px', fontSize: '0.82rem', maxWidth: 110 }}
                                                    >
                                                        <option value="member">Member</option>
                                                        <option value="editor">Editor</option>
                                                        <option value="admin">Admin</option>
                                                    </select>
                                                ) : (
                                                    <Badge tone={m.systemRole === 'admin' ? 'accent' : m.systemRole === 'editor' ? 'info' : 'neutral'}>
                                                        {m.systemRole === 'admin' ? 'Admin' : m.systemRole === 'editor' ? 'Editor' : 'Member'}
                                                    </Badge>
                                                )
                                            ) : (
                                                <span className="adm-hint" title="No registered account on the website">—</span>
                                            )}
                                        </td>

                                        {/* Reg No / Mobile */}
                                        <td>
                                            <div>{m.regNo || '—'}</div>
                                            <small style={{ color: 'var(--a-muted)' }}>{m.mobile || ''}</small>
                                        </td>

                                        {/* Status */}
                                        <td>
                                            {m.isRegistered && isAdmin ? (
                                                <Switch
                                                    checked={m.active}
                                                    onChange={v => !isMe && patchActive(m, v)}
                                                />
                                            ) : (
                                                <Badge tone={m.active ? 'ok' : 'neutral'}>
                                                    {m.active ? 'Active' : 'Inactive'}
                                                </Badge>
                                            )}
                                        </td>

                                        {/* Actions */}
                                        <td style={{ textAlign: 'right' }} className="nowrap">
                                            <button
                                                className="adm-btn small"
                                                onClick={() => setSelectedMember(m)}
                                                title="View full details"
                                            >
                                                Details
                                            </button>
                                            {m.isRegistered && isAdmin && (
                                                <button
                                                    className="adm-btn small ghost"
                                                    onClick={() => { setResetFor(m); setPw('') }}
                                                    title="Reset password"
                                                >
                                                    Reset PW
                                                </button>
                                            )}
                                            {m.isRegistered && isAdmin && !isMe && (
                                                <button
                                                    className="adm-btn small ghost danger-text"
                                                    onClick={() => removeUser(m)}
                                                    aria-label="Delete User Account"
                                                    title="Delete User Account"
                                                >
                                                    <Icon name="trash" size={15} />
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Member Details Drawer */}
            <Drawer
                open={!!selectedMember}
                title={selectedMember ? `${selectedMember.name} · Member Details` : 'Member Details'}
                onClose={() => setSelectedMember(null)}
                wide
            >
                {selectedMember && (
                    <div className="adm-form" style={{ gap: 20 }}>
                        {/* Member Header Card */}
                        <div className="adm-panel" style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                            {selectedMember.avatarUrl ? (
                                <img
                                    src={selectedMember.avatarUrl}
                                    alt=""
                                    style={{ width: 64, height: 64, borderRadius: '50%', objectFit: 'cover' }}
                                />
                            ) : (
                                <span className="adm-avatar" style={{ width: 64, height: 64, fontSize: '1.5rem' }}>
                                    {(selectedMember.name?.[0] || 'U').toUpperCase()}
                                </span>
                            )}
                            <div>
                                <h3 style={{ margin: '0 0 4px' }}>{selectedMember.name}</h3>
                                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
                                    {selectedMember.affiliations?.map(a => (
                                        <Badge key={a} tone={a === 'board' || a === 'recruited' ? 'ok' : a === 'web_team' ? 'info' : a === 'advisory' ? 'accent' : 'neutral'}>
                                            {a.toUpperCase()}
                                        </Badge>
                                    ))}
                                    {selectedMember.isRegistered && (
                                        <Badge tone="accent">
                                            ROLE: {selectedMember.systemRole?.toUpperCase() || 'MEMBER'}
                                        </Badge>
                                    )}
                                </div>
                                <small style={{ color: 'var(--a-muted)' }}>{selectedMember.primaryPosition}</small>
                            </div>
                        </div>

                        {/* Contact & Registration Information */}
                        <fieldset className="adm-fieldset">
                            <legend>Contact & Identity</legend>
                            <div className="adm-panel adm-kv">
                                <span>Email</span><b>{selectedMember.email || '—'}</b>
                                <span>Mobile</span><b>{selectedMember.mobile || '—'}</b>
                                <span>Registration No.</span><b>{selectedMember.regNo || '—'}</b>
                                <span>Member Type</span><b>{selectedMember.memberType || '—'}</b>
                                <span>Account Status</span><b><Badge tone={selectedMember.active ? 'ok' : 'neutral'}>{selectedMember.active ? 'Active' : 'Inactive'}</Badge></b>
                                <span>Registered At</span><b>{fmtDate(selectedMember.createdAt)}</b>
                                <span>Last Login</span><b>{fmtDate(selectedMember.lastLoginAt)}</b>
                            </div>
                        </fieldset>

                        {/* Organizational Positions & Affiliations */}
                        <fieldset className="adm-fieldset">
                            <legend>Positions in IEEE ITS</legend>
                            <div className="adm-stack" style={{ gap: 8 }}>
                                <div className="adm-panel">
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                        <div>
                                            <strong>Primary Position: {selectedMember.primaryPosition}</strong>
                                            <small style={{ display: 'block', color: 'var(--a-muted)' }}>
                                                Category: {selectedMember.primaryCategory}
                                            </small>
                                        </div>
                                    </div>
                                </div>

                                {selectedMember.cmsLinks?.map((c, i) => (
                                    <div key={i} className="adm-panel" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                        <div>
                                            <strong>{c.type === 'board' ? 'Board Member' : c.type === 'web_team' ? 'Web Team' : c.type === 'advisory' ? 'Advisory Board' : 'Faculty'}: {c.role}</strong>
                                            {c.year && <small style={{ display: 'block', color: 'var(--a-muted)' }}>Tenure: {c.year} {c.group ? `(${c.group})` : ''}</small>}
                                        </div>
                                        <Link to={`/admin/c/${c.type}`} className="adm-btn small ghost">
                                            Edit in CMS →
                                        </Link>
                                    </div>
                                ))}
                            </div>
                        </fieldset>

                        {/* Recruitment Applications (if candidate) */}
                        {selectedMember.applications && selectedMember.applications.length > 0 && (
                            <fieldset className="adm-fieldset">
                                <legend>Recruitment Applications ({selectedMember.applications.length})</legend>
                                <div className="adm-table-wrap">
                                    <table className="adm-table">
                                        <thead>
                                            <tr>
                                                <th>Domain</th>
                                                <th>Status</th>
                                                <th>Source</th>
                                                <th>Score</th>
                                                <th>Applied At</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {selectedMember.applications.map(app => (
                                                <tr key={app.id}>
                                                    <td><strong>{app.domain}</strong></td>
                                                    <td>
                                                        <Badge tone={app.status === 'selected' ? 'ok' : app.status === 'interview' ? 'warn' : app.status === 'applied' ? 'info' : 'neutral'}>
                                                            {app.status}
                                                        </Badge>
                                                    </td>
                                                    <td><small>{app.source || 'portal'}</small></td>
                                                    <td>{app.score != null ? `${app.score}${app.maxScore ? ` / ${app.maxScore}` : ''}` : '—'}</td>
                                                    <td><small>{fmtDate(app.createdAt)}</small></td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                                <div style={{ marginTop: 8 }}>
                                    <Link to="/admin/recruitment" className="adm-link">
                                        Manage in Recruitment Admin →
                                    </Link>
                                </div>
                            </fieldset>
                        )}

                        {/* Social Profile Links */}
                        {(selectedMember.linkedin || selectedMember.instagram) && (
                            <fieldset className="adm-fieldset">
                                <legend>Social Profiles</legend>
                                <div className="adm-row wrap" style={{ gap: 10 }}>
                                    {selectedMember.linkedin && (
                                        <a
                                            href={selectedMember.linkedin}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="adm-btn small"
                                        >
                                            <Icon name="external" size={14} /> LinkedIn Profile
                                        </a>
                                    )}
                                    {selectedMember.instagram && (
                                        <a
                                            href={selectedMember.instagram}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="adm-btn small"
                                        >
                                            <Icon name="external" size={14} /> Instagram Profile
                                        </a>
                                    )}
                                </div>
                            </fieldset>
                        )}

                        {/* Admin Role Control */}
                        {selectedMember.isRegistered && isAdmin && (
                            <fieldset className="adm-fieldset">
                                <legend>System Role & Account Management</legend>
                                <div className="adm-grid-2">
                                    <label className="adm-field">
                                        <span>Change System Role</span>
                                        <select
                                            className="adm-input"
                                            value={selectedMember.systemRole || 'member'}
                                            disabled={selectedMember.userId === me?.id}
                                            onChange={e => patchRole(selectedMember, e.target.value)}
                                        >
                                            {Object.entries(ROLES).map(([k, v]) => (
                                                <option key={k} value={k}>{v}</option>
                                            ))}
                                        </select>
                                    </label>
                                    <div className="adm-field">
                                        <span>Password Reset</span>
                                        <button
                                            type="button"
                                            className="adm-btn"
                                            onClick={() => { setResetFor(selectedMember); setPw('') }}
                                        >
                                            Reset Password
                                        </button>
                                    </div>
                                </div>
                            </fieldset>
                        )}
                    </div>
                )}
            </Drawer>

            {/* Add User Modal */}
            <Modal open={!!creating} onClose={() => setCreating(null)} title="Add user to IEEE ITS">
                {creating && (
                    <form className="adm-form" onSubmit={createUser}>
                        <label className="adm-field">
                            <span>Name</span>
                            <input
                                className="adm-input"
                                value={creating.name}
                                onChange={e => setCreating(c => ({ ...c, name: e.target.value }))}
                                required
                            />
                        </label>
                        <label className="adm-field">
                            <span>Email</span>
                            <input
                                className="adm-input"
                                type="email"
                                value={creating.email}
                                onChange={e => setCreating(c => ({ ...c, email: e.target.value }))}
                                required
                            />
                        </label>
                        <label className="adm-field">
                            <span>Temporary password</span>
                            <input
                                className="adm-input"
                                type="text"
                                value={creating.password}
                                onChange={e => setCreating(c => ({ ...c, password: e.target.value }))}
                                required
                                minLength={8}
                                placeholder="8+ chars, letters + numbers"
                            />
                        </label>
                        <label className="adm-field">
                            <span>Role</span>
                            <select
                                className="adm-input"
                                value={creating.role}
                                onChange={e => setCreating(c => ({ ...c, role: e.target.value }))}
                            >
                                {Object.entries(ROLES).map(([k, v]) => (
                                    <option key={k} value={k}>{v}</option>
                                ))}
                            </select>
                        </label>
                        <div className="adm-row end">
                            <button className="adm-btn ghost" type="button" onClick={() => setCreating(null)}>Cancel</button>
                            <button className="adm-btn primary" type="submit">Create user</button>
                        </div>
                    </form>
                )}
            </Modal>

            {/* Password Reset Modal */}
            <Modal open={!!resetFor} onClose={() => setResetFor(null)} title={`Reset password · ${resetFor?.email}`}>
                <form
                    className="adm-form"
                    onSubmit={async e => {
                        e.preventDefault()
                        try {
                            await api.patch(`/admin/users/${resetFor.userId}`, { newPassword: pw })
                            toast('Password reset — existing sessions signed out')
                            setResetFor(null)
                        } catch (err) {
                            toast(err.message, 'error')
                        }
                    }}
                >
                    <label className="adm-field">
                        <span>New password</span>
                        <input
                            className="adm-input"
                            type="text"
                            value={pw}
                            onChange={e => setPw(e.target.value)}
                            required
                            minLength={8}
                        />
                    </label>
                    <p className="adm-hint">Share it with the member privately and ask them to change it from their profile.</p>
                    <div className="adm-row end">
                        <button className="adm-btn ghost" type="button" onClick={() => setResetFor(null)}>Cancel</button>
                        <button className="adm-btn primary" type="submit">Reset password</button>
                    </div>
                </form>
            </Modal>
        </>
    )
}
