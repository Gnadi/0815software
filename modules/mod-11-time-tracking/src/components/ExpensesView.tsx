import { useCallback, useEffect, useState } from 'react';
import type { ExpenseMileage, ExpenseReceipt, ExpenseTrip } from '../../shared/expense-types';
import { api, ApiError, timer } from '../api';
import { useCan } from '../access';
import { listOutbox, type OutboxItem } from '../pwa/outbox';
import { flush } from '../pwa/sync';
import { BankAccountPanel } from './expenses/BankAccountPanel';
import { DriveForm, ReceiptForm, TripForm, type Reference } from './expenses/CaptureForms';
import { ClaimsPanel } from './expenses/ClaimsPanel';
import { ExpenseSettingsPanel } from './expenses/ExpenseSettingsPanel';
import { ItemsPanel } from './expenses/ItemsPanel';

/**
 * Expenses: capture on the way (also offline), claim, and — for the office —
 * decide and pay. Server-side rules: server/expenses.ts.
 *
 * What the app needs to work without a connection is kept on the device:
 * the rates and the per diem mode (no one's data — the law and the office's
 * settings), and the captures waiting to be sent (src/pwa/outbox.ts).
 */

type Tab = 'capture' | 'open' | 'claims' | 'office' | 'settings' | 'account';
type Capture = 'receipt' | 'trip' | 'drive';

const REFERENCE_KEY = 'mod11.reference';

function cachedReference(): Reference {
  try {
    const raw = localStorage.getItem(REFERENCE_KEY);
    if (raw) return JSON.parse(raw) as Reference;
  } catch {
    /* nothing cached yet */
  }
  return { mode: '24h', tz: 'Europe/Vienna', rates: null };
}

interface Props {
  username: string;
  ownEmployeeId: number | null;
  onAuthLost: () => void;
}

