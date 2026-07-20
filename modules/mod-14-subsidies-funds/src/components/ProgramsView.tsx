import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { AppConfig, ProgramRow } from '../../shared/types';
import { api, ApiError } from '../api';
import { eurosToCents, fmtDate, fmtEur } from '../format';
import { ProgramStatusBadge } from './Badges';

interface Props {
  config: AppConfig;
  onOpen: (id: number) => void;
  onAuthLost: () => void;
}

const EMPTY = {
  name: '',
  funding_body: '',
  category: 'digitalisation',
  funding_rate: '50',
  max_grant: '',
  application_deadline: '',
  description: '',
};

export function ProgramsView({ config, onOpen, onAuthLost }: Props) {
  const [rows, setRows] = useState<ProgramRow[] | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [category, setCategory] = useState('');
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      if (status) params.set('status', status);
      if (category) params.set('category', category);
      const { programs } = await api.programs(params);
      setRows(programs);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load programs');
    }
  }, [search, status, category, onAuthLost]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 150);
    return () => clearTimeout(t);
  }, [load]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const maxGrant = eurosToCents(form.max_grant);
      if (maxGrant === null) throw new ApiError(422, 'Max grant must be an amount like 50000 or 50000.00');
      const created = await api.createProgram({
        name: form.name,
        funding_body: form.funding_body,
        category: form.category,
        funding_rate: Number(form.funding_rate),
        max_grant_cents: maxGrant,
        application_deadline: form.application_deadline || null,
        description: form.description || null,
        status: 'open',
      });
      setForm(EMPTY);
      setShowForm(false);
      onOpen(created.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create the program');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ SUB.02 · PROGRAMS</div>
          <h1 className="resource__title">Funding programs</h1>
          <p className="resource__desc">
            Public and private funding programs we can apply to. Funding rate is the share of eligible costs a
            program covers; the max grant is its ceiling per application.
          </p>
        </div>
        <div className="resource__actions">
          <button className="btn btn--primary" onClick={() => setShowForm((s) => !s)}>
            {showForm ? 'CLOSE' : 'NEW PROGRAM +'}
          </button>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      {showForm && (
        <form className="form" onSubmit={(e) => void create(e)}>
          <div className="form__grid">
            <label className="field">
              <span className="field__label mono">NAME</span>
              <input className="field__input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </label>
            <label className="field">
              <span className="field__label mono">FUNDING BODY</span>
              <input className="field__input" value={form.funding_body} onChange={(e) => setForm({ ...form, funding_body: e.target.value })} required />
            </label>
            <label className="field">
              <span className="field__label mono">CATEGORY</span>
              <select className="field__input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                {config.categories.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field__label mono">FUNDING RATE %</span>
              <input className="field__input" type="number" min={0} max={100} value={form.funding_rate} onChange={(e) => setForm({ ...form, funding_rate: e.target.value })} />
            </label>
            <label className="field">
              <span className="field__label mono">MAX GRANT (EUR)</span>
              <input className="field__input" value={form.max_grant} onChange={(e) => setForm({ ...form, max_grant: e.target.value })} placeholder="50000.00" required />
            </label>
            <label className="field">
              <span className="field__label mono">DEADLINE (BLANK = ROLLING)</span>
              <input className="field__input" type="date" value={form.application_deadline} onChange={(e) => setForm({ ...form, application_deadline: e.target.value })} />
            </label>
          </div>
          <label className="field">
            <span className="field__label mono">DESCRIPTION</span>
            <textarea className="field__input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </label>
          <div className="form__actions">
            <button className="btn btn--primary" type="submit" disabled={busy}>
              {busy ? 'SAVING…' : 'CREATE PROGRAM →'}
            </button>
          </div>
        </form>
      )}

      <div className="toolbar">
        <input className="field__input toolbar__search" placeholder="Search name or funding body…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="field__input toolbar__filter" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">ALL STATUS</option>
          {config.program_statuses.map((s) => (
            <option key={s} value={s}>
              {s.toUpperCase()}
            </option>
          ))}
        </select>
        <select className="field__input toolbar__filter" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">ALL CATEGORIES</option>
          {config.categories.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <span className="toolbar__count mono">{rows ? `${rows.length} PROGRAMS` : ''}</span>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">NAME</th>
              <th className="mono">FUNDING BODY</th>
              <th className="mono">CATEGORY</th>
              <th className="mono num">RATE</th>
              <th className="mono num">MAX GRANT</th>
              <th className="mono">DEADLINE</th>
              <th className="mono num">APPS</th>
              <th className="mono">STATUS</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((p) => (
              <tr key={p.id}>
                <td className="table__title" title={p.name}>
                  <button className="linklike" onClick={() => onOpen(p.id)}>
                    {p.name}
                  </button>
                </td>
                <td className="table__id">{p.funding_body}</td>
                <td className="table__id">{p.category_label}</td>
                <td className="num mono">{p.funding_rate}%</td>
                <td className="num mono">{fmtEur(p.max_grant_cents)}</td>
                <td className="mono table__id">{p.application_deadline ? fmtDate(p.application_deadline) : 'rolling'}</td>
                <td className="num mono">{p.application_count}</td>
                <td>
                  <ProgramStatusBadge status={p.status} />
                </td>
              </tr>
            ))}
            {rows && rows.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={8}>
                  NO PROGRAMS MATCH
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
