import { useCallback, useEffect, useState } from 'react';
import type { OwnProfile, ProfileChange, ProfileRequest } from '../../shared/types';
import { api, ApiError } from '../api';
import { fmtDate } from '../format';

/**
 * My profile (server/profile.ts): the signed-in person's own record. Phone and
 * emergency contact are changed here directly; the name and the private
 * address go to HR as a request. What is private is shown to the person and
 * HR only — never in the directory.
 */

export const FIELD_LABEL: Record<ProfileChange['field'], string> = {
  phone: 'Work phone',
  private_phone: 'Private phone',
  emergency_name: 'Emergency contact',
  emergency_relation: 'Emergency contact relation',
  emergency_phone: 'Emergency contact phone',
  name: 'Name',
  address: 'Private address',
  private_data: 'All private data',
};
export const VIA_LABEL: Record<ProfileChange['via'], string> = { self: 'by themselves', request: 'request approved', hr: 'by HR', erased: 'erased' };

export function MyProfileView({ onAuthLost }: { onAuthLost: () => void }) {
  const [p, setP] = useState<OwnProfile | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [requestField, setRequestField] = useState<'name' | 'address'>('address');
  const [requestValue, setRequestValue] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [noRecord, setNoRecord] = useState(false);
  const [busy, setBusy] = useState(false);

  const show = (profile: OwnProfile) => {
    setP(profile);
    setForm({
      phone: profile.employee.phone ?? '',
      private_phone: profile.private.private_phone ?? '',
      emergency_name: profile.private.emergency_name ?? '',
      emergency_relation: profile.private.emergency_relation ?? '',
      emergency_phone: profile.private.emergency_phone ?? '',
    });
  };

  const handle = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else if (err instanceof ApiError && err.status === 404 && /No employee record/.test(err.message)) setNoRecord(true);
      else setError(err instanceof ApiError && err.details.length > 0 ? `${err.message}: ${err.details.map((d) => d.message).join(' · ')}` : err instanceof Error ? err.message : 'Request failed');
    },
    [onAuthLost],
  );

  const load = useCallback(async () => {
    try {
      show(await api.myProfile());
    } catch (err) {
      handle(err);
    }
  }, [handle]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      setNotice(await action());
    } catch (err) {
      handle(err);
    } finally {
      setBusy(false);
    }
  }

  if (noRecord) return <div className="resource__error mono">NO EMPLOYEE RECORD CARRIES YOUR LOGIN — ASK HR TO ADD YOUR EMAIL TO ONE</div>;
  if (!p) return error ? <div className="resource__error mono">{error}</div> : <div className="boot mono">LOADING…</div>;

  const offboarded = p.employee.status !== 'active';
  const pending = (field: 'name' | 'address') => p.requests.find((r) => r.field === field && r.status === 'pending');
  const input = (key: string, label: string, placeholder = '') => (
    <label className="field">
      <span className="field__label mono">{label}</span>
      <input className="field__input" value={form[key] ?? ''} placeholder={placeholder} disabled={offboarded} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
    </label>
  );

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ EMP.05 · MY PROFILE</div>
          <h1 className="resource__title">{p.employee.name}</h1>
          <p className="resource__desc">
            {p.employee.job_title} · {p.employee.department_name}. Keep your phone and emergency contact current here; a new name or address goes to HR.
          </p>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}
      {notice && <div className="mono table__id">{notice}</div>}
      {offboarded && <div className="resource__error mono">OFFBOARDED — THIS RECORD IS READ-ONLY</div>}

      <div className="section-title mono">IN THE DIRECTORY</div>
      <div className="editor__meta">{input('phone', 'WORK PHONE', '+43 1 234 567')}</div>

      <div className="section-title mono">PRIVATE · SEEN BY YOU AND HR ONLY</div>
      <div className="editor__meta">
        {input('private_phone', 'PRIVATE PHONE')}
        {input('emergency_name', 'EMERGENCY CONTACT')}
        {input('emergency_relation', 'RELATION', 'Partner, parent …')}
        {input('emergency_phone', 'EMERGENCY PHONE')}
      </div>
      <div className="editbar">
        <button
          className="btn btn--primary"
          disabled={busy || offboarded}
          onClick={() =>
            void run(async () => {
              show(await api.updateMyProfile(Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v.trim() === '' ? null : v]))));
              return 'Saved.';
            })
          }
        >
          SAVE →
        </button>
      </div>

      <div className="section-title mono">NAME AND ADDRESS · CHANGED BY HR ON YOUR REQUEST</div>
      <div className="card-grid">
        <div className="stat">
          <div className="stat__label mono">NAME</div>
          <div className="stat__text">{p.employee.name}</div>
          {pending('name') && <div className="mono table__id">REQUESTED: {pending('name')!.proposed}</div>}
        </div>
        <div className="stat">
          <div className="stat__label mono">PRIVATE ADDRESS</div>
          <div className="stat__text" style={{ whiteSpace: 'pre-line' }}>{p.private.address ?? '—'}</div>
          {pending('address') && <div className="mono table__id">REQUESTED: {pending('address')!.proposed}</div>}
        </div>
      </div>
      {!offboarded && (
        <div className="editbar">
          <select className="field__input" value={requestField} onChange={(e) => setRequestField(e.target.value as 'name' | 'address')}>
            <option value="address">New private address</option>
            <option value="name">New name</option>
          </select>
          {requestField === 'address' ? (
            <textarea className="field__input" rows={2} placeholder={'Street and number\nPostcode and town'} value={requestValue} onChange={(e) => setRequestValue(e.target.value)} />
          ) : (
            <input className="field__input" placeholder="Name as it should read" value={requestValue} onChange={(e) => setRequestValue(e.target.value)} />
          )}
          <input className="field__input" placeholder="Reason (optional), e.g. moved, married" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button
            className="btn"
            disabled={busy || requestValue.trim() === '' || Boolean(pending(requestField))}
            title={pending(requestField) ? 'A request for this is already waiting for HR' : undefined}
            onClick={() =>
              void run(async () => {
                await api.requestChange({ field: requestField, value: requestValue.trim(), reason: reason.trim() || undefined });
                setRequestValue('');
                setReason('');
                await load();
                return 'Sent to HR.';
              })
            }
          >
            SEND TO HR →
          </button>
        </div>
      )}

      <RequestTable
        requests={p.requests}
        onWithdraw={(r) =>
          void run(async () => {
            await api.withdrawChange(r.id);
            await load();
            return 'Withdrawn.';
          })
        }
      />

      <div className="section-title mono">HISTORY · WHO CHANGED WHAT, NEVER THE VALUES</div>
      <ChangeList changes={p.changes} />
    </div>
  );
}

