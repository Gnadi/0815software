import { useState } from 'react';
import type { ExpenseMileage, ExpenseReceipt, ExpenseTrip } from '../../../shared/expense-types';
import { api, ApiError, receiptFileUrl } from '../../api';
import { fmtEur } from '../../format';
import { newClientId, removeFromOutbox, type OutboxItem } from '../../pwa/outbox';
import { CATEGORY_LABEL, fmtKm, fmtLocal } from './common';

/**
 * What is recorded and not yet claimed — on the server, and still on this
 * device — and the one action that makes a claim of it.
 */

interface Props {
  trips: ExpenseTrip[];
  mileage: ExpenseMileage[];
  receipts: ExpenseReceipt[];
  waiting: OutboxItem[];
  online: boolean;
  onChanged: (message?: string) => void;
  onSendNow: () => void;
  onAuthLost: () => void;
}

type Key = `${'trip' | 'mileage' | 'receipt'}:${number}`;

export function ItemsPanel({ trips, mileage, receipts, waiting, online, onChanged, onSendNow, onAuthLost }: Props) {
  const all = new Set<Key>([...trips.map((t) => `trip:${t.id}` as Key), ...mileage.map((m) => `mileage:${m.id}` as Key), ...receipts.map((r) => `receipt:${r.id}` as Key)]);
  const [selected, setSelected] = useState<Set<Key> | null>(null);
  const chosen = selected ?? all;
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const toggle = (key: Key) => {
    const next = new Set(chosen);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelected(next);
  };
  const ids = (kind: string) => [...chosen].filter((k) => k.startsWith(`${kind}:`)).map((k) => Number(k.split(':')[1]));
  const total =
    trips.filter((t) => chosen.has(`trip:${t.id}`)).reduce((a, t) => a + t.total_cents, 0) +
    mileage.filter((m) => chosen.has(`mileage:${m.id}`)).reduce((a, m) => a + m.amount_cents, 0) +
    receipts.filter((r) => chosen.has(`receipt:${r.id}`)).reduce((a, r) => a + r.reimbursable_cents, 0);
  const blocked = [
    ...trips.filter((t) => chosen.has(`trip:${t.id}`) && t.rate_problem).map((t) => t.rate_problem!),
    ...mileage.filter((m) => chosen.has(`mileage:${m.id}`) && m.rate_problem).map((m) => m.rate_problem!),
    ...receipts.filter((r) => chosen.has(`receipt:${r.id}`) && r.file_missing).map((r) => `The receipt from ${r.merchant} needs its picture`),
  ];

  async function act(work: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError('');
    try {
      await work();
      setSelected(null);
      setTitle('');
      onChanged(done);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof ApiError && err.details.length > 0 ? err.details.map((d) => d.message).join(' · ') : err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  const remove = (label: string, work: () => Promise<unknown>) => {
    if (window.confirm(`Delete ${label}?`)) void act(work, 'Deleted');
  };

  return (
    <div>
      {waiting.length > 0 && (
        <div className="itemlist">
          <div className="section-title mono">ON THIS DEVICE, NOT SENT YET · {waiting.length}</div>
          {waiting.map((w) => (
            <div key={w.id} className="item">
              <div className="item__main">
                <div>{w.label}</div>
                <div className="mono item__meta">
                  {w.kind.toUpperCase()} · {w.created_at.slice(0, 16).replace('T', ' ')}
                  {w.file ? ' · WITH PICTURE' : ''}
                </div>
                {w.error && <div className="mono item__error">REFUSED: {w.error}</div>}
              </div>
              <button type="button" className="rowbtn rowbtn--danger mono" onClick={() => window.confirm(`Discard "${w.label}" from this device?`) && void removeFromOutbox(w.id).then(() => onChanged('Discarded'))}>
                DISCARD
              </button>
            </div>
          ))}
          <button type="button" className="btn" disabled={!online} onClick={onSendNow}>
            {online ? 'SEND NOW' : 'OFFLINE — SENT WHEN THE CONNECTION IS BACK'}
          </button>
        </div>
      )}

      <div className="itemlist">
        <div className="section-title mono">RECORDED, NOT CLAIMED</div>
        {all.size === 0 && <div className="table__empty mono">Nothing open. Capture a receipt, a trip or a drive.</div>}
        {trips.map((t) => (
          <label key={`t${t.id}`} className="item">
            <input type="checkbox" checked={chosen.has(`trip:${t.id}`)} onChange={() => toggle(`trip:${t.id}`)} />
            <div className="item__main">
              <div>
                Trip · {t.destination}
                {t.country ? ` (${t.country})` : ''}
              </div>
              <div className="mono item__meta">
                {fmtLocal(t.start_local)} – {fmtLocal(t.end_local)} · {t.periods.length} PERIOD(S){t.nights_flat ? ` · ${t.nights_flat} NIGHT(S)` : ''}
              </div>
              {t.rate_problem && <div className="mono item__error">{t.rate_problem}</div>}
            </div>
            <div className="item__amount mono">{fmtEur(t.total_cents)}</div>
            <button type="button" className="rowbtn rowbtn--danger mono" onClick={() => remove('this trip', () => api.deleteTrip(t.id))}>
              ×
            </button>
          </label>
        ))}
        {mileage.map((m) => (
          <label key={`m${m.id}`} className="item">
            <input type="checkbox" checked={chosen.has(`mileage:${m.id}`)} onChange={() => toggle(`mileage:${m.id}`)} />
            <div className="item__main">
              <div>
                Drive · {m.from_place} – {m.to_place}
              </div>
              <div className="mono item__meta">
                {m.travel_date} · {fmtKm(m.km_tenths)}
                {m.passengers ? ` · +${m.passengers}` : ''}
              </div>
              {m.rate_problem && <div className="mono item__error">{m.rate_problem}</div>}
            </div>
            <div className="item__amount mono">{fmtEur(m.amount_cents)}</div>
            <button type="button" className="rowbtn rowbtn--danger mono" onClick={() => remove('this drive', () => api.deleteMileage(m.id))}>
              ×
            </button>
          </label>
        ))}
        {receipts.map((r) => (
          <label key={`r${r.id}`} className="item">
            <input type="checkbox" checked={chosen.has(`receipt:${r.id}`)} onChange={() => toggle(`receipt:${r.id}`)} />
            <div className="item__main">
              <div>
                {r.merchant} · {CATEGORY_LABEL[r.category]}
              </div>
              <div className="mono item__meta">
                {r.receipt_date}
                {r.source === 'rksv' ? ' · TILL CODE' : ''}
                {r.paid_by === 'company' ? ' · COMPANY CARD' : ''}
                {r.file && (
                  <>
                    {' · '}
                    <a href={receiptFileUrl(r.id)} target="_blank" rel="noreferrer">
                      PICTURE ↗
                    </a>
                  </>
                )}
              </div>
              {r.file_missing && <div className="mono item__error">NEEDS ITS PICTURE</div>}
            </div>
            <div className="item__amount mono">{r.paid_by === 'company' ? <s>{fmtEur(r.gross_cents)}</s> : fmtEur(r.gross_cents)}</div>
            <button type="button" className="rowbtn rowbtn--danger mono" onClick={() => remove('this receipt', () => api.deleteReceipt(r.id))}>
              ×
            </button>
          </label>
        ))}
      </div>

      {all.size > 0 && (
        <div className="claimbar">
          <input className="field__input" placeholder="Title, e.g. Linz workshop (optional)" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
          <div className="claimbar__total mono">{fmtEur(total)}</div>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || chosen.size === 0 || blocked.length > 0 || !online}
            title={blocked[0] ?? (online ? undefined : 'Claims are submitted online')}
            onClick={() =>
              void act(
                () => api.submitClaim({ trip_ids: ids('trip'), mileage_ids: ids('mileage'), receipt_ids: ids('receipt'), title: title || null, client_id: newClientId() }),
                'Claim submitted',
              )
            }
          >
            SUBMIT {chosen.size} AS A CLAIM
          </button>
        </div>
      )}
      {blocked.length > 0 && <div className="lockbar mono">{blocked[0]}</div>}
      {error && <div className="resource__error mono">{error}</div>}
    </div>
  );
}
