import { useCallback, useEffect, useState } from 'react';
import type { ProfileRequest } from '../../shared/types';
import { api, ApiError } from '../api';
import { fmtDate } from '../format';
import { FIELD_LABEL } from './MyProfileView';

/**
 * HR's queue: name and address changes people asked for (server/profile.ts).
 * Approving applies the value to the record; a rejection says why. Nobody
 * decides their own — the server refuses it, and the button is not offered.
 */
export function ProfileRequestsView({ ownEmployeeId, onOpen, onAuthLost }: { ownEmployeeId: number | null; onOpen: (id: number) => void; onAuthLost: () => void }) {
  const [requests, setRequests] = useState<ProfileRequest[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handle = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof ApiError && err.details.length > 0 ? `${err.message}: ${err.details.map((d) => d.message).join(' · ')}` : err instanceof Error ? err.message : 'Request failed');
    },
    [onAuthLost],
  );

  const load = useCallback(async () => {
    try {
      setRequests((await api.profileRequests(showAll ? undefined : 'pending')).requests);
    } catch (err) {
      handle(err);
    }
  }, [showAll, handle]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
      await load();
    } catch (err) {
      handle(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ EMP.06 · CHANGE REQUESTS</div>
          <h1 className="resource__title">Change requests</h1>
          <p className="resource__desc">Names and private addresses people asked to change. Approving writes the new value into the record.</p>
        </div>
      </div>
      {error && <div className="resource__error mono">{error}</div>}
      <label className="mono table__id">
        <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> SHOW DECIDED ONES TOO
      </label>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">ASKED</th>
              <th className="mono">WHO</th>
              <th className="mono">WHAT</th>
              <th className="mono">NOW</th>
              <th className="mono">NEW</th>
              <th className="mono">STATUS</th>
            </tr>
          </thead>
          <tbody>
            {requests?.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={6}>
                  NOTHING WAITING
                </td>
              </tr>
            )}
            {requests?.map((r) => (
              <tr key={r.id}>
                <td className="mono table__id">{fmtDate(r.requested_at)}</td>
                <td>
                  <button className="linklike" onClick={() => onOpen(r.employee_id)}>
                    {r.employee_name}
                  </button>
                  {r.reason && <div className="mono table__id">{r.reason}</div>}
                </td>
                <td>{FIELD_LABEL[r.field]}</td>
                <td style={{ whiteSpace: 'pre-line' }}>{r.current ?? '—'}</td>
                <td style={{ whiteSpace: 'pre-line' }}>{r.proposed}</td>
                <td>
                  {r.status !== 'pending' ? (
                    <span className="mono">
                      {r.status.toUpperCase()}
                      {r.decided_by && ` · ${r.decided_by}`}
                      {r.decision_note && ` · ${r.decision_note}`}
                    </span>
                  ) : r.employee_id === ownEmployeeId ? (
                    <span className="mono table__id">YOUR OWN — ANOTHER PERSON DECIDES</span>
                  ) : (
                    <div className="table__rowactions">
                      <button className="rowbtn mono" disabled={busy} onClick={() => void run(() => api.approveChange(r.id))}>
                        APPROVE
                      </button>
                      <input className="field__input" placeholder="Why not?" value={notes[r.id] ?? ''} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} />
                      <button className="rowbtn rowbtn--danger mono" disabled={busy || !(notes[r.id] ?? '').trim()} onClick={() => void run(() => api.rejectChange(r.id, notes[r.id]!.trim()))}>
                        REJECT
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
