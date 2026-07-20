import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { AppConfig, ApplicationRow, ProgramRow } from '../../shared/types';
import { api, ApiError, EXPORT_URL } from '../api';
import { eurosToCents, fmtEur } from '../format';
import { StatusBadge } from './Badges';

interface Props {
  config: AppConfig;
  onOpen: (id: number) => void;
  onAuthLost: () => void;
}

export function ApplicationsView({ config, onOpen, onAuthLost }: Props) {
  const [rows, setRows] = useState<ApplicationRow[] | null>(null);
  const [programs, setPrograms] = useState<ProgramRow[]>([]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [programId, setProgramId] = useState('');
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ program_id: '', title: '', eligible: '', requested: '', reference: '', notes: '' });
  const [busy, setBusy] = useState(false);

  const loadPrograms = useCallback(async () => {
    try {
      const { programs: ps } = await api.programs(new URLSearchParams({ status: 'open' }));
      setPrograms(ps);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
    }
  }, [onAuthLost]);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      if (status) params.set('status', status);
      if (programId) params.set('program_id', programId);
      const { applications } = await api.applications(params);
      setRows(applications);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load applications');
    }
  }, [search, status, programId, onAuthLost]);

  useEffect(() => {
    void loadPrograms();
  }, [loadPrograms]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 150);
    return () => clearTimeout(t);
  }, [load]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const eligible = eurosToCents(form.eligible);
      const requested = eurosToCents(form.requested);
      if (eligible === null || requested === null) throw new ApiError(422, 'Amounts must look like 100000 or 100000.00');
      const created = await api.createApplication({
        program_id: Number(form.program_id),
        title: form.title,
        eligible_costs_cents: eligible,
        requested_amount_cents: requested,
        reference: form.reference || null,
        notes: form.notes || null,
      });
      setForm({ program_id: '', title: '', eligible: '', requested: '', reference: '', notes: '' });
      setShowForm(false);
      onOpen(created.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create the application');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ SUB.03 · APPLICATIONS</div>
          <h1 className="resource__title">Applications</h1>
          <p className="resource__desc">
            Our applications to funding programs. Requested may not exceed eligible costs × the program's funding
            rate. Once approved, tranches and reporting obligations open up.
          </p>
        </div>
        <div className="resource__actions">
          <a className="btn btn--ghost" href={EXPORT_URL}>
            EXPORT CSV ↓
          </a>
          <button className="btn btn--primary" onClick={() => setShowForm((s) => !s)}>
            {showForm ? 'CLOSE' : 'NEW APPLICATION +'}
          </button>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      {showForm && (
        <form className="form" onSubmit={(e) => void create(e)}>
          <div className="form__grid">
            <label className="field">
              <span className="field__label mono">PROGRAM</span>
              <select className="field__input" value={form.program_id} onChange={(e) => setForm({ ...form, program_id: e.target.value })} required>
                <option value="">Select an open program…</option>
                {programs.map((p) => (
                  <option key={p.id} value={String(p.id)}>
                    {p.name} · {p.funding_rate}% · max {fmtEur(p.max_grant_cents)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field__label mono">PROJECT TITLE</span>
              <input className="field__input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required />
            </label>
            <label className="field">
              <span className="field__label mono">ELIGIBLE COSTS (EUR)</span>
              <input className="field__input" value={form.eligible} onChange={(e) => setForm({ ...form, eligible: e.target.value })} placeholder="100000.00" required />
            </label>
            <label className="field">
              <span className="field__label mono">REQUESTED AMOUNT (EUR)</span>
              <input className="field__input" value={form.requested} onChange={(e) => setForm({ ...form, requested: e.target.value })} placeholder="40000.00" required />
            </label>
            <label className="field">
              <span className="field__label mono">CASE / REFERENCE NO.</span>
              <input className="field__input" value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
            </label>
          </div>
          <label className="field">
            <span className="field__label mono">NOTES</span>
            <textarea className="field__input" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </label>
          <div className="form__hint mono">The requested amount is checked against the funding cap on save (422 if it exceeds it).</div>
          <div className="form__actions">
            <button className="btn btn--primary" type="submit" disabled={busy}>
              {busy ? 'SAVING…' : 'CREATE DRAFT →'}
            </button>
          </div>
        </form>
      )}

      <div className="toolbar">
        <input className="field__input toolbar__search" placeholder="Search ref, title, reference…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="field__input toolbar__filter" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">ALL STATUS</option>
          {config.statuses.map((s) => (
            <option key={s} value={s}>
              {s.replace('_', ' ').toUpperCase()}
            </option>
          ))}
        </select>
        <select className="field__input toolbar__filter" value={programId} onChange={(e) => setProgramId(e.target.value)}>
          <option value="">ALL PROGRAMS</option>
          {programs.map((p) => (
            <option key={p.id} value={String(p.id)}>
              {p.name}
            </option>
          ))}
        </select>
        <span className="toolbar__count mono">{rows ? `${rows.length} APPLICATIONS` : ''}</span>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">REF</th>
              <th className="mono">TITLE</th>
              <th className="mono">PROGRAM</th>
              <th className="mono">STATUS</th>
              <th className="mono num">REQUESTED</th>
              <th className="mono num">APPROVED</th>
              <th className="mono num">DISBURSED</th>
              <th className="mono num">REMAINING</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((a) => (
              <tr key={a.id}>
                <td className="mono">
                  <button className="linklike mono" onClick={() => onOpen(a.id)}>
                    {a.ref}
                  </button>
                </td>
                <td className="table__title" title={a.title}>
                  {a.title}
                </td>
                <td className="table__id">{a.program_name}</td>
                <td>
                  <StatusBadge status={a.status} />
                </td>
                <td className="num mono">{fmtEur(a.requested_amount_cents)}</td>
                <td className="num mono">{a.approved_amount_cents === null ? '—' : fmtEur(a.approved_amount_cents)}</td>
                <td className="num mono">{a.approved_amount_cents === null ? '—' : fmtEur(a.disbursed_cents)}</td>
                <td className="num mono">{a.remaining_cents === null ? '—' : fmtEur(a.remaining_cents)}</td>
              </tr>
            ))}
            {rows && rows.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={8}>
                  NO APPLICATIONS MATCH
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
