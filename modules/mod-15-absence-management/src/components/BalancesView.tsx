import { useCallback, useEffect, useState } from 'react';
import type { Balance } from '../../shared/types';
import { api, ApiError, type AppConfig } from '../api';
import { fmtDays } from '../format';

interface Props {
  config: AppConfig;
  onAuthLost: () => void;
}

export function BalancesView({ config, onAuthLost }: Props) {
  const [year, setYear] = useState(Number(config.today.slice(0, 4)));
  const [rows, setRows] = useState<Balance[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const { balances } = await api.balances(year);
      setRows(balances);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load balances');
    }
  }, [year, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ ABS.03 · BALANCES</div>
          <h1 className="resource__title">Leave balances {year}</h1>
          <p className="resource__desc">
            Derived on every read from the entitlement and the approved requests — there is no stored balance column
            anywhere in this module, so there is nothing for a failed job or a manual edit to leave inconsistent.
          </p>
        </div>
        <div className="resource__actions">
          <button className="btn btn--ghost" onClick={() => setYear((y) => y - 1)}>
            ← {year - 1}
          </button>
          <button className="btn btn--ghost" onClick={() => setYear((y) => y + 1)}>
            {year + 1} →
          </button>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Employee</th>
              <th className="num">Base</th>
              <th className="num">Carry-over</th>
              <th className="num">Lapsed</th>
              <th className="num">Entitled</th>
              <th className="num">Taken</th>
              <th className="num">Pending</th>
              <th className="num">Remaining</th>
              <th className="num">If all approved</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((row) => (
              <tr key={row.employee_id}>
                <td>{row.employee_name}</td>
                <td className="num mono">{fmtDays(row.base_days)}</td>
                <td className="num mono">{fmtDays(row.carry_over_days)}</td>
                <td className="num mono table__muted">
                  {row.carry_over_expired_days > 0 ? `−${fmtDays(row.carry_over_expired_days)}` : '—'}
                </td>
                <td className="num mono">{fmtDays(row.entitled_days)}</td>
                <td className="num mono">{fmtDays(row.taken_days)}</td>
                <td className="num mono table__muted">{fmtDays(row.pending_days)}</td>
                <td className="num mono">
                  <strong>{fmtDays(row.remaining_days)}</strong>
                </td>
                <td
                  className={`num mono ${row.projected_remaining_days < 0 ? 'cell--alert' : 'table__muted'}`}
                  title={
                    row.projected_remaining_days < 0
                      ? 'Approving everything outstanding would overdraw this entitlement'
                      : undefined
                  }
                >
                  {fmtDays(row.projected_remaining_days)}
                </td>
              </tr>
            ))}
            {rows !== null && rows.length === 0 && (
              <tr>
                <td colSpan={9} className="table__empty mono">
                  NO EMPLOYEES YET
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
