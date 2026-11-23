import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api'
import { useAuth } from '../../hooks/useAuth'
import { PageTitle, Badge, Spinner, useToast, useConfirm, useLoader, fmtDate, Modal, Drawer, Switch, downloadCsv, Empty } from '../ui'
import { downloadXlsx } from '../../lib/xlsx'
import { ImageInput } from '../fields'
import { Avatar } from '../../components/Img'
import Icon from '../icons'

const ROLES = {
    member: 'Member / Standard User',
    editor: 'Editor — manages content, events, media, orders & queries',
    admin: 'Admin — everything incl. users, email & audit log',
}

const STANDARD_DOMAINS = [
    'Technical',
    'Project',
    'Editorial',
    'Design & Creative',
    'Research and Development',
    'Publicity',
    'Events & Management',
    'Out-Reach',
    'Finance',
    'Web Team',
]

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
    const [editingMember, setEditingMember] = useState(null)
    const [savingEdit, setSavingEdit] = useState(false)
    const [customDomain, setCustomDomain] = useState('')
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

    // Open edit drawer for a member
    const openEdit = m => {
        const mDomains = (m.domains || []).map(d => (typeof d === 'string' ? d : d.name)).filter(Boolean)
        setEditingMember({
            id: m.id,
            userId: m.userId,
            contentId: m.contentId,
            name: m.name || '',
            email: m.email || '',
            mobile: m.mobile || '',
            regNo: m.regNo || '',
            memberType: m.memberType || 'Core Member',
            systemRole: m.systemRole && m.systemRole !== '—' ? m.systemRole : 'member',
            active: m.active ?? true,
            position: m.primaryPosition || '',
            affiliation: m.affiliations?.[0] || 'recruited',
            domains: mDomains,
            avatarUrl: m.avatarUrl || '',
            oldAvatarUrl: m.avatarUrl || '',
            linkedin: m.linkedin || '',
            github: m.github || '',
            instagram: m.instagram || '',
            website: m.website || '',
            year: m.cmsLinks?.[0]?.year || '',
            group: m.cmsLinks?.[0]?.group || 'Board',
        })
        setCustomDomain('')
    }

    // Save edited member
    const saveEdit = async e => {
        e.preventDefault()
        if (!editingMember) return
        setSavingEdit(true)
        try {
            await api.put(`/admin/members-master/${editingMember.id}`, editingMember)
            toast('Member details updated successfully')
            setEditingMember(null)
            reload()
        } catch (err) {
            toast(err.message, 'error')
        } finally {
            setSavingEdit(false)
        }
    }

    // Toggle a domain for the editing member
    const toggleDomain = d => {
        setEditingMember(prev => {
            const list = prev.domains || []
            const exists = list.includes(d)
            return {
                ...prev,
                domains: exists ? list.filter(x => x !== d) : [...list, d],
            }
        })
    }

    // Add a custom domain tag
    const addCustomDomain = () => {
        const d = customDomain.trim()
        if (!d) return
        if (!editingMember.domains?.includes(d)) {
            setEditingMember(prev => ({ ...prev, domains: [...(prev.domains || []), d] }))
        }
        setCustomDomain('')
    }

    // Export Excel workbook (.xlsx) with multiple sheets
    const exportExcel = async () => {
        const headers = [
            'Name', 'Email', 'Position / Designation', 'Category', 'Domains',
            'System Role', 'Registration No', 'Mobile', 'Member Type', 'Affiliations',
            'Status', 'Photo URL', 'LinkedIn', 'GitHub', 'Instagram', 'Website',
            'Registered At', 'Last Login',
        ]
        const toRow = m => [
            m.name || '',
            m.email || '',
            m.primaryPosition || '',
            m.primaryCategory || '',
            (m.domains || []).map(d => typeof d === 'string' ? d : `${d.name}${d.status ? ` (${d.status})` : ''}`).join('; '),
            m.isRegistered ? (m.systemRole || 'member') : 'No Account',
            m.regNo || '',
            m.mobile || '',
            m.memberType || '',
            (m.affiliations || []).join(', '),
            m.active ? 'Active' : 'Inactive',
            m.avatarUrl || '',
            m.linkedin || '',
            m.github || '',
            m.instagram || '',
            m.website || '',
            m.createdAt ? fmtDate(m.createdAt) : '',
            m.lastLoginAt ? fmtDate(m.lastLoginAt) : '',
        ]

        const masterRows = [headers, ...filteredRows.map(toRow)]
        const recruitedRows = [headers, ...filteredRows.filter(m => m.affiliations?.includes('recruited')).map(toRow)]
        const boardRows = [headers, ...filteredRows.filter(m => m.affiliations?.includes('board') || m.affiliations?.includes('advisory')).map(toRow)]
        const webTeamRows = [headers, ...filteredRows.filter(m => m.affiliations?.includes('web_team')).map(toRow)]
        const usersRows = [headers, ...filteredRows.filter(m => m.isRegistered).map(toRow)]

        const sheets = [
            { name: 'Master Directory', rows: masterRows },
            { name: 'Recruited Core', rows: recruitedRows },
            { name: 'Board & Advisory', rows: boardRows },
            { name: 'Web Team', rows: webTeamRows },
            { name: 'Users with Roles', rows: usersRows },
        ]

        await downloadXlsx(`ieee-its-members-${tab}-${new Date().toISOString().slice(0, 10)}.xlsx`, sheets)
        toast('Excel workbook exported')
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
                <button className="adm-btn primary" disabled={!filteredRows.length} onClick={exportExcel} title="Export directory to Excel (.xlsx)">
                    <Icon name="download" size={15} /> Export Excel (.xlsx)
                </button>
                <button className="adm-btn" disabled={!filteredRows.length} onClick={exportData} title="Export directory to CSV">
                    Export CSV
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
                                                <Avatar
                                                    src={m.avatarUrl}
                                                    alt={m.name}
                                                    size={34}
                                                    fallback={(m.name?.[0] || 'U').toUpperCase()}
                                                />
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
                                                className="adm-btn small primary"
                                                onClick={() => openEdit(m)}
                                                title="Edit all details including photo, domains, position, social links"
                                            >
                                                <Icon name="edit" size={13} /> Edit
                                            </button>
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
                            <Avatar
                                src={selectedMember.avatarUrl}
                                alt={selectedMember.name}
                                size={64}
                                fallback={(selectedMember.name?.[0] || 'U').toUpperCase()}
                            />
                            <div style={{ flex: 1 }}>
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
                            <button
                                className="adm-btn small primary"
                                onClick={() => {
                                    const m = selectedMember
                                    setSelectedMember(null)
                                    openEdit(m)
                                }}
                            >
                                <Icon name="edit" size={13} /> Edit Details
                            </button>
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
                        {(selectedMember.linkedin || selectedMember.instagram || selectedMember.github || selectedMember.website) && (
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
                                    {selectedMember.github && (
                                        <a
                                            href={selectedMember.github}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="adm-btn small"
                                        >
                                            <Icon name="external" size={14} /> GitHub Profile
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
                                    {selectedMember.website && (
                                        <a
                                            href={selectedMember.website}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="adm-btn small"
                                        >
                                            <Icon name="external" size={14} /> Portfolio / Website
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

            {/* Edit Member Drawer */}
            <Drawer
                open={!!editingMember}
                title={editingMember ? `Edit Member · ${editingMember.name || 'Details'}` : 'Edit Member'}
                onClose={() => setEditingMember(null)}
                wide
            >
                {editingMember && (
                    <form className="adm-form" onSubmit={saveEdit} style={{ gap: 20 }}>
                        {/* Photo Section with Adjust & Remove */}
                        <fieldset className="adm-fieldset">
                            <legend>Member Photo</legend>
                            <ImageInput
                                value={editingMember.avatarUrl}
                                onChange={url => setEditingMember(prev => ({ ...prev, avatarUrl: url }))}
                            />
                            <p className="adm-hint" style={{ marginTop: 6 }}>
                                Upload or select from library. Click <strong>Adjust</strong> to fine-tune focal point, zoom, and frame crop. Clicking <strong>Remove</strong> immediately deletes the photo from ImageKit.
                            </p>
                        </fieldset>

                        {/* Basic Info */}
                        <fieldset className="adm-fieldset">
                            <legend>Basic Information</legend>
                            <div className="adm-grid-2">
                                <label className="adm-field">
                                    <span>Full Name</span>
                                    <input
                                        className="adm-input"
                                        value={editingMember.name}
                                        onChange={e => setEditingMember(prev => ({ ...prev, name: e.target.value }))}
                                        required
                                    />
                                </label>
                                <label className="adm-field">
                                    <span>Email Address</span>
                                    <input
                                        className="adm-input"
                                        type="email"
                                        value={editingMember.email}
                                        onChange={e => setEditingMember(prev => ({ ...prev, email: e.target.value }))}
                                        placeholder="name@vitstudent.ac.in"
                                    />
                                </label>
                            </div>
                        </fieldset>

                        {/* Position & Category */}
                        <fieldset className="adm-fieldset">
                            <legend>Role, Position & Affiliation</legend>
                            <div className="adm-grid-2">
                                <label className="adm-field">
                                    <span>Position / Designation</span>
                                    <input
                                        className="adm-input"
                                        value={editingMember.position}
                                        onChange={e => setEditingMember(prev => ({ ...prev, position: e.target.value }))}
                                        placeholder="e.g. Chairperson, Technical Lead, Core Member"
                                    />
                                </label>
                                <label className="adm-field">
                                    <span>Member Type</span>
                                    <select
                                        className="adm-input"
                                        value={editingMember.memberType}
                                        onChange={e => setEditingMember(prev => ({ ...prev, memberType: e.target.value }))}
                                    >
                                        <option value="Core Member">Core Member</option>
                                        <option value="Internal Member">Internal Member</option>
                                        <option value="External Member">External Member</option>
                                        <option value="Faculty">Faculty</option>
                                    </select>
                                </label>
                                <label className="adm-field">
                                    <span>Affiliation Category</span>
                                    <select
                                        className="adm-input"
                                        value={editingMember.affiliation}
                                        onChange={e => setEditingMember(prev => ({ ...prev, affiliation: e.target.value }))}
                                    >
                                        <option value="recruited">Recruited Core Member</option>
                                        <option value="board">Board Member</option>
                                        <option value="web_team">Web Team Member</option>
                                        <option value="advisory">Advisory Board (Past Member)</option>
                                        <option value="faculty">Faculty Coordinator</option>
                                        <option value="user">Registered User</option>
                                    </select>
                                </label>
                                {editingMember.affiliation === 'advisory' && (
                                    <>
                                        <label className="adm-field">
                                            <span>Board Year (e.g. 2024-2025)</span>
                                            <input
                                                className="adm-input"
                                                value={editingMember.year}
                                                onChange={e => setEditingMember(prev => ({ ...prev, year: e.target.value }))}
                                                placeholder="2024-2025"
                                            />
                                        </label>
                                        <label className="adm-field">
                                            <span>Past Group</span>
                                            <select
                                                className="adm-input"
                                                value={editingMember.group}
                                                onChange={e => setEditingMember(prev => ({ ...prev, group: e.target.value }))}
                                            >
                                                <option value="Board">Board</option>
                                                <option value="Web Team">Web Team</option>
                                            </select>
                                        </label>
                                    </>
                                )}
                            </div>
                        </fieldset>

                        {/* Domains (Multi-domain mapping) */}
                        <fieldset className="adm-fieldset">
                            <legend>Domains Mapping (can map to multiple domains)</legend>
                            <p className="adm-hint" style={{ margin: '0 0 10px' }}>
                                Select all domains this member belongs to or is mapped to:
                            </p>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                                {STANDARD_DOMAINS.map(d => {
                                    const isSelected = editingMember.domains?.includes(d)
                                    return (
                                        <button
                                            key={d}
                                            type="button"
                                            className={`adm-btn small ${isSelected ? 'primary' : 'ghost'}`}
                                            onClick={() => toggleDomain(d)}
                                            style={{ borderRadius: 16 }}
                                        >
                                            {isSelected ? '✓ ' : '+ '} {d}
                                        </button>
                                    )
                                })}
                            </div>
                            {editingMember.domains && editingMember.domains.length > 0 && (
                                <div style={{ marginBottom: 10 }}>
                                    <span className="adm-hint" style={{ display: 'block', marginBottom: 4 }}>Currently mapped domains:</span>
                                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                        {editingMember.domains.map(d => (
                                            <span
                                                key={d}
                                                className="adm-badge ok"
                                                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px' }}
                                            >
                                                {d}
                                                <button
                                                    type="button"
                                                    onClick={() => toggleDomain(d)}
                                                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: 0, fontSize: '0.8rem' }}
                                                    title="Remove domain"
                                                >
                                                    ✕
                                                </button>
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            )}
                            <div className="adm-row" style={{ gap: 8 }}>
                                <input
                                    className="adm-input"
                                    placeholder="Add custom domain…"
                                    value={customDomain}
                                    onChange={e => setCustomDomain(e.target.value)}
                                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCustomDomain() } }}
                                    style={{ maxWidth: 240 }}
                                />
                                <button type="button" className="adm-btn small" onClick={addCustomDomain}>
                                    + Add Domain
                                </button>
                            </div>
                        </fieldset>

                        {/* Social Media Links */}
                        <fieldset className="adm-fieldset">
                            <legend>Social Profiles & Links</legend>
                            <div className="adm-grid-2">
                                <label className="adm-field">
                                    <span>LinkedIn URL</span>
                                    <input
                                        className="adm-input"
                                        value={editingMember.linkedin}
                                        onChange={e => setEditingMember(prev => ({ ...prev, linkedin: e.target.value }))}
                                        placeholder="https://linkedin.com/in/username"
                                    />
                                </label>
                                <label className="adm-field">
                                    <span>GitHub URL</span>
                                    <input
                                        className="adm-input"
                                        value={editingMember.github}
                                        onChange={e => setEditingMember(prev => ({ ...prev, github: e.target.value }))}
                                        placeholder="https://github.com/username"
                                    />
                                </label>
                                <label className="adm-field">
                                    <span>Instagram URL</span>
                                    <input
                                        className="adm-input"
                                        value={editingMember.instagram}
                                        onChange={e => setEditingMember(prev => ({ ...prev, instagram: e.target.value }))}
                                        placeholder="https://instagram.com/username"
                                    />
                                </label>
                                <label className="adm-field">
                                    <span>Portfolio / Website URL</span>
                                    <input
                                        className="adm-input"
                                        value={editingMember.website}
                                        onChange={e => setEditingMember(prev => ({ ...prev, website: e.target.value }))}
                                        placeholder="https://portfolio.com"
                                    />
                                </label>
                            </div>
                        </fieldset>

                        {/* Contact & Registration Information */}
                        <fieldset className="adm-fieldset">
                            <legend>Identity & Contact Numbers</legend>
                            <div className="adm-grid-2">
                                <label className="adm-field">
                                    <span>Registration Number</span>
                                    <input
                                        className="adm-input"
                                        value={editingMember.regNo}
                                        onChange={e => setEditingMember(prev => ({ ...prev, regNo: e.target.value }))}
                                        placeholder="24BCE1001"
                                    />
                                </label>
                                <label className="adm-field">
                                    <span>Mobile Number</span>
                                    <input
                                        className="adm-input"
                                        value={editingMember.mobile}
                                        onChange={e => setEditingMember(prev => ({ ...prev, mobile: e.target.value }))}
                                        placeholder="9876543210"
                                    />
                                </label>
                            </div>
                        </fieldset>

                        {/* Account Role & Status */}
                        <fieldset className="adm-fieldset">
                            <legend>System Role & Account Status</legend>
                            <div className="adm-grid-2">
                                <label className="adm-field">
                                    <span>System Access Role</span>
                                    <select
                                        className="adm-input"
                                        value={editingMember.systemRole || 'member'}
                                        disabled={!isAdmin || (editingMember.userId && editingMember.userId === me?.id)}
                                        onChange={e => setEditingMember(prev => ({ ...prev, systemRole: e.target.value }))}
                                    >
                                        {Object.entries(ROLES).map(([k, v]) => (
                                            <option key={k} value={k}>{v}</option>
                                        ))}
                                    </select>
                                </label>
                                <div className="adm-field">
                                    <span>Account Status</span>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
                                        <Switch
                                            checked={editingMember.active}
                                            onChange={v => setEditingMember(prev => ({ ...prev, active: v }))}
                                        />
                                        <span>{editingMember.active ? 'Active' : 'Inactive'}</span>
                                    </div>
                                </div>
                            </div>
                        </fieldset>

                        {/* Form actions */}
                        <div className="adm-row end" style={{ marginTop: 10 }}>
                            <button
                                type="button"
                                className="adm-btn ghost"
                                onClick={() => setEditingMember(null)}
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                className="adm-btn primary"
                                disabled={savingEdit}
                            >
                                {savingEdit ? 'Saving…' : 'Save Changes'}
                            </button>
                        </div>
                    </form>
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
