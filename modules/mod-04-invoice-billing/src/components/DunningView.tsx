import { useCallback, useEffect, useState } from 'react';
import type { DunningRow, DunningSettings, FieldError } from '../../shared/types';
import { Can, useCan } from '../access';
import { api, ApiError, dunningLetterUrl } from '../api';
import { fmtDate, fmtEur } from '../format';

/**
 * DUNNING — the overdue invoices and which reminder each needs next.
 *
 * Everything in the table is derived by the server on every load (how late,
 * which level, from when); the only thing stored is each notice that went
 * out, whose letter stays downloadable as it was sent. Issuing one notice is
 * ordinary work; a run over every due invoice and the levels themselves are
 * the admin's (`manage`).
 */

interface Props {
  onOpenInvoice: (id: number) => void;
  onAuthLost: () => void;
}

export function DunningView({ onOpenInvoice, onAuthLost }: Props) {
  const [rows, setRows] = useState<DunningRow[] | null>(null);
  const [settings, setSettings] = useState<DunningSettings | null>(null);
  const [error, setError] = useState('');
  const [details, setDetails] = useState<FieldError[]>([]);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const canManage = useCan('manage');

  const handle = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        onAuthLost();
        return;
      }
      setError(err instanceof Error ? err.message : 'Request failed');
      setDetails(err instanceof ApiError ? err.details : []);
    },
    [onAuthLost],
  );

  const load = useCallback(async () => {
    try {
      const data = await api.dunning();
      setRows(data.rows);
      setSettings(data.settings);
    } catch (err) {
      handle(err);
    }
  }, [handle]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(action: () => Promise<string>) {
    setBusy(true);
    setError('');
    setDetails([]);
    setNotice('');
    try {
      setNotice(await action());
      await load();
    } catch (err) {
      handle(err);
    } finally {
      setBusy(false);
    }
  }

  const due = rows?.filter((r) => r.due_now) ?? [];

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ INV.05 · RECEIVABLES</div>
          <h1 className="resource__title">Dunning</h1>
          <p className="resource__desc">
            Overdue invoices with an open amount, and the reminder each needs next. Levels go in order, with at
            least {settings?.min_days_between ?? '…'} days between two notices. Fees and interest are stated on the
            letter, not booked onto the invoice.
          </p>
        </div>
        <Can level="manage">
          <div className="resource__actions">
            <button
              className="btn btn--primary"
              disabled={busy || due.length === 0}
              onClick={() =>
                void act(async () => {
                  const { issued } = await api.dunningRun();
                  return `${issued.length} notice${issued.length === 1 ? '' : 's'} issued`;
                })
              }
            >
              RUN — {due.length} DUE
            </button>
          </div>
        </Can>
      </div>

      {error && (
        <div className="resource__error mono">
          {error}
          {details.map((d) => (
            <div key={d.field + d.message}>
              {d.field}: {d.message}
            </div>
          ))}
        </div>
      )}
      {notice && <div className="totals__row mono">{notice}</div>}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Customer</th>
              <th>Due</th>
              <th className="table__num">Days late</th>
              <th className="table__num">Open</th>
              <th>Sent</th>
              <th>Next</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows?.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={8}>
                  NOTHING OVERDUE
                </td>
              </tr>
            )}
            {rows?.map((r) => (
              <tr key={r.invoice_id}>
                <td>
                  <button className="linklike mono" onClick={() => onOpenInvoice(r.invoice_id)}>
                    {r.number}
                  </button>
                </td>
                <td>{r.customer_name}</td>
                <td className="mono">{fmtDate(r.due_date)}</td>
                <td className="table__num mono">{r.days_overdue}</td>
                <td className="table__num mono">{fmtEur(r.open_cents)}</td>
                <td>
                  {r.notices.length === 0
                    ? '—'
                    : r.notices.map((n) => (
                        <div key={n.id}>
                          <a className="linklike mono" href={dunningLetterUrl(n.id)}>
                            {n.level_name} · {fmtDate(n.issued_on)}
                          </a>
                        </div>
                      ))}
                </td>
                <td className="mono">
                  {r.next_level_name === null ? 'ALL LEVELS SENT' : r.due_now ? r.next_level_name : `${r.next_level_name} from ${fmtDate(r.next_on!)}`}
                </td>
                <td className="table__rowactions">
                  {r.due_now && (
                    <Can>
                      <button
                        className="rowbtn mono"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            const issued = await api.issueDunningNotice(r.invoice_id);
                            return `${issued.level_name} for ${r.number} issued`;
                          })
                        }
                      >
                        ISSUE {r.next_level_name?.toUpperCase()}
                      </button>
                    </Can>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {settings && <LevelsPanel settings={settings} editable={canManage} onSaved={load} onError={handle} />}
    </div>
  );
}

