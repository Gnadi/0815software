import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type ExpenseClaimsState } from '../api';
import { fmtEur } from '../format';
import { Can } from '../access';

/**
 * Employees' approved expense claims from MOD-11, to pay by transfer: each
 * becomes a bill once (server/expense-claims.ts) and then goes through the
 * payment run like any other. Shown only when TIME_TRACKING_URL is set.
 */
export function ExpenseClaimsPanel({ onImported, onAuthLost }: { onImported: () => void; onAuthLost: () => void }) {
  const [state, setState] = useState<ExpenseClaimsState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await api.expenseClaims());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Could not load the expense claims');
    }
  }, [onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!state?.configured) return null;
  const waiting = state.waiting;

  async function take(number: string) {
    setBusy(number);
    setError('');
    try {
      await api.importExpenseClaim(number);
      await load();
      onImported();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Could not take the claim over');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="readbox">
      <div className="mono">EXPENSE CLAIMS · MOD-11 · {waiting.length} WAITING</div>
      {state.unreachable && <div className="readbox__warn mono">Time tracking could not be asked: {state.unreachable}</div>}
      {state.unreported.length > 0 && (
        <div className="readbox__warn mono">Paid here, not yet confirmed by time tracking: {state.unreported.join(', ')} — sent again on the next visit.</div>
      )}
      {error && <div className="resource__error mono">{error}</div>}
      {waiting.length === 0 ? (
        <p className="resource__desc">No approved claim is waiting to be paid by transfer.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th className="mono">CLAIM</th>
                <th className="mono">EMPLOYEE</th>
                <th className="mono">APPROVED</th>
                <th className="mono table__num">AMOUNT</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {waiting.map((c) => (
                <tr key={c.number}>
                  <td>
                    <span className="mono table__id">{c.number}</span>
                    <div>{c.title}</div>
                  </td>
                  <td>{c.employee_name}</td>
                  <td className="mono">{c.approved_at.slice(0, 10)}</td>
                  <td className="mono table__num">{fmtEur(c.total_cents)}</td>
                  <td>
                    {c.has_bank_account ? (
                      <Can>
                        <button className="rowbtn mono" disabled={busy !== null} onClick={() => void take(c.number)}>
                          {busy === c.number ? 'TAKING OVER…' : 'TAKE OVER AS BILL'}
                        </button>
                      </Can>
                    ) : (
                      <span className="readbox__warn mono">NO BANK ACCOUNT IN TIME TRACKING</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
