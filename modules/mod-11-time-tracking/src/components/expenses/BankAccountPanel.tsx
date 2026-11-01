import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { BankAccount } from '../../../shared/expense-types';
import { formatIban, ibanProblem } from '../../../shared/iban';
import { api, ApiError } from '../../api';

/**
 * Where one's expenses are paid to. Every change is kept, with who made it,
 * and the person is mailed about it — a changed payout account is how
 * payroll fraud starts.
 */
export function BankAccountPanel({ onAuthLost }: { onAuthLost: () => void }) {
  const [account, setAccount] = useState<BankAccount | null>(null);
  const [history, setHistory] = useState<BankAccount[]>([]);
  const [holder, setHolder] = useState('');
  const [iban, setIban] = useState('');
  const [bic, setBic] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const handle = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof ApiError && err.details.length > 0 ? err.details.map((d) => d.message).join(' · ') : err instanceof Error ? err.message : 'Failed');
    },
    [onAuthLost],
  );

  const load = useCallback(async () => {
    try {
      const res = await api.bankAccount();
      setAccount(res.account);
      setHistory(res.history);
    } catch (err) {
      handle(err);
    }
  }, [handle]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(e: FormEvent) {
    e.preventDefault();
    const problem = ibanProblem(iban);
    if (problem) {
      setError(problem);
      return;
    }
    setError('');
    try {
      const res = await api.saveBankAccount({ holder, iban, bic: bic || null });
      setAccount(res.account);
      setHistory(res.history);
      setIban('');
      setBic('');
      setMessage('Saved — from now on your expenses are paid to this account');
    } catch (err) {
      handle(err);
    }
  }

  return (
    <div>
      <div className="section-title mono">PAID TO</div>
      {account ? (
        <div className="item">
          <div className="item__main">
            <div>{account.holder}</div>
            <div className="mono item__meta">
              {formatIban(account.iban)}
              {account.bic ? ` · ${account.bic}` : ''} · SINCE {account.created_at.slice(0, 10)} · BY {account.actor}
            </div>
          </div>
        </div>
      ) : (
        <div className="table__empty mono">No account yet. Claims paid by transfer need one.</div>
      )}
      <form className="capture" onSubmit={save}>
        <div className="form-grid">
          <label className="field">
            <span className="field__label mono">ACCOUNT HOLDER</span>
            <input className="field__input" value={holder} onChange={(e) => setHolder(e.target.value)} required maxLength={70} />
          </label>
          <label className="field">
            <span className="field__label mono">IBAN</span>
            <input className="field__input mono" value={iban} onChange={(e) => setIban(e.target.value)} placeholder="AT61 1904 3002 3457 3201" required autoComplete="off" />
          </label>
          <label className="field">
            <span className="field__label mono">BIC (OPTIONAL)</span>
            <input className="field__input mono" value={bic} onChange={(e) => setBic(e.target.value)} autoComplete="off" />
          </label>
        </div>
        <button className="btn btn--primary">{account ? 'CHANGE ACCOUNT' : 'SAVE ACCOUNT'}</button>
      </form>
      {message && <div className="lockbar mono">{message}</div>}
      {error && <div className="resource__error mono">{error}</div>}
      {history.length > 1 && (
        <>
          <div className="section-title mono">EARLIER</div>
          {history.slice(1).map((h, i) => (
            <div key={i} className="mono item__meta">
              {h.created_at.slice(0, 10)} · {h.holder} · {formatIban(h.iban)} · BY {h.actor}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
