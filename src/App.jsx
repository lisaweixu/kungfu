import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** NFC + zh-CN folding so Chinese (and mixed 中文+English) search matches reliably. */
function normalizeForSearch(s) {
  return String(s ?? '')
    .normalize('NFC')
    .toLocaleLowerCase('zh-CN');
}

function memberMatchesQuery(m, needleNorm) {
  if (!needleNorm) return true;
  return (
    normalizeForSearch(m.name).includes(needleNorm) ||
    normalizeForSearch(m.phone).includes(needleNorm) ||
    normalizeForSearch(m.email).includes(needleNorm) ||
    normalizeForSearch(m.notes).includes(needleNorm)
  );
}

/** SQLite stores timestamps as UTC strings ('YYYY-MM-DD HH:MM:SS', no Z); render in local time. */
function toLocalDateTime(s) {
  if (!s) return '';
  const utc = s.includes('T')
    ? s.endsWith('Z') ? s : s + 'Z'
    : s.replace(' ', 'T') + 'Z';
  const d = new Date(utc);
  if (Number.isNaN(d.getTime())) return s;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text || 'Invalid response' };
  }
  if (!res.ok) {
    const msg = data?.error || res.statusText || 'Request failed';
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data;
}

export default function App() {
  const [members, setMembers] = useState([]);
  const [classTypes, setClassTypes] = useState([]);
  const [q, setQ] = useState('');
  /** Filter text applied to the list; lags `q` while an IME composition is active. */
  const [filterQ, setFilterQ] = useState('');
  const searchComposing = useRef(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const reloadClassTypes = useCallback(async () => {
    try {
      const types = await api('/api/class-types');
      setClassTypes(types);
    } catch (e) {
      setErr(e.message);
    }
  }, []);

  const loadMembers = useCallback(async () => {
    setErr(null);
    setLoading(true);
    try {
      const [list, types] = await Promise.all([
        api('/api/members'),
        api('/api/class-types'),
      ]);
      setMembers(list);
      setClassTypes(types);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMembers();
  }, [loadMembers]);

  const filtered = useMemo(() => {
    const needleNorm = normalizeForSearch(filterQ.trim());
    if (!needleNorm) return members;
    return members.filter((m) => memberMatchesQuery(m, needleNorm));
  }, [members, filterQ]);

  const openMember = async (id) => {
    setErr(null);
    setSelectedId(id);
    setShowNew(false);
    try {
      const d = await api(`/api/members/${id}`);
      setDetail(d);
    } catch (e) {
      setErr(e.message);
      setSelectedId(null);
      setDetail(null);
    }
  };

  const refreshDetail = async (id) => {
    if (!id) return;
    const d = await api(`/api/members/${id}`);
    setDetail(d);
  };

  if (showNew) {
    return (
      <NewMemberForm
        onCancel={() => setShowNew(false)}
        onCreated={async (id) => {
          setShowNew(false);
          await loadMembers();
          await openMember(id);
        }}
        setErr={setErr}
      />
    );
  }

  if (selectedId && detail) {
    return (
      <MemberDetail
        detail={detail}
        classTypes={classTypes}
        onBack={() => {
          setSelectedId(null);
          setDetail(null);
          loadMembers();
        }}
        onRefresh={() => refreshDetail(selectedId)}
        setErr={setErr}
      />
    );
  }

  if (showSummary) {
    return (
      <SummaryView
        onBack={() => {
          setShowSummary(false);
          loadMembers();
        }}
        onOpenMember={async (id) => {
          setShowSummary(false);
          await openMember(id);
        }}
        setErr={setErr}
      />
    );
  }

  if (showSettings) {
    return (
      <SettingsView
        onBack={() => setShowSettings(false)}
        setErr={setErr}
        classTypes={classTypes}
        reloadClassTypes={reloadClassTypes}
      />
    );
  }

  return (
    <>
      <h1>KungFu</h1>
      <p className="sub">
        {classTypes.length
          ? `${classTypes.length} class types — credits are tracked per class. Tap a member to add credits or mark attendance.`
          : 'Class credits — tap a member to add classes or mark attendance.'}
      </p>
      {err ? <p className="error">{err}</p> : null}
      <div className="toolbar">
        <input
          type="search"
          placeholder="Search members…"
          lang="zh-CN"
          autoComplete="off"
          spellCheck={false}
          value={q}
          onChange={(e) => {
            const v = e.target.value;
            setQ(v);
            if (!searchComposing.current) setFilterQ(v);
          }}
          onCompositionStart={() => {
            searchComposing.current = true;
          }}
          onCompositionEnd={(e) => {
            searchComposing.current = false;
            const v = e.currentTarget.value;
            setQ(v);
            setFilterQ(v);
          }}
          aria-label="Search members"
        />
        <button type="button" onClick={() => setShowNew(true)}>
          New member
        </button>
        <button type="button" className="secondary" onClick={loadMembers} disabled={loading}>
          Refresh
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setErr(null);
            setShowSummary(true);
          }}
        >
          Summary
        </button>
        <button
          type="button"
          className="secondary settings-button"
          onClick={() => {
            setErr(null);
            setShowSettings(true);
          }}
          aria-label="Settings"
          title="Settings"
        >
          ⚙ Settings
        </button>
      </div>
      {loading ? (
        <p>Loading…</p>
      ) : (
        <ul className="list">
          {filtered.map((m) => (
            <li key={m.id} className={m.active ? '' : 'inactive'}>
              <button type="button" className="row" onClick={() => openMember(m.id)}>
                <span className="name">{m.name}</span>
                <span className="balance">{m.balance} total</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function SummaryView({ onBack, onOpenMember, setErr }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [emailModalClass, setEmailModalClass] = useState(null);
  const [emailWholeClub, setEmailWholeClub] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    setLoading(true);
    try {
      const s = await api('/api/summary');
      setData(s);
    } catch (e) {
      setErr(e.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [setErr]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading && !data) {
    return (
      <div className="summary-page">
        <h1>Club summary</h1>
        <p>Loading…</p>
        <div className="toolbar">
          <button type="button" className="secondary" onClick={onBack}>
            Back
          </button>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="summary-page">
        <h1>Club summary</h1>
        <p className="error">Could not load summary.</p>
        <div className="toolbar">
          <button type="button" className="secondary" onClick={onBack}>
            Back
          </button>
          <button type="button" onClick={load}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  const { classTypes, members } = data;

  return (
    <div className="summary-page">
      <h1>Club summary</h1>
      <p className="sub summary-intro">
        Every member: total credits left, phone, then each class — <strong>credits left</strong> (prepaid
        minus used) and <strong>visits</strong> (times attendance was recorded for that class). Tap a name
        to open their detail.
      </p>
      <div className="toolbar">
        <button type="button" className="secondary" onClick={onBack}>
          Back
        </button>
        <button type="button" className="secondary" onClick={load} disabled={loading}>
          Refresh
        </button>
        <button
          type="button"
          className="secondary summary-club-email-btn"
          onClick={() => setEmailWholeClub(true)}
          title="Email all members who have credits and an email"
        >
          📧 Email whole club
        </button>
      </div>
      {emailWholeClub ? (
        <ClubEmailModal
          onClose={() => setEmailWholeClub(false)}
          onSent={() => setEmailWholeClub(false)}
          setErr={setErr}
        />
      ) : null}
      {emailModalClass ? (
        <ClassEmailModal
          classType={emailModalClass}
          onClose={() => setEmailModalClass(null)}
          onSent={() => setEmailModalClass(null)}
          setErr={setErr}
        />
      ) : null}

      <div className="summary-table-wrap">
        <table className="summary-table">
          <thead>
            <tr>
              <th className="summary-sticky-col summary-corner">Member</th>
              <th className="summary-sticky-total num">Total</th>
              <th className="summary-age-col num">Age</th>
              <th className="summary-phone-col">Phone</th>
              <th className="summary-email-col">Email</th>
              {classTypes.map((c) => (
                <th key={c.id} className="summary-class-head">
                  <span className="summary-class-head-name">{c.name}</span>
                  <span className="summary-class-head-sub">left / visits</span>
                  <button
                    type="button"
                    className="summary-class-email-btn"
                    onClick={() => setEmailModalClass(c)}
                    title={`Email members in ${c.name}`}
                  >
                    📧 Email
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {members.length === 0 ? (
              <tr>
                <td colSpan={5 + classTypes.length} className="summary-empty-row">
                  No members yet — add one from the home screen.
                </td>
              </tr>
            ) : (
              members.map((m) => (
                <tr key={m.id} className={m.active ? '' : 'summary-inactive'}>
                  <td className="summary-sticky-col">
                    <button
                      type="button"
                      className="summary-member-link"
                      onClick={() => onOpenMember(m.id)}
                    >
                      {m.name}
                    </button>
                    {!m.active ? <span className="summary-badge">inactive</span> : null}
                  </td>
                  <td className="summary-sticky-total num summary-total">{m.balanceTotal}</td>
                  <td className="summary-age-col num">{m.age ?? '—'}</td>
                  <td className="summary-phone-col" title={m.phone || ''}>
                    {m.phone || '—'}
                  </td>
                  <td className="summary-email-col" title={m.email || ''}>
                    {m.email || '—'}
                  </td>
                  {m.byClass.map((cell) => {
                    const empty = cell.balance === 0 && cell.visits === 0;
                    return (
                      <td key={cell.classId} className="summary-class-cell">
                        {empty ? (
                          <span className="summary-empty">—</span>
                        ) : (
                          <>
                            <span className="summary-bal">{cell.balance}</span>
                            <span className="summary-vis">{cell.visits} visits</span>
                          </>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ClubEmailModal({ onClose, onSent, setErr }) {
  const [recipients, setRecipients] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showRecipients, setShowRecipients] = useState(false);
  const [subject, setSubject] = useState(`KungFu club announcement / 俱乐部通知 — ${localDateIso()}`);
  const [body, setBody] = useState(
    [
      `Hi everyone,`,
      ``,
      `[Your message here — e.g. holiday hours, belt test, parking, general reminder.]`,
      ``,
      `大家好，`,
      ``,
      `[在此填写中文内容。]`,
      ``,
      `— KungFu Club`,
    ].join('\n')
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api('/api/club/email-recipients');
        if (!cancelled) setRecipients(r);
      } catch (e) {
        if (!cancelled) setErr(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setErr]);

  const send = async () => {
    setErr(null);
    if (!subject.trim() || !body.trim()) {
      setErr('Subject and body are required.');
      return;
    }
    if (!confirm(`Send email to ${recipients?.recipients?.length ?? 0} recipient(s)?`)) return;
    setBusy(true);
    try {
      await api('/api/club/email', {
        method: 'POST',
        body: JSON.stringify({ subject: subject.trim(), body: body.trim() }),
      });
      onSent();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const recCount = recipients?.recipients?.length ?? 0;
  const noEmail = recipients?.withoutEmail ?? 0;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Email whole club</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {loading ? (
          <p className="sub">Loading recipients…</p>
        ) : (
          <>
            <p className="sub">
              <strong>{recCount}</strong> recipient
              {recCount === 1 ? '' : 's'} (active members with credits left + email).
              {noEmail > 0 ? (
                <>
                  {' '}
                  <span className="sub-warn">
                    {noEmail} active member{noEmail === 1 ? ' has' : 's have'} credits but no email — they
                    will not be notified.
                  </span>
                </>
              ) : null}
            </p>

            <button
              type="button"
              className="link-button"
              onClick={() => setShowRecipients((v) => !v)}
            >
              {showRecipients ? 'Hide' : 'Show'} recipient list
            </button>
            {showRecipients ? (
              <ul className="recipients-list">
                {recipients.recipients.map((r) => (
                  <li key={r.id}>
                    <span>{r.name}</span>
                    <span className="recipient-email">{r.email}</span>
                  </li>
                ))}
              </ul>
            ) : null}

            <label>
              Subject
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                maxLength={200}
              />
            </label>
            <label>
              Message body
              <textarea
                rows={10}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                maxLength={10000}
              />
            </label>
            <p className="sub">
              All recipients will be in BCC for privacy. From = your owner email.
            </p>

            <div className="modal-actions">
              <button type="button" className="secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                onClick={send}
                disabled={busy || !recCount || !subject.trim() || !body.trim()}
              >
                {busy ? 'Sending…' : `Send to ${recCount}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ClassEmailModal({ classType, onClose, onSent, setErr }) {
  const [recipients, setRecipients] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showRecipients, setShowRecipients] = useState(false);
  const [subject, setSubject] = useState(
    `${classType.name} 课程取消 / Class cancelled — ${localDateIso()}`
  );
  const [body, setBody] = useState(
    [
      `Hi everyone,`,
      ``,
      `${classType.name} class is cancelled today (${localDateIso()}).`,
      `Reason: [bad weather / instructor sick / other].`,
      `Your credit balance is unaffected.`,
      ``,
      `Sorry for the inconvenience — see you next time!`,
      ``,
      `各位好，今天${classType.name}的课程取消。`,
      `原因：天气恶劣 / 老师生病 / 其他。`,
      `您的课时不受影响，下次见！`,
    ].join('\n')
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api(`/api/class-types/${classType.id}/email-recipients`);
        if (!cancelled) setRecipients(r);
      } catch (e) {
        if (!cancelled) setErr(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [classType.id, setErr]);

  const send = async () => {
    setErr(null);
    if (!subject.trim() || !body.trim()) {
      setErr('Subject and body are required.');
      return;
    }
    if (!confirm(`Send email to ${recipients?.recipients?.length ?? 0} recipient(s)?`)) return;
    setBusy(true);
    try {
      await api(`/api/class-types/${classType.id}/email`, {
        method: 'POST',
        body: JSON.stringify({ subject: subject.trim(), body: body.trim() }),
      });
      onSent();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const recCount = recipients?.recipients?.length ?? 0;
  const noEmail = recipients?.withoutEmail ?? 0;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Email {classType.name}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {loading ? (
          <p className="sub">Loading recipients…</p>
        ) : (
          <>
            <p className="sub">
              <strong>{recCount}</strong> recipient
              {recCount === 1 ? '' : 's'} (active members with credits + email).
              {noEmail > 0 ? (
                <>
                  {' '}
                  <span className="sub-warn">
                    {noEmail} active member{noEmail === 1 ? ' has' : 's have'} credits but no email — they
                    will not be notified.
                  </span>
                </>
              ) : null}
            </p>

            <button
              type="button"
              className="link-button"
              onClick={() => setShowRecipients((v) => !v)}
            >
              {showRecipients ? 'Hide' : 'Show'} recipient list
            </button>
            {showRecipients ? (
              <ul className="recipients-list">
                {recipients.recipients.map((r) => (
                  <li key={r.id}>
                    <span>{r.name}</span>
                    <span className="recipient-email">{r.email}</span>
                  </li>
                ))}
              </ul>
            ) : null}

            <label>
              Subject
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                maxLength={200}
              />
            </label>
            <label>
              Message body
              <textarea
                rows={10}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                maxLength={10000}
              />
            </label>
            <p className="sub">
              All recipients will be in BCC for privacy. From = your owner email.
            </p>

            <div className="modal-actions">
              <button type="button" className="secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                onClick={send}
                disabled={busy || !recCount || !subject.trim() || !body.trim()}
              >
                {busy ? 'Sending…' : `Send to ${recCount}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function NewMemberForm({ onCancel, onCreated, setErr }) {
  const [name, setName] = useState('');
  const [age, setAge] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const { id } = await api('/api/members', {
        method: 'POST',
        body: JSON.stringify({ name, age, phone, email, notes }),
      });
      await onCreated(Number(id));
    } catch (err) {
      setErr(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>New member</h1>
      <div className="toolbar">
        <button type="button" className="secondary" onClick={onCancel}>
          Back
        </button>
      </div>
      <form className="card" onSubmit={submit}>
        <label>
          Name *
          <input
            lang="zh-CN"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <label>
          Age
          <input
            type="number"
            min={1}
            max={120}
            value={age}
            onChange={(e) => setAge(e.target.value)}
          />
        </label>
        <label>
          Phone
          <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </label>
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="off"
          />
        </label>
        <label>
          Notes
          <textarea lang="zh-CN" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <button type="submit" disabled={busy}>
          Save
        </button>
      </form>
    </>
  );
}

const VALIDITY_OPTIONS = [
  { value: '3m', label: '3 months', months: 3 },
  { value: '6m', label: '6 months', months: 6 },
  { value: '12m', label: '12 months', months: 12 },
  { value: 'never', label: 'Never expires', months: null },
];

function localDateIso(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isoDatePlusMonths(months) {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return localDateIso(d);
}

function MemberDetail({ detail, classTypes, onBack, onRefresh, setErr }) {
  const { member, balance, balancesByClass, ledger, batches } = detail;
  const firstClassId = classTypes[0]?.id ?? 1;
  const [purchaseClassId, setPurchaseClassId] = useState(firstClassId);
  const [attendClassId, setAttendClassId] = useState(firstClassId);
  const [classesToAdd, setClassesToAdd] = useState(10);
  const [takeCount, setTakeCount] = useState(1);
  const [notePurchase, setNotePurchase] = useState('');
  const [noteAttend, setNoteAttend] = useState('');
  const [purchaseValidity, setPurchaseValidity] = useState('12m');
  const [busy, setBusy] = useState(false);
  const [showAddCredits, setShowAddCredits] = useState(false);
  const [collapsedClassIds, setCollapsedClassIds] = useState(() => new Set());
  const toggleClassCollapsed = (classId) => {
    setCollapsedClassIds((prev) => {
      const next = new Set(prev);
      if (next.has(classId)) next.delete(classId);
      else next.add(classId);
      return next;
    });
  };
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(member.name ?? '');
  const [editAge, setEditAge] = useState(member.age ?? '');
  const [editPhone, setEditPhone] = useState(member.phone ?? '');
  const [editEmail, setEditEmail] = useState(member.email ?? '');
  const [editNotes, setEditNotes] = useState(member.notes ?? '');

  const startEdit = () => {
    setErr(null);
    setEditName(member.name ?? '');
    setEditAge(member.age ?? '');
    setEditPhone(member.phone ?? '');
    setEditEmail(member.email ?? '');
    setEditNotes(member.notes ?? '');
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setErr(null);
  };

  const saveEdit = async () => {
    setErr(null);
    if (!editName.trim()) {
      setErr('Name is required.');
      return;
    }
    if (editEmail.trim() && !/^\S+@\S+\.\S+$/.test(editEmail.trim())) {
      setErr('Email is not valid.');
      return;
    }
    setBusy(true);
    try {
      await api(`/api/members/${member.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editName.trim(),
          age: editAge === '' ? null : Number(editAge),
          phone: editPhone.trim() || null,
          email: editEmail.trim() || null,
          notes: editNotes.trim() || null,
        }),
      });
      setEditing(false);
      await onRefresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!classTypes.length) return;
    const ok = (id) => classTypes.some((c) => c.id === id);
    setPurchaseClassId((id) => (ok(id) ? id : classTypes[0].id));
    setAttendClassId((id) => (ok(id) ? id : classTypes[0].id));
  }, [classTypes]);

  const balanceForSelectedClass = (classId) => {
    const row = balancesByClass?.find((b) => b.classId === classId);
    return row?.balance ?? 0;
  };

  const attendClassBalance = balanceForSelectedClass(attendClassId);

  const doPurchase = async () => {
    setErr(null);
    const opt = VALIDITY_OPTIONS.find((o) => o.value === purchaseValidity);
    const noExpiry = opt?.months == null;
    const expiresAt = noExpiry ? null : isoDatePlusMonths(opt.months);
    setBusy(true);
    try {
      await api(`/api/members/${member.id}/purchase`, {
        method: 'POST',
        body: JSON.stringify({
          classId: purchaseClassId,
          classes: classesToAdd,
          note: notePurchase,
          expiresAt,
          noExpiry,
        }),
      });
      setNotePurchase('');
      setShowAddCredits(false);
      await onRefresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const openAddCredits = () => {
    setErr(null);
    setShowAddCredits(true);
  };

  const closeAddCredits = () => {
    if (busy) return;
    setShowAddCredits(false);
  };

  const doAttend = async () => {
    setErr(null);
    setBusy(true);
    try {
      await api(`/api/members/${member.id}/attend`, {
        method: 'POST',
        body: JSON.stringify({
          classId: attendClassId,
          count: takeCount,
          note: noteAttend,
        }),
      });
      setNoteAttend('');
      await onRefresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async () => {
    setErr(null);
    setBusy(true);
    try {
      await api(`/api/members/${member.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !member.active }),
      });
      await onRefresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>{member.name}</h1>
      <p className="sub">
        <strong className="balance">{balance}</strong> credits total (all classes)
        {!member.active ? ' · inactive' : ''}
      </p>
      <div className="toolbar">
        <button type="button" className="secondary" onClick={onBack}>
          Back
        </button>
        <button type="button" className="secondary" onClick={toggleActive} disabled={busy || editing}>
          {member.active ? 'Mark inactive' : 'Mark active'}
        </button>
      </div>

      {editing ? (
        <div className="card">
          <h2>Edit member</h2>
          <label>
            Name *
            <input
              lang="zh-CN"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              required
            />
          </label>
          <div className="row2">
            <label>
              Age
              <input
                type="number"
                min={1}
                max={120}
                value={editAge}
                onChange={(e) => setEditAge(e.target.value)}
              />
            </label>
            <label>
              Phone
              <input
                type="tel"
                value={editPhone}
                onChange={(e) => setEditPhone(e.target.value)}
              />
            </label>
          </div>
          <label>
            Email
            <input
              type="email"
              value={editEmail}
              onChange={(e) => setEditEmail(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label>
            Notes
            <textarea
              lang="zh-CN"
              value={editNotes}
              onChange={(e) => setEditNotes(e.target.value)}
            />
          </label>
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={cancelEdit} disabled={busy}>
              Cancel
            </button>
            <button type="button" onClick={saveEdit} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      ) : (
        <div className="card member-info">
          <div className="member-info-head">
            <h2>Member info</h2>
            <button
              type="button"
              className="secondary member-info-edit-btn"
              onClick={startEdit}
              disabled={busy}
            >
              Edit info
            </button>
          </div>
          <ul className="info-list">
            <li>
              <span className="info-label">Age</span>
              <span>{member.age ?? '—'}</span>
            </li>
            <li>
              <span className="info-label">Phone</span>
              <span>{member.phone || '—'}</span>
            </li>
            <li>
              <span className="info-label">Email</span>
              <span>{member.email || '—'}</span>
            </li>
            {member.notes ? (
              <li>
                <span className="info-label">Notes</span>
                <span>{member.notes}</span>
              </li>
            ) : null}
          </ul>
        </div>
      )}


      <div className="card">
        <div className="member-info-head">
          <h2>Credits</h2>
          <button
            type="button"
            className="secondary member-info-edit-btn"
            onClick={openAddCredits}
            disabled={busy || !classTypes.length}
          >
            + Add
          </button>
        </div>
        {balancesByClass?.some((b) => b.balance > 0) ? (
          <div className="credits-by-class">
            {balancesByClass.filter((b) => b.balance > 0).map((b) => {
              const classBatches = (batches ?? []).filter((bt) => bt.classId === b.classId);
              const collapsed = collapsedClassIds.has(b.classId);
              const hasBatches = classBatches.length > 0;
              return (
                <div key={b.classId} className="credits-class-block">
                  <button
                    type="button"
                    className="credits-class-head"
                    onClick={() => hasBatches && toggleClassCollapsed(b.classId)}
                    aria-expanded={hasBatches ? !collapsed : undefined}
                    disabled={!hasBatches}
                  >
                    <span className="credits-class-toggle" aria-hidden="true">
                      {hasBatches ? (collapsed ? '▸' : '▾') : ' '}
                    </span>
                    <span className="credits-class-name">{b.name}</span>
                    <span className="credits-class-total">{b.balance}</span>
                  </button>
                  {hasBatches && !collapsed ? (
                    <ul className="credits-batches">
                      {classBatches.map((bt) => {
                        const today = localDateIso();
                        const daysLeft = bt.expiresAt
                          ? Math.ceil((new Date(bt.expiresAt) - new Date(today)) / 86400000)
                          : null;
                        const cls =
                          daysLeft != null && daysLeft <= 14 ? 'expiring-soon' : '';
                        return (
                          <li key={bt.id} className={cls}>
                            <span className="batch-remaining">
                              <strong>{bt.remaining}</strong> left
                            </span>
                            <span className="batch-usage">
                              ({bt.used} / {bt.quantity})
                            </span>
                            <span className="batch-expiry">
                              {bt.expiresAt
                                ? `expires ${bt.expiresAt}${
                                    daysLeft != null ? ` (${daysLeft}d)` : ''
                                  }`
                                : 'never expires'}
                            </span>
                            {bt.note ? (
                              <span className="batch-note">— {bt.note}</span>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="sub credits-empty">
            No credits yet — click <strong>+ Add</strong> to add some.
          </p>
        )}
      </div>

      <div className="card">
        <h2>Take class (attendance)</h2>
        <div className="row2">
          <label>
            Class type
            <select
              lang="zh-CN"
              value={attendClassId}
              onChange={(e) => setAttendClassId(Number(e.target.value))}
            >
              {classTypes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            How many
            <input
              type="number"
              min={1}
              max={50}
              value={takeCount}
              onChange={(e) => setTakeCount(Number(e.target.value))}
            />
          </label>
        </div>
        <p className="class-attend-hint">
          For this class: <strong>{attendClassBalance}</strong> credits available
        </p>
        <label>
          Note (optional)
          <input
            lang="zh-CN"
            value={noteAttend}
            onChange={(e) => setNoteAttend(e.target.value)}
          />
        </label>
        <p>
          <button
            type="button"
            className="danger"
            onClick={doAttend}
            disabled={busy || !classTypes.length || attendClassBalance < takeCount}
          >
            Subtract from this class
          </button>
        </p>
      </div>

      <div className="card">
        <h2>History</h2>
        <div className="ledger-wrap">
          <table className="ledger">
            <thead>
              <tr>
                <th>When</th>
                <th>Class</th>
                <th>Kind</th>
                <th className="num">Δ</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((row) => (
                <tr key={row.id}>
                  <td>{toLocalDateTime(row.created_at)}</td>
                  <td className="ledger-class">{row.class_name || '—'}</td>
                  <td>{row.kind}</td>
                  <td className="num">{row.delta > 0 ? `+${row.delta}` : row.delta}</td>
                  <td>{row.note || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showAddCredits ? (
        <div className="modal-backdrop" onClick={closeAddCredits}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Add prepaid credits</h2>
              <button
                type="button"
                className="modal-close"
                onClick={closeAddCredits}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="row2">
              <label>
                Class type
                <select
                  lang="zh-CN"
                  value={purchaseClassId}
                  onChange={(e) => setPurchaseClassId(Number(e.target.value))}
                >
                  {classTypes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Credits
                <input
                  type="number"
                  min={1}
                  max={999}
                  value={classesToAdd}
                  onChange={(e) => setClassesToAdd(Number(e.target.value))}
                />
              </label>
            </div>
            <label>
              Valid for
              <select
                value={purchaseValidity}
                onChange={(e) => setPurchaseValidity(e.target.value)}
              >
                {VALIDITY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Note (optional)
              <input
                type="text"
                lang="zh-CN"
                value={notePurchase}
                onChange={(e) => setNotePurchase(e.target.value)}
              />
            </label>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                onClick={closeAddCredits}
                disabled={busy}
              >
                Cancel
              </button>
              <button type="button" onClick={doPurchase} disabled={busy || !classTypes.length}>
                {busy ? 'Adding…' : 'Add credits'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function SettingsView({ onBack, setErr, classTypes, reloadClassTypes }) {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState(null);
  const [savedAt, setSavedAt] = useState(null);
  const [testTo, setTestTo] = useState('');
  const [testStatus, setTestStatus] = useState(null);
  const [smtpPassInput, setSmtpPassInput] = useState('');

  const load = useCallback(async () => {
    setErr(null);
    setLoading(true);
    try {
      const s = await api('/api/settings');
      setData(s);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [setErr]);

  useEffect(() => {
    load();
  }, [load]);

  const update = (patch) => setData((d) => ({ ...d, ...patch }));

  const save = async () => {
    setErr(null);
    setSavedAt(null);
    setBusy(true);
    try {
      const body = {
        owner_name: data.owner_name,
        owner_email: data.owner_email,
        smtp_host: data.smtp_host,
        smtp_port: data.smtp_port,
        smtp_user: data.smtp_user,
        smtp_secure: data.smtp_secure,
        default_validity_months: Number(data.default_validity_months) || 12,
        reminders_enabled: data.reminders_enabled,
      };
      if (smtpPassInput.length) body.smtp_pass = smtpPassInput;
      const updated = await api('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      setData(updated);
      setSmtpPassInput('');
      setSavedAt(new Date().toLocaleTimeString());
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setErr(null);
    setTestStatus(null);
    setBusy(true);
    try {
      const body = testTo.trim() ? { to: testTo.trim() } : {};
      const r = await api('/api/settings/test-email', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setTestStatus(`Sent to ${r.to} ✓`);
    } catch (e) {
      setTestStatus(`Failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  if (loading || !data) {
    return (
      <>
        <h1>Settings</h1>
        <p className="sub">Loading…</p>
      </>
    );
  }

  return (
    <>
      <h1>Settings</h1>
      <p className="sub">
        Owner contact, default credit validity, SMTP for sending reminders, and test email.
      </p>
      <div className="toolbar">
        <button type="button" className="secondary" onClick={onBack}>
          Back
        </button>
        <button type="button" onClick={save} disabled={busy}>
          Save
        </button>
        {savedAt ? <span className="settings-saved">Saved at {savedAt}</span> : null}
      </div>

      <div className="card">
        <h2>Owner</h2>
        <label>
          Owner name
          <input
            value={data.owner_name ?? ''}
            onChange={(e) => update({ owner_name: e.target.value })}
            placeholder="e.g. Lisa"
          />
        </label>
        <div className="settings-owner-email-section">
          <label>
            Owner email
            <input
              type="email"
              value={data.owner_email ?? ''}
              onChange={(e) => update({ owner_email: e.target.value })}
              placeholder="owner@example.com"
            />
          </label>
          <p className="settings-field-hint">
            Used as the From address; BCC on reminders.
          </p>
        </div>
      </div>

      <div className="card">
        <h2>Credits</h2>
        <label>
          Default validity (months) for new purchases
          <input
            type="number"
            min={1}
            max={120}
            value={data.default_validity_months ?? 12}
            onChange={(e) => update({ default_validity_months: Number(e.target.value) })}
          />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={Boolean(data.reminders_enabled)}
            onChange={(e) => update({ reminders_enabled: e.target.checked })}
          />
          Send automatic reminders (low balance + expiring credits)
        </label>
      </div>

      <div className="card">
        <h2>SMTP (for sending email)</h2>
        <p className="sub">
          For Gmail use <code>smtp.gmail.com</code> port <code>465</code> (SSL) with an{' '}
          <strong>App Password</strong>, not your regular password.
        </p>
        <div className="row2">
          <label>
            SMTP host
            <input
              value={data.smtp_host ?? ''}
              onChange={(e) => update({ smtp_host: e.target.value })}
              placeholder="smtp.gmail.com"
            />
          </label>
          <label>
            SMTP port
            <input
              type="number"
              min={1}
              max={65535}
              value={data.smtp_port ?? ''}
              onChange={(e) => update({ smtp_port: e.target.value === '' ? null : Number(e.target.value) })}
              placeholder="465"
            />
          </label>
        </div>
        <div className="row2">
          <label>
            SMTP user
            <input
              value={data.smtp_user ?? ''}
              onChange={(e) => update({ smtp_user: e.target.value })}
              placeholder="owner@gmail.com"
              autoComplete="username"
            />
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={Boolean(data.smtp_secure)}
              onChange={(e) => update({ smtp_secure: e.target.checked })}
            />
            Use SSL/TLS (port 465)
          </label>
        </div>
        <label>
          SMTP password (App Password) {data.smtp_pass_set ? <em>— stored, leave blank to keep</em> : null}
          <input
            type="password"
            value={smtpPassInput}
            onChange={(e) => setSmtpPassInput(e.target.value)}
            placeholder={data.smtp_pass_set ? '•••••••• (leave blank to keep)' : 'Paste App Password here'}
            autoComplete="new-password"
          />
        </label>
      </div>

      <div className="card">
        <h2>Send test email</h2>
        <p className="sub">
          Verifies SMTP works. Defaults to the owner email above.
        </p>
        <label>
          Send to (optional override)
          <input
            type="email"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder={data.owner_email || 'owner@example.com'}
          />
        </label>
        <p>
          <button type="button" onClick={sendTest} disabled={busy || !data.smtp_pass_set || !data.owner_email}>
            Send test email
          </button>
        </p>
        {testStatus ? <p className="sub">{testStatus}</p> : null}
        {!data.smtp_pass_set ? (
          <p className="sub">Save SMTP password first.</p>
        ) : null}
      </div>

      <RemindersCard data={data} setErr={setErr} />

      <ClassTypesManager
        classTypes={classTypes}
        reloadClassTypes={reloadClassTypes}
        setErr={setErr}
      />

      <ClassEmailHistory setErr={setErr} />
    </>
  );
}

function RemindersCard({ data, setErr }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const ready =
    data.reminders_enabled &&
    data.smtp_pass_set &&
    data.owner_email &&
    data.smtp_host;

  const run = async () => {
    setErr(null);
    setResult(null);
    setBusy(true);
    try {
      const r = await api('/api/reminders/run', { method: 'POST' });
      setResult(r);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>Reminders</h2>
      <p className="sub">
        The server runs a reminders pass automatically every day at 9:00 (local time).
        Each member is emailed once when their per-class balance hits 2, 1, or 0, and
        when a credit batch has 14 or 3 days left. The owner is BCC'd on every reminder.
      </p>
      <p className="sub">
        Status: reminders are <strong>{data.reminders_enabled ? 'enabled' : 'disabled'}</strong>
        {ready ? '' : ' — not ready (check SMTP and Owner email above)'}.
      </p>
      <p>
        <button type="button" onClick={run} disabled={busy || !ready}>
          {busy ? 'Running…' : 'Run reminders now'}
        </button>
      </p>
      {result ? (
        <div className="sub">
          {result.reason ? (
            <p>Skipped: {result.reason}</p>
          ) : (
            <>
              <p>
                Low-balance: <strong>{result.lowBalanceSent}</strong> sent
                {result.lowBalanceSkipped
                  ? `, ${result.lowBalanceSkipped} failed`
                  : ''}
                .
              </p>
              <p>
                Expiry: <strong>{result.expirySent}</strong> sent
                {result.expirySkipped ? `, ${result.expirySkipped} failed` : ''}.
              </p>
              {result.errors?.length ? (
                <details>
                  <summary>Errors ({result.errors.length})</summary>
                  <ul>
                    {result.errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ClassTypesManager({ classTypes, reloadClassTypes, setErr }) {
  const [expanded, setExpanded] = useState(false);
  const [newClassName, setNewClassName] = useState('');
  const [busy, setBusy] = useState(false);
  const [removeId, setRemoveId] = useState(null);

  const addClassType = async (e) => {
    e.preventDefault();
    setErr(null);
    const name = newClassName.trim();
    if (!name) {
      setErr('Class name is required.');
      return;
    }
    setBusy(true);
    try {
      await api('/api/class-types', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      setNewClassName('');
      await reloadClassTypes();
    } catch (err) {
      setErr(err.message);
    } finally {
      setBusy(false);
    }
  };

  const removeClassType = async (c) => {
    if (!window.confirm(`Remove class type “${c.name}”? This cannot be undone.`)) {
      return;
    }
    setErr(null);
    setRemoveId(c.id);
    try {
      await api(`/api/class-types/${c.id}`, { method: 'DELETE' });
      await reloadClassTypes();
    } catch (err) {
      setErr(err.message);
    } finally {
      setRemoveId(null);
    }
  };

  return (
    <div className="card">
      <div className="member-info-head">
        <h2>Class types</h2>
        <button
          type="button"
          className="secondary member-info-edit-btn"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Done' : 'Manage'}
        </button>
      </div>
      <p className="sub">
        {classTypes.length} class type{classTypes.length === 1 ? '' : 's'} configured.
        {expanded ? '' : ' Click Manage to add or remove.'}
      </p>
      {expanded ? (
        <>
          <p className="sub">
            Remove is only allowed if no member has credits or attendance for that class, and at
            least one type must remain.
          </p>
          <ul className="class-type-manage-list" aria-label="Class types">
            {classTypes.map((c) => (
              <li key={c.id}>
                <span className="class-type-manage-name">{c.name}</span>
                <button
                  type="button"
                  className="danger owner-class-remove"
                  disabled={busy || removeId !== null || classTypes.length <= 1}
                  onClick={() => removeClassType(c)}
                >
                  {removeId === c.id ? 'Removing…' : 'Remove'}
                </button>
              </li>
            ))}
          </ul>
          <h3 className="owner-class-form-subtitle">Add new</h3>
          <form onSubmit={addClassType}>
            <label>
              Name *
              <input
                lang="zh-CN"
                value={newClassName}
                onChange={(e) => setNewClassName(e.target.value)}
                placeholder="e.g. 散打 Sanda"
                maxLength={120}
                autoComplete="off"
              />
            </label>
            <p className="owner-class-form-actions">
              <button type="submit" disabled={busy || removeId !== null}>
                {busy ? 'Saving…' : 'Save class type'}
              </button>
            </p>
          </form>
        </>
      ) : (
        <ul className="class-type-summary-list">
          {classTypes.map((c) => (
            <li key={c.id}>{c.name}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ClassEmailHistory({ setErr }) {
  const [items, setItems] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api('/api/class-messages');
        if (!cancelled) setItems(list);
      } catch (e) {
        if (!cancelled) setErr(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setErr]);

  return (
    <div className="card">
      <h2>Class email history</h2>
      {loading ? <p className="sub">Loading…</p> : null}
      {!loading && items?.length === 0 ? (
        <p className="sub">No class emails sent yet.</p>
      ) : null}
      {!loading && items?.length ? (
        <ul className="message-history">
          {items.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                className="link-button"
                onClick={() => setExpanded((id) => (id === m.id ? null : m.id))}
              >
                {expanded === m.id ? '▾' : '▸'} {toLocalDateTime(m.sentAt)} — {m.className} —{' '}
                {m.subject} ({m.recipientCount} recipient{m.recipientCount === 1 ? '' : 's'})
              </button>
              {expanded === m.id ? (
                <div className="message-detail">
                  <p className="sub">
                    <strong>Recipients:</strong>{' '}
                    {m.recipientEmails.length ? m.recipientEmails.join(', ') : '—'}
                  </p>
                  <pre className="message-body">{m.body}</pre>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
