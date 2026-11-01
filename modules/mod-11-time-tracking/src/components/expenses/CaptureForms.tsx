import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { EXPENSE_CATEGORIES, VEHICLES, mileageCents, perDiemLines, tripPeriods, type ExpenseCategory, type PerDiemMode, type Vehicle } from '../../../shared/expenses';
import { parseRksv, rksvVatLines, RksvError, type RksvReceipt } from '../../../shared/rksv';
import type { ExpenseTrip } from '../../../shared/expense-types';
import type { RatesInForce } from '../../api';
import { ApiError } from '../../api';
import { fmtEur } from '../../format';
import { qrFromPhoto, shrinkPhoto } from '../../pwa/image';
import { capture } from '../../pwa/sync';
import { QrScanner } from '../QrScanner';
import { CATEGORY_LABEL, VEHICLE_LABEL, fmtMinutes, parseEuro } from './common';

/**
 * Capturing on the phone: a receipt (its QR code read here, or typed), a
 * trip, a drive. Each goes to the server at once, or waits on the device
 * when there is no connection (src/pwa/sync.ts). The amounts shown are a
 * preview with the rates known to the app; the server prices the item.
 */

export interface Reference {
  mode: PerDiemMode;
  tz: string;
  rates: RatesInForce | null;
}

interface FormProps {
  owner: string;
  reference: Reference;
  openTrips: ExpenseTrip[];
  onSaved: (message: string) => void;
  onAuthLost: () => void;
}

const rate = (r: RatesInForce | null, kind: string) => r?.domestic.find((d) => d.kind === kind)?.amount_cents ?? null;

function useSubmit(onSaved: (m: string) => void, onAuthLost: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = useCallback(
    async (work: () => Promise<{ queued: boolean }>, what: string, reset: () => void) => {
      setBusy(true);
      setError('');
      try {
        const { queued } = await work();
        reset();
        onSaved(queued ? `${what} saved on this device — it is sent when the connection is back` : `${what} saved`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) onAuthLost();
        else if (err instanceof ApiError && err.details.length > 0) setError(err.details.map((d) => d.message).join(' · '));
        else setError(err instanceof Error ? err.message : 'Could not save');
      } finally {
        setBusy(false);
      }
    },
    [onSaved, onAuthLost],
  );
  return { busy, error, setError, run };
}

// ── Receipt ─────────────────────────────────────────────────────────────

