import { useCallback, useEffect, useState } from 'react';
import type { AppConfig, BusinessWindow, SlaPolicy, SlaPolicyVersion } from '../../shared/types';
import { api, ApiError } from '../api';
import { useCan } from '../access';
import { fmtDateTime, fmtMinutes } from '../format';

interface Props {
  config: AppConfig;
  onSaved: () => void;
  onAuthLost: () => void;
}

const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];

/** "08:00-12:00, 13:00-17:00" ⇄ windows. The server checks the times. */
function windowsText(windows: BusinessWindow[]): string {
  return windows.map((w) => `${w.start}–${w.end}`).join(', ');
}
function parseWindows(text: string): BusinessWindow[] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [start = '', end = ''] = part.split(/\s*[-–]\s*/);
      return { start: start.trim(), end: end.trim() };
    });
}

/**
 * The SLA policy: shown to everyone, edited by a manager. Saving creates a
 * new version; a ticket keeps the version it came in under.
 */
export function SlaPolicyView({ config, onSaved, onAuthLost }: Props) {
  const canManage = useCan('manage');
  const [versions, setVersions] = useState<SlaPolicyVersion[]>([]);
  const [current, setCurrent] = useState<SlaPolicyVersion | null>(null);
  const [draft, setDraft] = useState<SlaPolicy | null>(null);
  const [weekText, setWeekText] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const show = (v: { current: SlaPolicyVersion; versions: SlaPolicyVersion[] }) => {
    setCurrent(v.current);
    setVersions(v.versions);
    setDraft(structuredClone(v.current.policy));
    setWeekText(v.current.policy.week.map(windowsText));
  };

  const load = useCallback(async () => {
    try {
      show(await api.policy());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Could not load the policy');
    }
  }, [onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const saved = await api.savePolicy({ ...draft, week: weekText.map(parseWindows) });
      show(saved);
      setNotice(saved.current.id === current?.id ? 'Nothing changed.' : `Saved as version ${saved.current.id} — new tickets are held to it; open ones keep theirs.`);
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof ApiError && err.details.length > 0 ? `${err.message}: ${err.details.map((d) => `${d.field} ${d.message}`).join(' · ')}` : err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  if (!draft || !current) return error ? <div className="resource__error mono">{error}</div> : <div className="boot mono">LOADING…</div>;
  const set = (patch: Partial<SlaPolicy>) => setDraft({ ...draft, ...patch });
  const ro = !canManage || busy;

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">
            § SUP.04 · POLICY · {current.id === null ? 'BUILT-IN DEFAULTS' : `VERSION ${current.id} · ${current.created_by} · ${fmtDateTime(current.created_at!)}`}
          </div>
          <h1 className="resource__title">SLA policy</h1>
          <p className="resource__desc">
            First response is met by the first public agent reply; resolution the first time a ticket enters <em>resolved</em>. Each
            priority counts either around the clock or in business hours — the opening windows below, in the office's time zone,
            without holidays. A leg is at risk once {draft.at_risk_minutes} minutes of its clock are left. Saving creates a new
            version: tickets are held to the version in force when they came in, so a change never rewrites old verdicts.
          </p>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}
      {notice && <div className="mono table__id">{notice}</div>}

      <div className="section-title mono">TARGETS</div>
      <div className="table-wrap" style={{ maxWidth: 760 }}>
        <table className="table" style={{ minWidth: 0 }}>
          <thead>
            <tr>
              <th className="mono">PRIORITY</th>
              <th className="mono">FIRST RESPONSE (MIN)</th>
              <th className="mono">RESOLUTION (MIN)</th>
              <th className="mono">COUNTED</th>
            </tr>
          </thead>
          <tbody>
            {config.priorities.map((p) => {
              const t = draft.targets[p];
              const setT = (patch: Partial<typeof t>) => set({ targets: { ...draft.targets, [p]: { ...t, ...patch } } });
              return (
                <tr key={p}>
                  <td>
                    <span className={`badge mono badge--${p}`}>{p.toUpperCase()}</span>
                  </td>
                  <td className="mono">
                    <input className="field__input field__input--num" type="number" min={1} value={t.first_response_minutes} disabled={ro} onChange={(e) => setT({ first_response_minutes: Number(e.target.value) })} />{' '}
                    {fmtMinutes(t.first_response_minutes)}
                  </td>
                  <td className="mono">
                    <input className="field__input field__input--num" type="number" min={1} value={t.resolution_minutes} disabled={ro} onChange={(e) => setT({ resolution_minutes: Number(e.target.value) })} />{' '}
                    {fmtMinutes(t.resolution_minutes)}
                  </td>
                  <td>
                    <div className="chooser">
                      <button className={`chooser__btn ${!t.business_hours ? 'is-active' : ''}`} disabled={ro} onClick={() => setT({ business_hours: false })}>
                        24 × 7
                      </button>
                      <button className={`chooser__btn ${t.business_hours ? 'is-active' : ''}`} disabled={ro} onClick={() => setT({ business_hours: true })}>
                        BUSINESS HOURS
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="section-title mono">BUSINESS HOURS</div>
      <div className="policy-grid">
        <label className="field">
          <span className="field__label mono">TIME ZONE</span>
          <input className="field__input" value={draft.timezone} disabled={ro} onChange={(e) => set({ timezone: e.target.value })} placeholder="Europe/Vienna" />
        </label>
        <label className="field">
          <span className="field__label mono">AT RISK WHEN (MIN) LEFT</span>
          <input className="field__input" type="number" min={1} value={draft.at_risk_minutes} disabled={ro} onChange={(e) => set({ at_risk_minutes: Number(e.target.value) })} />
        </label>
      </div>
      <div className="policy-week">
        {DAYS.map((day, i) => (
          <label className="field" key={day}>
            <span className="field__label mono">{day}</span>
            <input
              className="field__input"
              value={weekText[i] ?? ''}
              disabled={ro}
              placeholder="closed"
              onChange={(e) => setWeekText(weekText.map((t, j) => (j === i ? e.target.value : t)))}
            />
          </label>
        ))}
      </div>
      <p className="resource__desc">Windows as 08:00–12:00, 13:00–17:00 — up to three a day; empty means closed.</p>

      <div className="section-title mono">HOLIDAYS · NOT COUNTED</div>
      <div className="holidays">
        {draft.holidays.map((h, i) => (
          <div className="holidays__row" key={i}>
            <input className="field__input" type="date" value={h.date} disabled={ro} onChange={(e) => set({ holidays: draft.holidays.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)) })} />
            <input className="field__input" value={h.name} disabled={ro} placeholder="Name" onChange={(e) => set({ holidays: draft.holidays.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
            {canManage && (
              <button className="linklike mono" disabled={busy} onClick={() => set({ holidays: draft.holidays.filter((_, j) => j !== i) })}>
                REMOVE
              </button>
            )}
          </div>
        ))}
        {canManage && (
          <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => set({ holidays: [...draft.holidays, { date: '', name: '' }] })}>
            ADD HOLIDAY
          </button>
        )}
        {!canManage && draft.holidays.length === 0 && <p className="resource__desc">None.</p>}
      </div>

      <div className="section-title mono">WAITING ON THE REQUESTER</div>
      <label className="check">
        <input type="checkbox" checked={draft.pause_on_pending} disabled={ro} onChange={(e) => set({ pause_on_pending: e.target.checked })} />
        <span>Stop the resolution clock while a ticket is <em>pending</em>. The first response is still owed.</span>
      </label>

      {canManage && (
        <div className="editbar">
          <button className="btn btn--primary" disabled={busy} onClick={() => void save()}>
            SAVE AS NEW VERSION →
          </button>
          <button className="btn btn--ghost" disabled={busy} onClick={() => show({ current, versions })}>
            DISCARD CHANGES
          </button>
        </div>
      )}

      {versions.length > 0 && (
        <>
          <div className="section-title mono">VERSIONS · APPEND-ONLY</div>
          <div className="table-wrap" style={{ maxWidth: 760 }}>
            <table className="table" style={{ minWidth: 0 }}>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.id}>
                    <td className="mono">V{v.id}</td>
                    <td className="mono table__id">{fmtDateTime(v.created_at!)}</td>
                    <td>{v.created_by}</td>
                    <td className="mono table__id">
                      {config.priorities
                        .map((p) => `${p.toUpperCase()} ${fmtMinutes(v.policy.targets[p].first_response_minutes)}/${fmtMinutes(v.policy.targets[p].resolution_minutes)}${v.policy.targets[p].business_hours ? ' BH' : ''}`)
                        .join(' · ')}
                      {v.policy.pause_on_pending ? ' · PAUSE ON PENDING' : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="section-title mono">STATUS WORKFLOW</div>
      <div className="table-wrap" style={{ maxWidth: 620 }}>
        <table className="table" style={{ minWidth: 0 }}>
          <thead>
            <tr>
              <th className="mono">STATUS</th>
              <th className="mono">CAN MOVE TO</th>
            </tr>
          </thead>
          <tbody>
            {config.statuses.map((s) => (
              <tr key={s}>
                <td>
                  <span className={`badge mono badge--${s}`}>{s.toUpperCase()}</span>
                </td>
                <td className="mono table__id">
                  {config.transitions[s].length ? config.transitions[s].map((t) => t.toUpperCase()).join('  ·  ') : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