function RequestTable({ requests, onWithdraw }: { requests: ProfileRequest[]; onWithdraw: (r: ProfileRequest) => void }) {
  if (requests.length === 0) return null;
  return (
    <div className="table-wrap">
      <table className="table">
        <tbody>
          {requests.map((r) => (
            <tr key={r.id}>
              <td className="mono table__id">{fmtDate(r.requested_at)}</td>
              <td>{FIELD_LABEL[r.field]}</td>
              <td style={{ whiteSpace: 'pre-line' }}>{r.proposed}</td>
              <td className="mono">
                {r.status.toUpperCase()}
                {r.decision_note && ` · ${r.decision_note}`}
              </td>
              <td>
                {r.status === 'pending' && (
                  <button className="rowbtn mono" onClick={() => onWithdraw(r)}>
                    WITHDRAW
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ChangeList({ changes }: { changes: ProfileChange[] }) {
  if (changes.length === 0) return <p className="resource__desc">No changes yet.</p>;
  return (
    <div className="table-wrap">
      <table className="table">
        <tbody>
          {changes.map((c) => (
            <tr key={c.id}>
              <td className="mono table__id">{c.at.slice(0, 16).replace('T', ' ')}</td>
              <td>{FIELD_LABEL[c.field]}</td>
              <td className="mono">{VIA_LABEL[c.via]}</td>
              <td className="mono table__id">{c.actor}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
