import { useCallback, useEffect, useRef, useState } from 'react';
import type { PrivateData, ProfileChange } from '../../shared/types';
import { api } from '../api';
import { ChangeList } from './MyProfileView';

/**
 * HR's view of one person's private data (server/profile.ts): shown only to
 * `edit` and above, maintained when the person cannot, and erased once
 * nothing needs it any more — typically after offboarding.
 */
export function PrivateDataPanel({ employeeId, offboarded, onError }: { employeeId: number; offboarded: boolean; onError: (err: unknown) => void }) {
  const [data, setData] = useState<{ private: PrivateData; changes: ProfileChange[] } | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  // Held in a ref: the parent passes a fresh callback each render, and a reload
  // on every render — or a loop when the load fails — is not what it asked for.
  const report = useRef(onError);
  report.current = onError;

  const show = (d: { private: PrivateData; changes: ProfileChange[] }) => {
    setData(d);
    setForm({
      private_phone: d.private.private_phone ?? '',
      address: d.private.address ?? '',
      emergency_name: d.private.emergency_name ?? '',
      emergency_relation: d.private.emergency_relation ?? '',
      emergency_phone: d.private.emergency_phone ?? '',
    });
  };

  const load = useCallback(async () => {
    try {
      show(await api.privateData(employeeId));
    } catch (err) {
      report.current(err);
    }
  }, [employeeId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<{ private: PrivateData; changes: ProfileChange[] }>) {
    setBusy(true);
    try {
      show(await action());
    } catch (err) {
      report.current(err);
    } finally {
      setBusy(false);
    }
  }

  if (!data) return null;
  const field = (key: string, label: string, multiline = false) => (
    <label className="field">
      <span className="field__label mono">{label}</span>
      {multiline ? (
        <textarea className="field__input" rows={2} value={form[key] ?? ''} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
      ) : (
        <input className="field__input" value={form[key] ?? ''} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
      )}
    </label>
  );
  return (
    <>
      <div className="section-title mono">PRIVATE · HR ONLY</div>
      <div className="editor__meta">
        {field('private_phone', 'PRIVATE PHONE')}
        {field('address', 'PRIVATE ADDRESS', true)}
        {field('emergency_name', 'EMERGENCY CONTACT')}
        {field('emergency_relation', 'RELATION')}
        {field('emergency_phone', 'EMERGENCY PHONE')}
      </div>
      <div className="editbar">
        <button
          className="btn btn--primary"
          disabled={busy}
          onClick={() => void run(() => api.updatePrivateData(employeeId, Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v.trim() === '' ? null : v]))))}
        >
          SAVE PRIVATE DATA →
        </button>
        <button
          className="btn btn--danger"
          disabled={busy}
          title={offboarded ? 'Nothing needs it any more' : 'Usually after offboarding'}
          onClick={() => {
            if (confirm('Erase all private data of this person? This cannot be undone.')) void run(() => api.erasePrivateData(employeeId));
          }}
        >
          ERASE PRIVATE DATA
        </button>
      </div>
      <ChangeList changes={data.changes} />
    </>
  );
}
