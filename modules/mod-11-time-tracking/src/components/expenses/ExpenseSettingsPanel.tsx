import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { COUNTRY_RATE_KINDS, RATE_KINDS, RATE_LABELS, type RateKind } from '../../../shared/expenses';
import type { ExpenseRate, ExpenseSettings } from '../../../shared/expense-types';
import { api, ApiError, type ExpenseSettingsState, type RatesInForce } from '../../api';
import { fmtEur } from '../../format';
import { parseEuro } from './common';

/**
 * The office's settings for expenses (manage): how claims are paid out, how
 * the per diem is counted, when a receipt needs its picture, who hears of a
 * new claim — and the rates. A rate is never edited: a new one is entered
 * from a date, and the history keeps every earlier one.
 */
export function ExpenseSettingsPanel({ onAuthLost }: { onAuthLost: () => void }) {
  const [state, setState] = useState<ExpenseSettingsState | null>(null);
  const [form, setForm] = useState<ExpenseSettings | null>(null);
  const [threshold, setThreshold] = useState('');
  const [inbox, setInbox] = useState('');
  const [rates, setRates] = useState<RatesInForce | null>(null);
  const [history, setHistory] = useState<ExpenseRate[]>([]);
  const [kind, setKind] = useState<RateKind>('per_diem_domestic');
  const [country, setCountry] = useState('');
  const [from, setFrom] = useState('');
  const [amount, setAmount] = useState('');
  const [basis, setBasis] = useState('');
  const [filter, setFilter] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const handle = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof ApiError && err.details.length > 0 ? err.details.map((d) => `${d.field}: ${d.message}`).join(' · ') : err instanceof Error ? err.message : 'Failed');
    },
    [onAuthLost],
  );

  const load = useCallback(async () => {
    try {
      const [s, r, h] = await Promise.all([api.expenseSettings(), api.ratesInForce(), api.expenseRates(kind)]);
      setState(s);
      setForm(s.settings);
      setThreshold(s.settings.file_required_from_cents === null ? '' : (s.settings.file_required_from_cents / 100).toFixed(2).replace('.', ','));
      setInbox(s.settings.notify_on_submit.join(', '));
      setRates(r);
      setHistory(h.rates);
    } catch (err) {
      handle(err);
    }
  }, [kind, handle]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setError('');
    try {
      const cents = threshold.trim() === '' ? null : parseEuro(threshold);
      const next = await api.saveExpenseSettings({
        ...form,
        file_required_from_cents: cents,
        notify_on_submit: inbox
          .split(/[,\s]+/)
          .map((s) => s.trim())
          .filter(Boolean),
      });
      setState(next);
      setForm(next.settings);
      setMessage('Saved');
    } catch (err) {
      handle(err);
    }
  }

  async function addRate(e: FormEvent) {
    e.preventDefault();
    setError('');
    const cents = parseEuro(amount);
    if (cents === null) {
      setError('The amount, e.g. 30,00 or 0,50');
      return;
    }
    try {
      await api.addExpenseRate({ kind, country: COUNTRY_RATE_KINDS.includes(kind) ? country : null, valid_from: from, amount_cents: cents, basis: basis || null });
      setAmount('');
      setBasis('');
      setMessage('Rate added');
      await load();
    } catch (err) {
      handle(err);
    }
  }

  if (!form || !state) return error ? <div className="resource__error mono">{error}</div> : null;
  const countries = (rates?.countries ?? []).filter((c) => c.country.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div>
      <form className="capture" onSubmit={save}>
        <div className="section-title mono">PAYOUT AND RULES</div>
        <div className="capture__row">
          <span className="mono field__label">APPROVED CLAIMS ARE PAID</span>
          {(['payroll', 'invoicing'] as const).map((m) => (
            <button key={m} type="button" className={`toggle mono ${form.payout_mode === m ? 'is-on' : ''}`} onClick={() => setForm({ ...form, payout_mode: m })}>
              {m === 'payroll' ? 'WITH THE SALARY (CSV)' : 'BY TRANSFER (MOD-04)'}
            </button>
          ))}
        </div>
        <div className="capture__row">
          <span className="mono field__label">PER DIEM COUNTED</span>
          {(['24h', 'calendar'] as const).map((m) => (
            <button key={m} type="button" className={`toggle mono ${form.per_diem_mode === m ? 'is-on' : ''}`} onClick={() => setForm({ ...form, per_diem_mode: m })}>
              {m === '24h' ? 'BY 24 HOURS FROM DEPARTURE' : 'BY CALENDAR DAY'}
            </button>
          ))}
        </div>
        <div className="form-grid">
          <label className="field">
            <span className="field__label mono">PICTURE REQUIRED FROM (EMPTY: NEVER)</span>
            <input className="field__input" inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} placeholder="0,00" />
          </label>
          <label className="field">
            <span className="field__label mono">TELL OF NEW CLAIMS (EMAILS)</span>
            <input className="field__input" value={inbox} onChange={(e) => setInbox(e.target.value)} placeholder="office@example.com" />
          </label>
          <label className="field">
            <span className="field__label mono">PS-03 CHANNEL</span>
            <input className="field__input" value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })} />
          </label>
        </div>
        <label className="inline-check">
          <input type="checkbox" checked={form.notify_employee} onChange={(e) => setForm({ ...form, notify_employee: e.target.checked })} />
          Email people when their claim is decided or paid, and when their payout account changes
        </label>
        {!state.notifications && <div className="lockbar mono">NO NOTIFICATION HUB IS CONFIGURED (NOTIFICATION_URL) — NO MAIL GOES OUT</div>}
        <div className="capture__row">
          <button className="btn btn--primary">SAVE</button>
          {state.updated_by && (
            <span className="mono item__meta">
              LAST CHANGED {state.updated_at?.slice(0, 16).replace('T', ' ')} BY {state.updated_by}
            </span>
          )}
        </div>
      </form>

      <div className="section-title mono">RATES IN FORCE TODAY · {rates?.date}</div>
      <div className="table-wrap">
        <table className="table">
          <tbody>
            {rates?.domestic.map((r) => (
              <tr key={r.kind}>
                <td>{r.label}</td>
                <td className="mono table__num">{r.amount_cents === null ? '—' : fmtEur(r.amount_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form className="capture" onSubmit={addRate}>
        <div className="section-title mono">A NEW RATE, FROM A DATE</div>
        <div className="form-grid">
          <label className="field">
            <span className="field__label mono">RATE</span>
            <select className="field__input" value={kind} onChange={(e) => setKind(e.target.value as RateKind)}>
              {RATE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {RATE_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          {COUNTRY_RATE_KINDS.includes(kind) && (
            <label className="field">
              <span className="field__label mono">COUNTRY</span>
              <input className="field__input" list="expense-countries" value={country} onChange={(e) => setCountry(e.target.value)} required />
              <datalist id="expense-countries">
                {rates?.countries.map((c) => <option key={c.country} value={c.country} />)}
              </datalist>
            </label>
          )}
          <label className="field">
            <span className="field__label mono">FROM</span>
            <input className="field__input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
          </label>
          <label className="field">
            <span className="field__label mono">AMOUNT</span>
            <input className="field__input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </label>
          <label className="field">
            <span className="field__label mono">WHERE IT COMES FROM</span>
            <input className="field__input" placeholder="Kollektivvertrag Handel § 12" value={basis} onChange={(e) => setBasis(e.target.value)} maxLength={200} />
          </label>
        </div>
        <button className="btn">ADD RATE</button>
      </form>

      <div className="section-title mono">HISTORY · {RATE_LABELS[kind].toUpperCase()}</div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">FROM</th>
              {COUNTRY_RATE_KINDS.includes(kind) && <th className="mono">COUNTRY</th>}
              <th className="mono table__num">AMOUNT</th>
              <th className="mono">BASIS</th>
              <th className="mono">ENTERED</th>
            </tr>
          </thead>
          <tbody>
            {history.slice(0, 60).map((r) => (
              <tr key={r.id}>
                <td className="mono">{r.valid_from}</td>
                {COUNTRY_RATE_KINDS.includes(kind) && <td>{r.country}</td>}
                <td className="mono table__num">{fmtEur(r.amount_cents)}</td>
                <td className="cell-note">{r.basis}</td>
                <td className="mono">{r.preset ? 'SHIPPED WITH THE LAW' : `${r.actor} · ${r.created_at.slice(0, 10)}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section-title mono">ABROAD · DAY AND NIGHT RATES TODAY</div>
      <input className="field__input" placeholder="Find a country" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div className="table-wrap">
        <table className="table">
          <tbody>
            {countries.map((c) => (
              <tr key={c.country}>
                <td>{c.country}</td>
                <td className="mono table__num">{c.day_cents === null ? '—' : fmtEur(c.day_cents)}</td>
                <td className="mono table__num">{c.night_cents === null ? '—' : fmtEur(c.night_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {message && <div className="lockbar mono">{message}</div>}
      {error && <div className="resource__error mono">{error}</div>}
    </div>
  );
}
