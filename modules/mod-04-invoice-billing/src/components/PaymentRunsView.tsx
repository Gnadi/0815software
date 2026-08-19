import { useCallback, useEffect, useState } from 'react';
import type { PaymentRunDetail, PaymentRunRow, RunStatus } from '../../shared/types';
import { api, ApiError, paymentRunXmlUrl } from '../api';
import { fmtDateTime, fmtEur } from '../format';

/**
 * PAYMENT RUNS — the files, and what happened to each of them.
 *
 * A run has exactly three ends: it is downloaded and uploaded to the bank and
 * then confirmed as executed, or it is discarded and its bills go back to
 * open. Both are one click, and the screen says which bills are affected
 * either way, because "which of these files did I actually upload?" is the
 * question this list exists to answer three weeks later.
 */

interface ListProps {
  onOpen: (id: number) => void;
  onAuthLost: () => void;
}

const STATUS_LABEL: Record<RunStatus, string> = {
  created: 'READY TO UPLOAD',
  executed: 'EXECUTED',
  discarded: 'DISCARDED',
};

export function PaymentRunsView({ onOpen, onAuthLost }: ListProps) {
  const [rows, setRows] = useState<PaymentRunRow[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const { runs } = await api.paymentRuns();
      setRows(runs);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load payment runs');
    }
  }, [onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ INV.06 · PAYABLES</div>
          <h1 className="resource__title">Payment runs</h1>
          <p className="resource__desc">
            Every pain.001 file this installation has produced. The message id is what your bank calls the
            same file.
          </p>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">MESSAGE ID</th>
              <th className="mono">EXECUTION</th>
              <th className="mono">STATUS</th>
              <th className="mono">TRANSFERS</th>
              <th className="mono table__num">TOTAL</th>
              <th className="mono">CREATED</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((run) => (
              <tr key={run.id}>
                <td>
                  <button className="linklike mono" onClick={() => onOpen(run.id)}>
                    {run.message_id}
                  </button>
                </td>
                <td className="mono table__id">{run.execution_date}</td>
                <td>
                  <span className={`badge mono badge--run-${run.status}`}>{STATUS_LABEL[run.status]}</span>
                </td>
                <td className="table__num mono">{run.item_count}</td>
                <td className="table__num">{fmtEur(run.total_cents)}</td>
                <td className="mono table__id">{fmtDateTime(run.created_at)}</td>
              </tr>
            ))}
            {rows && rows.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={6}>
                  NO PAYMENT RUNS YET — SELECT BILLS ON THE BILLS SCREEN
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface DetailProps {
  id: number;
  onBack: () => void;
  onAuthLost: () => void;
}

export function PaymentRunDetailView({ id, onBack, onAuthLost }: DetailProps) {
  const [run, setRun] = useState<PaymentRunDetail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRun(await api.paymentRun(id));
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load the payment run');
    }
  }, [id, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(action: () => Promise<PaymentRunDetail>, fallback: string): Promise<void> {
    setBusy(true);
    try {
      setRun(await action());
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  if (!run) {
    return (
      <div>
        <button className="backlink mono" onClick={onBack}>
          ← PAYMENT RUNS
        </button>
        {error && <div className="resource__error mono">{error}</div>}
      </div>
    );
  }

  return (
    <div>
      <button className="backlink mono" onClick={onBack}>
        ← PAYMENT RUNS
      </button>

      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ INV.06 · SEPA CREDIT TRANSFER</div>
          <h1 className="resource__title mono">{run.message_id}</h1>
          <p className="resource__desc">
            {run.item_count} transfer(s) of {fmtEur(run.total_cents)} from {run.debtor_name}, to be executed
            on {run.execution_date}.
          </p>
        </div>
        <div className="resource__actions">
          {/* A plain link: the browser downloads the file, and it never passes
              through JavaScript. Downloading again yields the same bytes. */}
          <a className="btn btn--primary" href={paymentRunXmlUrl(run.id)} download>
            DOWNLOAD XML ↓
          </a>
          {run.status === 'created' && (
            <>
              <button
                className="btn"
                disabled={busy}
                title="The bank has executed this file — settle every bill in it"
                onClick={() => void act(() => api.markRunExecuted(run.id), 'Could not confirm the run')}
              >
                MARK EXECUTED
              </button>
              <button
                className="btn btn--ghost"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      'Discard this run? Its bills go back to open, and the file must not be uploaded.',
                    )
                  ) {
                    void act(() => api.discardRun(run.id), 'Could not discard the run');
                  }
                }}
              >
                DISCARD
              </button>
            </>
          )}
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="stat-row">
        <div className="stat">
          <div className="stat__label mono">STATUS</div>
          <div className="stat__value">
            <span className={`badge mono badge--run-${run.status}`}>{STATUS_LABEL[run.status]}</span>
          </div>
        </div>
        <div className="stat stat--total">
          <div className="stat__label mono">CONTROL SUM</div>
          <div className="stat__value">{fmtEur(run.total_cents)}</div>
        </div>
        <div className="stat">
          <div className="stat__label mono">DEBTOR ACCOUNT</div>
          <div className="stat__value stat__value--small mono">{run.debtor_iban}</div>
        </div>
        <div className="stat">
          <div className="stat__label mono">CREATED</div>
          <div className="stat__value stat__value--small mono">{fmtDateTime(run.created_at)}</div>
        </div>
      </div>

      {run.status === 'created' && (
        <p className="resource__desc">
          Upload the file in your online banking (SEPA credit transfer / file upload), authorise it there,
          then mark the run executed here so its bills are settled.
        </p>
      )}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">#</th>
              <th className="mono">CREDITOR</th>
              <th className="mono">IBAN</th>
              <th className="mono">END-TO-END ID</th>
              <th className="mono">PURPOSE</th>
              <th className="mono table__num">AMOUNT</th>
            </tr>
          </thead>
          <tbody>
            {run.items.map((item) => (
              <tr key={item.bill_id}>
                <td className="mono table__id">{item.position}</td>
                <td>{item.creditor_name}</td>
                <td className="mono table__id">{item.creditor_iban}</td>
                <td className="mono table__id">{item.end_to_end_id}</td>
                <td className="mono table__id">{item.remittance}</td>
                <td className="table__num">{fmtEur(item.amount_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