export function ReceiptForm({ owner, openTrips, onSaved, onAuthLost }: FormProps) {
  const [scanning, setScanning] = useState(false);
  const [code, setCode] = useState<{ text: string; receipt: RksvReceipt } | null>(null);
  const [special, setSpecial] = useState<1900 | 490 | null>(null);
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [merchant, setMerchant] = useState('');
  const [category, setCategory] = useState<ExpenseCategory>('meals');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState('');
  const [vatRate, setVatRate] = useState('2000');
  const [paidBy, setPaidBy] = useState<'private' | 'company'>('private');
  const [description, setDescription] = useState('');
  const [tripId, setTripId] = useState('');
  const [hint, setHint] = useState('');
  const { busy, error, setError, run } = useSubmit(onSaved, onAuthLost);

  useEffect(() => {
    if (!photo) return;
    const url = URL.createObjectURL(photo);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  const readCode = useCallback((text: string) => {
    setScanning(false);
    try {
      const receipt = parseRksv(text);
      if (receipt.kind !== 'sale') {
        setError(receipt.kind === 'training' ? 'This is a training receipt — not a purchase' : 'This is a cancellation receipt — not a purchase');
        return;
      }
      setCode({ text, receipt });
      setSpecial(null);
      setError('');
      setHint(receipt.signature_failed ? 'The till printed this while its signature device was down — the receipt still counts.' : '');
    } catch (err) {
      setError(err instanceof RksvError ? `The code is not a till receipt: ${err.message}` : 'Could not read the code');
    }
  }, [setError]);

  async function takePhoto(file: File) {
    setError('');
    try {
      const small = await shrinkPhoto(file);
      setPhoto(small);
      if (!code) {
        const text = await qrFromPhoto(file);
        if (text) readCode(text);
        else setHint('No till code found in the photo — type the amount below.');
      }
    } catch {
      setError('Could not read that picture');
    }
  }

  const reset = () => {
    setCode(null);
    setSpecial(null);
    setPhoto(null);
    setPreview(null);
    setMerchant('');
    setAmount('');
    setDescription('');
    setHint('');
  };

  function submit(e: FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = { merchant, category, paid_by: paidBy, description: description || null, trip_id: tripId ? Number(tripId) : null };
    let total: number;
    if (code) {
      if (code.receipt.special_rate_ambiguous && special === null) {
        setError('Say whether the special-rate amount is 4,9 % or 19 %');
        return;
      }
      body.rksv_code = code.text;
      if (special) body.special_rate_bp = special;
      total = code.receipt.total_cents;
    } else {
      const cents = parseEuro(amount);
      if (cents === null || cents <= 0) {
        setError('The amount, e.g. 12,40');
        return;
      }
      total = cents;
      body.receipt_date = date;
      body.gross_cents = cents;
      body.vat_lines = vatRate === '' ? [] : [{ rate_bp: Number(vatRate), gross_cents: cents }];
    }
    void run(() => capture(owner, 'receipt', body, `${merchant} · ${fmtEur(total)}`, photo), 'Receipt', reset);
  }

  return (
    <form className="capture" onSubmit={submit}>
      {scanning && <QrScanner onCode={readCode} onClose={() => setScanning(false)} />}
      <div className="capture__actions">
        <button type="button" className="btn btn--primary" onClick={() => setScanning(true)} disabled={busy}>
          SCAN TILL CODE
        </button>
        <label className="btn">
          PHOTO OF THE RECEIPT
          <input
            type="file"
            accept="image/*,application/pdf"
            capture="environment"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void takePhoto(f);
            }}
          />
        </label>
      </div>
      {preview && photo?.type !== 'application/pdf' && <img className="capture__photo" src={preview} alt="The receipt" />}
      {hint && <div className="lockbar mono">{hint}</div>}
      {code ? (
        <div className="capture__code">
          <div className="mono field__label">FROM THE TILL CODE · {code.receipt.cashbox_id} · NO. {code.receipt.receipt_id}</div>
          <div className="capture__total">{fmtEur(code.receipt.total_cents)}</div>
          <div className="mono">{code.receipt.issued_at.replace('T', ' ')}</div>
          <div className="mono">
            {rksvVatLines(code.receipt, special ?? 1900)
              .map((l) => `${l.rate_bp / 100} %: ${fmtEur(l.gross_cents)}`)
              .join(' · ')}
          </div>
          {code.receipt.special_rate_ambiguous && (
            <div className="capture__row">
              <span className="mono field__label">SPECIAL RATE ON THIS RECEIPT</span>
              {([490, 1900] as const).map((r) => (
                <button key={r} type="button" className={`toggle mono ${special === r ? 'is-on' : ''}`} onClick={() => setSpecial(r)}>
                  {r === 490 ? '4,9 % FOOD' : '19 % JUNGHOLZ/MITTELBERG'}
                </button>
              ))}
            </div>
          )}
          <button type="button" className="rowbtn mono" onClick={() => setCode(null)}>
            TYPE IT INSTEAD
          </button>
        </div>
      ) : (
        <div className="form-grid">
          <label className="field">
            <span className="field__label mono">DATE</span>
            <input className="field__input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </label>
          <label className="field">
            <span className="field__label mono">AMOUNT (GROSS)</span>
            <input className="field__input" inputMode="decimal" placeholder="12,40" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </label>
          <label className="field">
            <span className="field__label mono">VAT</span>
            <select className="field__input" value={vatRate} onChange={(e) => setVatRate(e.target.value)}>
              <option value="2000">20 %</option>
              <option value="1000">10 %</option>
              <option value="1300">13 %</option>
              <option value="0">0 %</option>
              <option value="">Not shown / mixed</option>
            </select>
          </label>
        </div>
      )}
      <div className="form-grid">
        <label className="field">
          <span className="field__label mono">WHERE</span>
          <input className="field__input" placeholder="Gasthaus Zur Post" value={merchant} onChange={(e) => setMerchant(e.target.value)} required maxLength={160} />
        </label>
        <label className="field">
          <span className="field__label mono">WHAT FOR</span>
          <select className="field__input" value={category} onChange={(e) => setCategory(e.target.value as ExpenseCategory)}>
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label mono">TRIP</span>
          <select className="field__input" value={tripId} onChange={(e) => setTripId(e.target.value)}>
            <option value="">—</option>
            {openTrips.map((t) => (
              <option key={t.id} value={t.id}>
                {t.destination} · {t.start_local.slice(0, 10)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label mono">NOTE</span>
          <input className="field__input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />
        </label>
      </div>
      <div className="capture__row">
        <span className="mono field__label">PAID WITH</span>
        <button type="button" className={`toggle mono ${paidBy === 'private' ? 'is-on' : ''}`} onClick={() => setPaidBy('private')}>
          MY OWN MONEY
        </button>
        <button type="button" className={`toggle mono ${paidBy === 'company' ? 'is-on' : ''}`} onClick={() => setPaidBy('company')}>
          COMPANY CARD
        </button>
      </div>
      {error && <div className="resource__error mono">{error}</div>}
      <button className="btn btn--primary capture__save" disabled={busy}>
        {busy ? 'SAVING…' : 'SAVE RECEIPT'}
      </button>
    </form>
  );
}

// ── Trip ────────────────────────────────────────────────────────────────

export function TripForm({ owner, reference, onSaved, onAuthLost }: FormProps) {
  const [purpose, setPurpose] = useState('');
  const [destination, setDestination] = useState('');
  const [country, setCountry] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [borderOut, setBorderOut] = useState('');
  const [borderIn, setBorderIn] = useState('');
  const [meals, setMeals] = useState<number[]>([]);
  const [nights, setNights] = useState(0);
  const { busy, error, setError, run } = useSubmit(onSaved, onAuthLost);

  const periods = useMemo(() => {
    if (!start || !end || end <= start) return [];
    try {
      return tripPeriods({ start, end, border_out: borderOut || null, border_in: borderIn || null, abroad: country !== '' }, reference.mode, reference.tz);
    } catch {
      return [];
    }
  }, [start, end, borderOut, borderIn, country, reference.mode, reference.tz]);
  const foreign = reference.rates?.countries.find((c) => c.country === country) ?? null;
  const lines = perDiemLines(
    periods,
    { domestic_day_cents: rate(reference.rates, 'per_diem_domestic') ?? 0, meal_reduction_cents: rate(reference.rates, 'meal_reduction_domestic') ?? 0, foreign_day_cents: foreign?.day_cents ?? null },
    meals,
  );
  const maxNights = start && end ? Math.max(0, Math.round((Date.parse(end.slice(0, 10)) - Date.parse(start.slice(0, 10))) / 86_400_000)) : 0;
  const nightRate = country ? (foreign?.night_cents ?? 0) : (rate(reference.rates, 'night_domestic') ?? 0);
  const total = lines.reduce((a, l) => a + l.amount_cents, 0) + Math.min(nights, maxNights) * nightRate;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (end <= start) {
      setError('The trip ends before it starts');
      return;
    }
    const body = {
      purpose,
      destination,
      country: country || null,
      start_local: start,
      end_local: end,
      border_out: country ? borderOut || null : null,
      border_in: country ? borderIn || null : null,
      meals: meals.slice(0, periods.length),
      nights_flat: Math.min(nights, maxNights),
    };
    void run(
      () => capture(owner, 'trip', body, `${destination} · ${start.slice(0, 10)}`),
      'Trip',
      () => {
        setPurpose('');
        setDestination('');
        setMeals([]);
        setNights(0);
      },
    );
  }

  return (
    <form className="capture" onSubmit={submit}>
      <div className="form-grid">
        <label className="field">
          <span className="field__label mono">WHY</span>
          <input className="field__input" placeholder="Workshop at the client" value={purpose} onChange={(e) => setPurpose(e.target.value)} required maxLength={200} />
        </label>
        <label className="field">
          <span className="field__label mono">WHERE TO</span>
          <input className="field__input" placeholder="Linz" value={destination} onChange={(e) => setDestination(e.target.value)} required maxLength={160} />
        </label>
        <label className="field">
          <span className="field__label mono">COUNTRY</span>
          <select className="field__input" value={country} onChange={(e) => setCountry(e.target.value)}>
            <option value="">Austria</option>
            {reference.rates?.countries.map((c) => (
              <option key={c.country} value={c.country}>
                {c.country}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label mono">LEFT</span>
          <input className="field__input" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} required />
        </label>
        <label className="field">
          <span className="field__label mono">BACK</span>
          <input className="field__input" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} required />
        </label>
        {country && (
          <>
            <label className="field">
              <span className="field__label mono">ACROSS THE BORDER</span>
              <input className="field__input" type="datetime-local" value={borderOut} onChange={(e) => setBorderOut(e.target.value)} />
            </label>
            <label className="field">
              <span className="field__label mono">BACK ACROSS</span>
              <input className="field__input" type="datetime-local" value={borderIn} onChange={(e) => setBorderIn(e.target.value)} />
            </label>
          </>
        )}
        <label className="field">
          <span className="field__label mono">NIGHTS WITHOUT A HOTEL BILL</span>
          <input className="field__input" type="number" min={0} max={maxNights} value={nights} onChange={(e) => setNights(Math.max(0, Number(e.target.value)))} />
        </label>
      </div>
      {periods.length > 0 && (
        <div className="itemlist">
          {lines.map((l) => (
            <div key={l.index} className="item">
              <div className="item__main">
                <div>
                  Period {l.index + 1}
                  {l.abroad ? ` · ${country}` : ''}
                </div>
                <div className="mono item__meta">
                  {fmtMinutes(l.minutes)} AWAY · {l.twelfths}/12
                  {l.reduction_cents ? ` · −${fmtEur(l.reduction_cents)} FOR MEALS` : ''}
                </div>
              </div>
              {!l.abroad && (
                <select
                  className="field__input item__select"
                  aria-label={`Paid meals in period ${l.index + 1}`}
                  value={meals[l.index] ?? 0}
                  onChange={(e) => {
                    const next = [...meals];
                    while (next.length <= l.index) next.push(0);
                    next[l.index] = Number(e.target.value);
                    setMeals(next);
                  }}
                >
                  <option value={0}>no paid meal</option>
                  <option value={1}>1 paid meal</option>
                  <option value={2}>2 paid meals</option>
                </select>
              )}
              <div className="item__amount mono">{fmtEur(l.amount_cents)}</div>
            </div>
          ))}
          <div className="capture__sum mono">ABOUT {fmtEur(total)} — THE SERVER PRICES IT WITH THE RATES IN FORCE ON THE DAY</div>
        </div>
      )}
      {error && <div className="resource__error mono">{error}</div>}
      <button className="btn btn--primary capture__save" disabled={busy}>
        {busy ? 'SAVING…' : 'SAVE TRIP'}
      </button>
    </form>
  );
}

// ── Drive ───────────────────────────────────────────────────────────────

export function DriveForm({ owner, reference, openTrips, onSaved, onAuthLost }: FormProps) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [purpose, setPurpose] = useState('');
  const [km, setKm] = useState('');
  const [vehicle, setVehicle] = useState<Vehicle>('car');
  const [passengers, setPassengers] = useState(0);
  const [tripId, setTripId] = useState('');
  const { busy, error, setError, run } = useSubmit(onSaved, onAuthLost);
  const tenths = Math.round(Number(km.replace(',', '.')) * 10);
  const kind = vehicle === 'car' ? 'mileage_car' : vehicle === 'motorbike' ? 'mileage_motorbike' : 'mileage_bicycle';
  const preview = Number.isFinite(tenths) && tenths > 0 ? mileageCents(tenths, vehicle, passengers, { vehicle_cents: rate(reference.rates, kind) ?? 0, passenger_cents: rate(reference.rates, 'mileage_passenger') ?? 0 }) : null;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!Number.isFinite(tenths) || tenths <= 0) {
      setError('The distance in kilometres, e.g. 185,4');
      return;
    }
    const body = { travel_date: date, from_place: from, to_place: to, purpose, km_tenths: tenths, vehicle, passengers: vehicle === 'car' ? passengers : 0, trip_id: tripId ? Number(tripId) : null };
    void run(
      () => capture(owner, 'mileage', body, `${from} – ${to} · ${km} km`),
      'Drive',
      () => {
        setFrom('');
        setTo('');
        setKm('');
        setPassengers(0);
      },
    );
  }

  return (
    <form className="capture" onSubmit={submit}>
      <div className="form-grid">
        <label className="field">
          <span className="field__label mono">DATE</span>
          <input className="field__input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </label>
        <label className="field">
          <span className="field__label mono">FROM</span>
          <input className="field__input" value={from} onChange={(e) => setFrom(e.target.value)} required maxLength={160} />
        </label>
        <label className="field">
          <span className="field__label mono">TO</span>
          <input className="field__input" value={to} onChange={(e) => setTo(e.target.value)} required maxLength={160} />
        </label>
        <label className="field">
          <span className="field__label mono">WHY</span>
          <input className="field__input" value={purpose} onChange={(e) => setPurpose(e.target.value)} required maxLength={200} />
        </label>
        <label className="field">
          <span className="field__label mono">KILOMETRES</span>
          <input className="field__input" inputMode="decimal" placeholder="185,4" value={km} onChange={(e) => setKm(e.target.value)} required />
        </label>
        <label className="field">
          <span className="field__label mono">WITH</span>
          <select className="field__input" value={vehicle} onChange={(e) => setVehicle(e.target.value as Vehicle)}>
            {VEHICLES.map((v) => (
              <option key={v} value={v}>
                {VEHICLE_LABEL[v]}
              </option>
            ))}
          </select>
        </label>
        {vehicle === 'car' && (
          <label className="field">
            <span className="field__label mono">COLLEAGUES ALONG</span>
            <input className="field__input" type="number" min={0} max={8} value={passengers} onChange={(e) => setPassengers(Math.max(0, Math.min(8, Number(e.target.value))))} />
          </label>
        )}
        <label className="field">
          <span className="field__label mono">TRIP</span>
          <select className="field__input" value={tripId} onChange={(e) => setTripId(e.target.value)}>
            <option value="">—</option>
            {openTrips.map((t) => (
              <option key={t.id} value={t.id}>
                {t.destination} · {t.start_local.slice(0, 10)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {preview !== null && <div className="capture__sum mono">ABOUT {fmtEur(preview)}</div>}
      {error && <div className="resource__error mono">{error}</div>}
      <button className="btn btn--primary capture__save" disabled={busy}>
        {busy ? 'SAVING…' : 'SAVE DRIVE'}
      </button>
    </form>
  );
}