/** The dunning levels — read-only below `manage`. */
function LevelsPanel({
  settings,
  editable,
  onSaved,
  onError,
}: {
  settings: DunningSettings;
  editable: boolean;
  onSaved: () => Promise<void>;
  onError: (err: unknown) => void;
}) {
  const [form, setForm] = useState(settings);
  const [saved, setSaved] = useState('');

  useEffect(() => setForm(settings), [settings]);

  const setLevel = (i: number, patch: Partial<DunningSettings['levels'][number]>) =>
    setForm({ ...form, levels: form.levels.map((l, j) => (j === i ? { ...l, ...patch } : l)) });

  async function save() {
    setSaved('');
    try {
      const res = await api.saveDunningSettings(form);
      setSaved(`Saved by ${res.updated_by ?? '—'}`);
      await onSaved();
    } catch (err) {
      onError(err);
    }
  }

  return (
    <div style={{ marginTop: 32 }}>
      <div className="section-title mono">LEVELS</div>
      {form.levels.map((level, i) => (
        <div key={i} className="editbar" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
          <input className="field__input" style={{ width: 180 }} disabled={!editable} value={level.name} onChange={(e) => setLevel(i, { name: e.target.value })} />
          <label className="mono">
            FROM DAY{' '}
            <input className="field__input" style={{ width: 70 }} disabled={!editable} value={level.days_after_due} onChange={(e) => setLevel(i, { days_after_due: Number(e.target.value) })} />
          </label>
          <label className="mono">
            FEE €{' '}
            <input
              className="field__input"
              style={{ width: 90 }}
              disabled={!editable}
              value={(level.fee_cents / 100).toFixed(2)}
              onChange={(e) => setLevel(i, { fee_cents: Math.round(Number(e.target.value.replace(',', '.')) * 100) })}
            />
          </label>
          <textarea className="field__input" style={{ width: '100%', minHeight: 60 }} disabled={!editable} value={level.text} onChange={(e) => setLevel(i, { text: e.target.value })} />
        </div>
      ))}
      <div className="editbar" style={{ gap: 12 }}>
        <label className="mono">
          DAYS BETWEEN NOTICES{' '}
          <input className="field__input" style={{ width: 70 }} disabled={!editable} value={form.min_days_between} onChange={(e) => setForm({ ...form, min_days_between: Number(e.target.value) })} />
        </label>
        <label className="mono">
          INTEREST % P.A.{' '}
          <input
            className="field__input"
            style={{ width: 90 }}
            disabled={!editable}
            placeholder="none"
            value={form.interest_rate_percent ?? ''}
            onChange={(e) => setForm({ ...form, interest_rate_percent: e.target.value === '' ? null : Number(e.target.value.replace(',', '.')) })}
          />
        </label>
        {editable && (
          <button className="btn btn--primary" onClick={() => void save()}>
            SAVE LEVELS
          </button>
        )}
        {saved && <span className="mono table__id">{saved}</span>}
      </div>
    </div>
  );
}
