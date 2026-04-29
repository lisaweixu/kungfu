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
  const [showManageClassTypes, setShowManageClassTypes] = useState(false);
  const [newClassName, setNewClassName] = useState('');
  const [classTypeBusy, setClassTypeBusy] = useState(false);
  const [removeClassId, setRemoveClassId] = useState(null);
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
            setShowManageClassTypes(false);
            setErr(null);
            setShowSummary(true);
          }}
        >
          Summary
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setShowManageClassTypes((v) => !v);
            setErr(null);
          }}
        >
          {showManageClassTypes ? 'Close' : 'Manage class types'}
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
      {showManageClassTypes ? (
        <div className="card owner-class-form">
          <h2 className="owner-class-form-title">Class types</h2>
          <p className="owner-class-form-hint">
            Remove is only allowed if no member has credits or attendance for that class, and at least one
            type must remain.
          </p>
          <ul className="class-type-manage-list" aria-label="Class types">
            {classTypes.map((c) => (
              <li key={c.id}>
                <span className="class-type-manage-name">{c.name}</span>
                <button
                  type="button"
                  className="danger owner-class-remove"
                  disabled={
                    classTypeBusy || removeClassId !== null || classTypes.length <= 1
                  }
                  onClick={async () => {
                    if (
                      !window.confirm(
                        `Remove class type “${c.name}”? This cannot be undone.`,
                      )
                    ) {
                      return;
                    }
                    setErr(null);
                    setRemoveClassId(c.id);
                    try {
                      await api(`/api/class-types/${c.id}`, { method: 'DELETE' });
                      await reloadClassTypes();
                    } catch (err) {
                      setErr(err.message);
                    } finally {
                      setRemoveClassId(null);
                    }
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <h3 className="owner-class-form-subtitle">Add new</h3>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setErr(null);
              const name = newClassName.trim();
              if (!name) {
                setErr('Class name is required.');
                return;
              }
              setClassTypeBusy(true);
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
                setClassTypeBusy(false);
              }
            }}
          >
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
              <button type="submit" disabled={classTypeBusy || removeClassId !== null}>
                Save class type
              </button>
              <button
                type="button"
                className="secondary"
                disabled={classTypeBusy || removeClassId !== null}
                onClick={() => {
                  setShowManageClassTypes(false);
                  setNewClassName('');
                  setErr(null);
                }}
              >
                Done
              </button>
            </p>
          </form>
        </div>
      ) : null}
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
      </div>
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
      await onRefresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
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
        <button type="button" className="secondary" onClick={toggleActive} disabled={busy}>
          {member.active ? 'Mark inactive' : 'Mark active'}
        </button>
      </div>

      {balancesByClass?.length ? (
        <div className="card">
          <h2>Credits by class</h2>
          <ul className="class-balances">
            {balancesByClass.map((b) => (
              <li key={b.classId}>
                <span className="class-balances-name">{b.name}</span>
                <span className="class-balances-num">{b.balance}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="card">
        <h2>Add prepaid credits</h2>
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
            lang="zh-CN"
            value={notePurchase}
            onChange={(e) => setNotePurchase(e.target.value)}
          />
        </label>
        <p>
          <button type="button" onClick={doPurchase} disabled={busy || !classTypes.length}>
            Add credits
          </button>
        </p>
      </div>

      {batches?.length ? (
        <div className="card">
          <h2>Active credit batches</h2>
          <div className="ledger-wrap">
            <table className="ledger">
              <thead>
                <tr>
                  <th>Class</th>
                  <th className="num">Remaining</th>
                  <th className="num">Used / Total</th>
                  <th>Expires</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => {
                  const today = localDateIso();
                  const daysLeft = b.expiresAt
                    ? Math.ceil((new Date(b.expiresAt) - new Date(today)) / 86400000)
                    : null;
                  const cls = daysLeft != null && daysLeft <= 14 ? 'expiring-soon' : '';
                  return (
                    <tr key={b.id} className={cls}>
                      <td className="ledger-class">{b.className}</td>
                      <td className="num"><strong>{b.remaining}</strong></td>
                      <td className="num">{b.used} / {b.quantity}</td>
                      <td>
                        {b.expiresAt
                          ? `${b.expiresAt}${daysLeft != null ? ` (${daysLeft}d)` : ''}`
                          : '永不 / Never'}
                      </td>
                      <td>{b.note || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

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
    </>
  );
}

function SettingsView({ onBack, setErr }) {
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
        <label>
          Owner email (used as the From address; BCC on reminders)
          <input
            type="email"
            value={data.owner_email ?? ''}
            onChange={(e) => update({ owner_email: e.target.value })}
            placeholder="owner@example.com"
          />
        </label>
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
    </>
  );
}
