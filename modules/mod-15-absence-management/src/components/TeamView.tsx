import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Employee, Entitlement } from '../../shared/types';
import type { Region } from '../../shared/calendar';
import { api, ApiError, type AppConfig } from '../api';
import { fmtDays } from '../format';

interface Props {
  config: AppConfig;
  onChanged: () => void;
  onAuthLost: () => void;
}

const BLANK_EMPLOYEE = { name: '', email: '', started_on: '' };

/** The entitlement editor for one employee and one year. */
function EntitlementPanel({
  employee,
  year,
  onSaved,
  onAuthLost,
}: {
  employee: Employee;
  year: number;
  onSaved: () => void;
  onAuthLost: () => void;
}) {
  const [current, setCurrent] = useState<Entitlement | null | undefined>(undefined);
  const [form, setForm] = useState({ base_days: '', carry_over_days: '', carry_over_expires_on: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const { entitlement } = await api.entitlement(employee.id, year);
      setCurrent(entitlement);
      setForm({
        base_days: entitlement ? String(entitlement.base_days) : '30',
        carry_over_days: entitlement ? String(entitlement.carry_over_days) : '0',
        // The German and Austrian norm: unused carry-over lapses at the end of
        // March. Pre-filled rather than assumed, because it is contractual.
        carry_over_expires_on: entitlement?.carry_over_expires_on ?? `${year}-03-31`,
      });
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load the entitlement');
    }
  }, [employee.id, year, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      await api.setEntitlement(employee.id, {
        year,
        base_days: Number(form.base_days),
        carry_over_days: Number(form.carry_over_days),
        carry_over_expires_on: form.carry_over_expires_on || null,
      });
      setSaved(true);
      await load();
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save the entitlement');
    } finally {
      setBusy(false);
    }
  }

  if (current === undefined) return <div className="boot mono">LOADING…</div>;

  return (
    <form className="form form--inline" onSubmit={(e) => void save(e)}>
      <div className="form__grid">
        <label className="field">
          <span className="field__label mono">BASE DAYS {year}</span>
          <input
            className="field__input"
            value={form.base_days}
            onChange={(e) => setForm({ ...form, base_days: e.target.value })}
            inputMode="decimal"
            required
          />
        </label>
        <label className="field">
          <span className="field__label mono">CARRY-OVER FROM {year - 1}</span>
          <input
            className="field__input"
            value={form.carry_over_days}
            onChange={(e) => setForm({ ...form, carry_over_days: e.target.value })}
            inputMode="decimal"
          />
        </label>
        <label className="field">
          <span className="field__label mono">CARRY-OVER LAPSES ON</span>
          <input
            className="field__input"
            type="date"
            value={form.carry_over_expires_on}
            onChange={(e) => setForm({ ...form, carry_over_expires_on: e.target.value })}
          />
        </label>
      </div>
      {error && <div className="resource__error mono">{error}</div>}
      <div className="form__actions">
        <button className="btn btn--primary" type="submit" disabled={busy}>
          {busy ? 'SAVING…' : current ? 'UPDATE ENTITLEMENT →' : 'SET ENTITLEMENT →'}
        </button>
        {saved && <span className="form__ok mono">SAVED</span>}
        <span className="form__hint mono">
          {current
            ? `CURRENTLY ${fmtDays(current.base_days)} + ${fmtDays(current.carry_over_days)} CARRIED`
            : `NO ENTITLEMENT SET FOR ${year} YET`}
        </span>
      </div>
    </form>
  );
}

