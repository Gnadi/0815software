import { useCallback, useState } from 'react';
import type { FieldError } from '../../shared/types';
import { api, ApiError } from '../api';
import { localDate } from '../format';

/**
 * EXPORTS — the issued invoices of a period for the tax adviser, as a DATEV
 * Buchungsstapel or a BMD NTCS booking import.
 *
 * The account numbers, the DATEV consultant / client number and the BMD tax
 * codes are the admin's, on the Settings screen. An export that needs one
 * that is not configured refuses with the list and a way there.
 */

interface Props {
  onOpenSettings: () => void;
  onAuthLost: () => void;
}

/** Last month by the viewer's own calendar: in UTC, the first night of a month is still in the one before. */
function previousMonth(): { from: string; to: string } {
  const now = new Date();
  return { from: localDate(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: localDate(new Date(now.getFullYear(), now.getMonth(), 0)) };
}

export function ExportView({ onOpenSettings, onAuthLost }: Props) {
  const [range, setRange] = useState(previousMonth);
  const [payments, setPayments] = useState(false);
  const [error, setError] = useState('');
  const [details, setDetails] = useState<FieldError[]>([]);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

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

  async function download(kind: 'datev' | 'bmd') {
    setBusy(true);
    setError('');
    setDetails([]);
    setNotice('');
    try {
      const query = new URLSearchParams({ from: range.from, to: range.to });
      if (kind === 'datev' && payments) query.set('payments', '1');
      const file = await api.exportFile(`/api/exports/${kind}.csv?${query}`);
      const url = URL.createObjectURL(file.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.filename;
      link.click();
      URL.revokeObjectURL(url);
      setNotice(`${file.filename} — ${file.bookings} booking${file.bookings === 1 ? '' : 's'}`);
    } catch (err) {
      handle(err);
    } finally {
      setBusy(false);
    }
  }

  // A refusal naming a setting (datev.* / bmd.*) is fixed on the Settings screen.
  const needsSettings = details.some((d) => d.field.startsWith('datev.') || d.field.startsWith('bmd.'));

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ INV.04 · BOOKKEEPING</div>
          <h1 className="resource__title">Exports</h1>
          <p className="resource__desc">
            Issued invoices of a period as a DATEV Buchungsstapel or a BMD NTCS booking import. Cancellations are
            booked as reversals on the day they happened.
          </p>
        </div>
        <div className="resource__actions">
          <button className="btn btn--ghost" onClick={onOpenSettings}>
            EXPORT SETTINGS →
          </button>
        </div>
      </div>

      {error && (
        <div className="resource__error mono">
          {error}
          {details.length > 0 && (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, textTransform: 'none' }}>
              {details.map((d) => (
                <li key={`${d.field}-${d.message}`}>
                  {d.field}: {d.message}
                </li>
              ))}
            </ul>
          )}
          {needsSettings && (
            <button className="btn btn--ghost" style={{ marginTop: 12 }} onClick={onOpenSettings}>
              OPEN SETTINGS →
            </button>
          )}
        </div>
      )}
      {notice && <div className="resource__desc mono">{notice}</div>}

      <div className="section-title mono">PERIOD</div>
      <div className="receive-bar">
        <label className="field">
          <span className="field__label mono">FROM</span>
          <input className="field__input" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
        </label>
        <label className="field">
          <span className="field__label mono">TO</span>
          <input className="field__input" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
        </label>
        <label className="field">
          <span className="field__label mono">DATEV: ALSO PAYMENTS</span>
          <input type="checkbox" checked={payments} onChange={(e) => setPayments(e.target.checked)} />
        </label>
        <button className="btn btn--primary" disabled={busy} onClick={() => void download('datev')}>
          DATEV ↓
        </button>
        <button className="btn btn--primary" disabled={busy} onClick={() => void download('bmd')}>
          BMD ↓
        </button>
        <span className="receive-bar__hint mono">RUN THE FIRST FILE THROUGH YOUR ADVISER’S IMPORT PREVIEW</span>
      </div>
    </div>
  );
}