export function ExpensesView({ username, ownEmployeeId, onAuthLost }: Props) {
  const canManage = useCan('manage');
  const canEdit = useCan('edit');
  const [tab, setTab] = useState<Tab>(canEdit && ownEmployeeId !== null ? 'capture' : canManage ? 'office' : 'claims');
  const [kind, setKind] = useState<Capture>('receipt');
  const [reference, setReference] = useState<Reference>(cachedReference);
  const [online, setOnline] = useState(navigator.onLine);
  const [waiting, setWaiting] = useState<OutboxItem[]>([]);
  const [trips, setTrips] = useState<ExpenseTrip[]>([]);
  const [mileage, setMileage] = useState<ExpenseMileage[]>([]);
  const [receipts, setReceipts] = useState<ExpenseReceipt[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const handle = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else if (!(err instanceof TypeError)) setError(err instanceof Error ? err.message : 'Failed');
    },
    [onAuthLost],
  );

  const loadItems = useCallback(async () => {
    setWaiting(await listOutbox(username).catch(() => []));
    if (ownEmployeeId === null || !navigator.onLine) return;
    try {
      const q = { employee_id: ownEmployeeId, open: true };
      const [t, m, r] = await Promise.all([api.trips(q), api.mileage(q), api.receipts(q)]);
      setTrips(t.trips);
      setMileage(m.mileage);
      setReceipts(r.receipts);
      setError('');
    } catch (err) {
      handle(err);
    }
  }, [username, ownEmployeeId, handle]);

  const loadReference = useCallback(async () => {
    try {
      const [settings, clock, rates] = await Promise.all([api.expenseSettings(), timer.settings(), api.ratesInForce()]);
      const next: Reference = { mode: settings.settings.per_diem_mode, tz: clock.settings.timezone, rates };
      setReference(next);
      localStorage.setItem(REFERENCE_KEY, JSON.stringify(next));
    } catch (err) {
      handle(err);
    }
  }, [handle]);

  const sendWaiting = useCallback(async () => {
    const result = await flush(username);
    if (result.stopped === 'signed-out') onAuthLost();
    if (result.sent > 0) setMessage(`${result.sent} capture(s) from this device sent`);
    await loadItems();
  }, [username, onAuthLost, loadItems]);

  useEffect(() => {
    void loadReference();
    void sendWaiting();
    const up = () => {
      setOnline(true);
      void sendWaiting();
    };
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, [loadReference, sendWaiting]);

  // A capture that waits is tried again every minute while the app is open.
  useEffect(() => {
    if (waiting.length === 0) return;
    const t = window.setInterval(() => void sendWaiting(), 60_000);
    return () => window.clearInterval(t);
  }, [waiting.length, sendWaiting]);

  const saved = useCallback(
    (m?: string) => {
      if (m) setMessage(m);
      void loadItems();
    },
    [loadItems],
  );

  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: 'capture', label: 'Capture', show: canEdit && ownEmployeeId !== null },
    { id: 'open', label: `Open${waiting.length ? ` · ${waiting.length} waiting` : ''}`, show: ownEmployeeId !== null },
    { id: 'claims', label: 'My claims', show: ownEmployeeId !== null },
    { id: 'office', label: 'Decide & pay', show: canManage },
    { id: 'settings', label: 'Settings & rates', show: canManage },
    { id: 'account', label: 'Bank account', show: canEdit && ownEmployeeId !== null },
  ];
  const formProps = { owner: username, reference, openTrips: trips, onSaved: saved, onAuthLost };

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ T.11 · EXPENSES</div>
          <h1 className="resource__title">Expenses</h1>
          <p className="resource__desc">Trips, mileage and receipts — captured on the way, also offline; per diem and mileage under Austrian law.</p>
        </div>
      </div>

      {!online && <div className="lockbar mono">OFFLINE — CAPTURES ARE KEPT ON THIS DEVICE AND SENT WHEN THE CONNECTION IS BACK</div>}
      {ownEmployeeId === null && !canManage && <div className="resource__error mono">No employee record carries {username} — ask a manager to add your email to it.</div>}

      <div className="tabs">
        {tabs
          .filter((t) => t.show)
          .map((t) => (
            <button key={t.id} type="button" className={`tab mono ${tab === t.id ? 'is-active' : ''}`} onClick={() => setTab(t.id)}>
              {t.label.toUpperCase()}
            </button>
          ))}
      </div>

      {message && (
        <div className="lockbar mono" onClick={() => setMessage('')}>
          {message}
        </div>
      )}
      {error && <div className="resource__error mono">{error}</div>}

      {tab === 'capture' && (
        <>
          <div className="segmented">
            {(['receipt', 'trip', 'drive'] as const).map((k) => (
              <button key={k} type="button" className={`toggle mono ${kind === k ? 'is-on' : ''}`} onClick={() => setKind(k)}>
                {k === 'receipt' ? 'RECEIPT' : k === 'trip' ? 'TRIP (PER DIEM)' : 'DRIVE (MILEAGE)'}
              </button>
            ))}
          </div>
          {kind === 'receipt' && <ReceiptForm {...formProps} />}
          {kind === 'trip' && <TripForm {...formProps} />}
          {kind === 'drive' && <DriveForm {...formProps} />}
        </>
      )}
      {tab === 'open' && (
        <ItemsPanel trips={trips} mileage={mileage} receipts={receipts} waiting={waiting} online={online} onChanged={saved} onSendNow={() => void sendWaiting()} onAuthLost={onAuthLost} />
      )}
      {tab === 'claims' && <ClaimsPanel scope="mine" onAuthLost={onAuthLost} />}
      {tab === 'office' && <ClaimsPanel scope="office" onAuthLost={onAuthLost} />}
      {tab === 'settings' && <ExpenseSettingsPanel onAuthLost={onAuthLost} />}
      {tab === 'account' && <BankAccountPanel onAuthLost={onAuthLost} />}
    </div>
  );
}