export function TeamView({ config, onChanged, onAuthLost }: Props) {
  const [rows, setRows] = useState<Employee[] | null>(null);
  const [includeLeft, setIncludeLeft] = useState(false);
  const [year, setYear] = useState(Number(config.today.slice(0, 4)));
  const [open, setOpen] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ...BLANK_EMPLOYEE, region: config.default_region });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { employees } = await api.employees(includeLeft);
      setRows(employees);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load the team');
    }
  }, [includeLeft, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const created = await api.createEmployee(form);
      setForm({ ...BLANK_EMPLOYEE, region: config.default_region });
      setShowForm(false);
      setOpen(created.id);
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add the employee');
    } finally {
      setBusy(false);
    }
  }

  async function offboard(employee: Employee) {
    const leftOn = window.prompt(`Last day for ${employee.name} (YYYY-MM-DD)`, config.today);
    if (leftOn === null) return;
    try {
      await api.offboard(employee.id, leftOn);
      await load();
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof ApiError ? err.message : 'Failed to offboard');
    }
  }

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ ABS.04 · TEAM</div>
          <h1 className="resource__title">Team</h1>
          <p className="resource__desc">
            Each employee carries their own public-holiday calendar. It is not a cosmetic setting: it decides how many
            days a given week costs them, so it is set once, per person, and everything else follows from it.
          </p>
        </div>
        <div className="resource__actions">
          <button className="btn btn--ghost" onClick={() => setYear((y) => y - 1)}>
            ← {year - 1}
          </button>
          <button className="btn btn--ghost" onClick={() => setYear((y) => y + 1)}>
            {year + 1} →
          </button>
          <button className="btn btn--primary" onClick={() => setShowForm((s) => !s)}>
            {showForm ? 'CLOSE' : 'ADD EMPLOYEE +'}
          </button>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      {showForm && (
        <form className="form" onSubmit={(e) => void create(e)}>
          <div className="form__grid">
            <label className="field">
              <span className="field__label mono">NAME</span>
              <input
                className="field__input"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </label>
            <label className="field">
              <span className="field__label mono">EMAIL</span>
              <input
                className="field__input"
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                required
              />
            </label>
            <label className="field">
              <span className="field__label mono">HOLIDAY CALENDAR</span>
              <select
                className="field__input"
                value={form.region}
                onChange={(e) => setForm({ ...form, region: e.target.value as Region })}
              >
                {config.regions.map((region) => (
                  <option key={region.code} value={region.code}>
                    {region.code} · {region.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field__label mono">STARTED ON</span>
              <input
                className="field__input"
                type="date"
                value={form.started_on}
                onChange={(e) => setForm({ ...form, started_on: e.target.value })}
                required
              />
            </label>
          </div>
          <div className="form__actions">
            <button className="btn btn--primary" type="submit" disabled={busy}>
              {busy ? 'ADDING…' : 'ADD EMPLOYEE →'}
            </button>
          </div>
        </form>
      )}

      <div className="toolbar">
        <label className="toolbar__check mono">
          <input type="checkbox" checked={includeLeft} onChange={(e) => setIncludeLeft(e.target.checked)} />
          SHOW PEOPLE WHO HAVE LEFT
        </label>
        <span className="toolbar__count mono">{rows === null ? '…' : `${rows.length} PERSON(S)`}</span>
      </div>

      <div className="rows">
        {rows?.map((employee) => (
          <div key={employee.id} className={`linerow ${employee.left_on ? 'linerow--muted' : ''}`}>
            <div className="linerow__head">
              <div>
                <div className="linerow__title">{employee.name}</div>
                <div className="linerow__meta mono">
                  {employee.email} · {employee.region} · SINCE {employee.started_on}
                  {employee.left_on && ` · LEFT ${employee.left_on}`}
                </div>
              </div>
              <div className="linerow__actions">
                <button
                  className="btn btn--ghost btn--sm"
                  onClick={() => setOpen(open === employee.id ? null : employee.id)}
                >
                  {open === employee.id ? 'CLOSE' : `ENTITLEMENT ${year}`}
                </button>
                {!employee.left_on && (
                  <button className="btn btn--ghost btn--sm" onClick={() => void offboard(employee)}>
                    OFFBOARD
                  </button>
                )}
              </div>
            </div>
            {open === employee.id && (
              <EntitlementPanel employee={employee} year={year} onSaved={onChanged} onAuthLost={onAuthLost} />
            )}
          </div>
        ))}
        {rows !== null && rows.length === 0 && <div className="rows__empty mono">NO EMPLOYEES YET</div>}
      </div>
    </div>
  );
}
