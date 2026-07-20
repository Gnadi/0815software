import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type SummaryResponse } from '../api';
import { addDays, fmtEur, fmtHm, weekStartOf } from '../format';

interface Props {
  onAuthLost: () => void;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function SummaryView({ onAuthLost }: Props) {
  const [from, setFrom] = useState<string>(() => addDays(weekStartOf(todayIso()), -21));
  const [to, setTo] = useState<string>(() => addDays(weekStartOf(todayIso()), 6));
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setSummary(await api.summary(from, to));
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, [from, to, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ TT.03 · ROLLUPS</div>
          <h1 className="resource__title">Summary</h1>
          <p className="resource__desc">
            Per-project and per-employee rollups over a date range. Every figure is derived from the
            raw entries at query time — nothing here is stored, so it can never disagree with the
            daily grid.
          </p>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="toolbar">
        <label className="field__label mono">FROM</label>
        <input className="field__input toolbar__filter" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <label className="field__label mono">TO</label>
        <input className="field__input toolbar__filter" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>

      {summary && (
        <>
          <div className="stat-row">
            <div className="stat">
              <div className="stat__label mono">TOTAL</div>
              <div className="stat__value">{fmtHm(summary.total_minutes)}</div>
            </div>
            <div className="stat">
              <div className="stat__label mono">BILLABLE</div>
              <div className="stat__value">{fmtHm(summary.billable_minutes)}</div>
            </div>
            <div className="stat">
              <div className="stat__label mono">BILLABLE AMOUNT</div>
              <div className="stat__value">{fmtEur(summary.billable_cents)}</div>
            </div>
          </div>

          <div className="section-title mono">BY PROJECT</div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Client</th>
                  <th>Total</th>
                  <th>Billable</th>
                  <th>Amount</th>
                  <th>Entries</th>
                </tr>
              </thead>
              <tbody>
                {summary.by_project.map((r) => (
                  <tr key={r.project_id}>
                    <td>{r.project_name}</td>
                    <td className="mono">{r.client ?? '—'}</td>
                    <td className="mono">{fmtHm(r.total_minutes)}</td>
                    <td className="mono">{fmtHm(r.billable_minutes)}</td>
                    <td className="mono">{fmtEur(r.billable_cents)}</td>
                    <td className="mono">{r.entry_count}</td>
                  </tr>
                ))}
                {summary.by_project.length === 0 && (
                  <tr>
                    <td className="table__empty mono" colSpan={6}>
                      NO ENTRIES IN RANGE
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="section-title mono">BY EMPLOYEE</div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Total</th>
                  <th>Billable</th>
                  <th>Amount</th>
                  <th>Entries</th>
                </tr>
              </thead>
              <tbody>
                {summary.by_employee.map((r) => (
                  <tr key={r.employee_id}>
                    <td>{r.employee_name}</td>
                    <td className="mono">{fmtHm(r.total_minutes)}</td>
                    <td className="mono">{fmtHm(r.billable_minutes)}</td>
                    <td className="mono">{fmtEur(r.billable_cents)}</td>
                    <td className="mono">{r.entry_count}</td>
                  </tr>
                ))}
                {summary.by_employee.length === 0 && (
                  <tr>
                    <td className="table__empty mono" colSpan={5}>
                      NO ENTRIES IN RANGE
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
