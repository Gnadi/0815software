import { useCallback, useEffect, useState } from 'react';
import type { EInvoiceProblem, EInvoiceProfile, SellerParty } from '../../shared/einvoice';
import type { FieldError } from '../../shared/types';
import { api, ApiError, type AccountingSettings, type AccountingSettingsResponse } from '../api';

/**
 * EXPORTS — the invoices of a period for the tax adviser (DATEV, BMD), and
 * the seller's own readiness for e-invoicing.
 *
 * Account numbers are the adviser's, not this module's: the settings below
 * start from the usual standard accounts and every export refuses, with the
 * list, when the period needs something that is not configured.
 */

interface Props {
  onAuthLost: () => void;
}

function previousMonth(): { from: string; to: string } {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

const num = (raw: string): number | null => (raw.trim() === '' ? null : Number(raw));
const str = (value: number | null | undefined): string => (value === null || value === undefined ? '' : String(value));

/** Where each seller field comes from, for the "what to set" hint. */
const SELLER_ENV: Record<string, string> = {
  SELLER_NAME: 'SELLER_NAME',
  SELLER_STREET: 'SELLER_STREET (or the first line of SELLER_ADDRESS)',
  SELLER_POSTCODE: 'SELLER_POSTCODE (or "PLZ Ort" in SELLER_ADDRESS)',
  SELLER_CITY: 'SELLER_CITY (or "PLZ Ort" in SELLER_ADDRESS)',
  SELLER_COUNTRY: 'SELLER_COUNTRY',
};

export function ExportView({ onAuthLost }: Props) {
  const [range, setRange] = useState(previousMonth);
  const [payments, setPayments] = useState(false);
  const [config, setConfig] = useState<AccountingSettingsResponse | null>(null);
  const [settings, setSettings] = useState<AccountingSettings | null>(null);
  const [seller, setSeller] = useState<{ seller: SellerParty; problems: Record<EInvoiceProfile, EInvoiceProblem[]> } | null>(null);
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

  const load = useCallback(async () => {
    try {
      const [accounting, einvoice] = await Promise.all([api.accountingSettings(), api.einvoiceConfig()]);
      setConfig(accounting);
      setSettings(accounting.settings);
      setSeller(einvoice);
    } catch (err) {
      handle(err);
    }
  }, [handle]);

  useEffect(() => {
    void load();
  }, [load]);

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

  async function save() {
    if (!settings) return;
    setBusy(true);
    setError('');
    setDetails([]);
    setNotice('');
    try {
      const saved = await api.saveAccountingSettings(settings);
      setSettings(saved.settings);
      setNotice('Settings saved.');
    } catch (err) {
      handle(err);
    } finally {
      setBusy(false);
    }
  }

  if (!config || !settings || !seller) {
    return error ? <div className="resource__error mono">{error}</div> : <div className="boot mono">LOADING…</div>;
  }

  const datev = settings.datev;
  const bmd = settings.bmd;
  const setDatev = (patch: Partial<AccountingSettings['datev']>) => setSettings({ ...settings, datev: { ...datev, ...patch } });
  const setBmd = (patch: Partial<AccountingSettings['bmd']>) => setSettings({ ...settings, bmd: { ...bmd, ...patch } });
  const applySuggestions = (chart: 'SKR03' | 'SKR04') => {
    const revenue = { ...datev.revenue };
    for (const [key, account] of Object.entries(config.suggested[chart])) {
      revenue[key] = { ...revenue[key], account };
    }
    setDatev({ chart, revenue });
  };

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ INV.04 · BOOKKEEPING</div>
          <h1 className="resource__title">Exports</h1>
          <p className="resource__desc">
            Issued invoices of a period as a DATEV Buchungsstapel or a BMD NTCS booking import — and whether your own
            data is complete for XRechnung and ZUGFeRD.
          </p>
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

      <div className="section-title mono">DATEV</div>
      <div className="editor__meta">
        <label className="field">
          <span className="field__label mono">BERATERNUMMER</span>
          <input className="field__input" value={str(datev.consultant_number)} onChange={(e) => setDatev({ consultant_number: num(e.target.value) })} />
        </label>
        <label className="field">
          <span className="field__label mono">MANDANTENNUMMER</span>
          <input className="field__input" value={str(datev.client_number)} onChange={(e) => setDatev({ client_number: num(e.target.value) })} />
        </label>
        <label className="field">
          <span className="field__label mono">KONTENRAHMEN</span>
          <select className="field__input" value={datev.chart} onChange={(e) => applySuggestions(e.target.value as 'SKR03' | 'SKR04')}>
            <option value="SKR03">SKR03</option>
            <option value="SKR04">SKR04</option>
          </select>
        </label>
        <label className="field">
          <span className="field__label mono">SACHKONTENLÄNGE</span>
          <input className="field__input" value={str(datev.account_length)} onChange={(e) => setDatev({ account_length: num(e.target.value) ?? 4 })} />
        </label>
        <label className="field">
          <span className="field__label mono">WJ-BEGINN (MM-DD)</span>
          <input className="field__input" value={datev.fiscal_year_start} onChange={(e) => setDatev({ fiscal_year_start: e.target.value })} />
        </label>
        <label className="field">
          <span className="field__label mono">ERSTES DEBITORENKONTO</span>
          <input className="field__input" value={str(datev.debtor_start)} onChange={(e) => setDatev({ debtor_start: num(e.target.value) ?? 10000 })} />
        </label>
        <label className="field">
          <span className="field__label mono">BANKKONTO (ZAHLUNGEN)</span>
          <input className="field__input" value={str(datev.bank_account)} onChange={(e) => setDatev({ bank_account: num(e.target.value) })} />
        </label>
        <label className="field">
          <span className="field__label mono">FESTSCHREIBUNG</span>
          <input type="checkbox" checked={datev.lock} onChange={(e) => setDatev({ lock: e.target.checked })} />
        </label>
      </div>
      <AccountTable
        keys={config.revenue_keys}
        labels={config.revenue_labels}
        revenue={datev.revenue}
        extra={{ field: 'bu_key', label: 'BU-SCHLÜSSEL (NUR OHNE AUTOMATIK)' }}
        onChange={(revenue) => setDatev({ revenue })}
      />

      <div className="section-title mono">BMD NTCS</div>
      <div className="editor__meta">
        <label className="field">
          <span className="field__label mono">ERSTES DEBITORENKONTO</span>
          <input className="field__input" value={str(bmd.debtor_start)} onChange={(e) => setBmd({ debtor_start: num(e.target.value) ?? 200000 })} />
        </label>
        <label className="field">
          <span className="field__label mono">BUCHUNGSSYMBOL</span>
          <input className="field__input" value={bmd.symbol} onChange={(e) => setBmd({ symbol: e.target.value.toUpperCase() })} />
        </label>
        <label className="field">
          <span className="field__label mono">DATUMSFORMAT</span>
          <select className="field__input" value={bmd.date_format} onChange={(e) => setBmd({ date_format: e.target.value as 'dd.mm.yyyy' | 'yyyymmdd' })}>
            <option value="dd.mm.yyyy">TT.MM.JJJJ</option>
            <option value="yyyymmdd">JJJJMMTT</option>
          </select>
        </label>
      </div>
      <AccountTable
        keys={config.revenue_keys}
        labels={config.revenue_labels}
        revenue={bmd.revenue}
        extra={{ field: 'tax_code', label: 'STEUERCODE' }}
        onChange={(revenue) => setBmd({ revenue })}
      />

      <div className="editor__actions">
        <button className="btn btn--primary" disabled={busy} onClick={() => void save()}>
          SAVE SETTINGS →
        </button>
      </div>

      <div className="section-title mono">E-INVOICING · YOUR OWN DATA</div>
      <SellerCheck seller={seller.seller} problems={seller.problems} />
    </div>
  );
}

function AccountTable({
  keys,
  labels,
  revenue,
  extra,
  onChange,
}: {
  keys: string[];
  labels: Record<string, string>;
  revenue: AccountingSettings['datev']['revenue'];
  extra: { field: 'bu_key' | 'tax_code'; label: string };
  onChange: (revenue: AccountingSettings['datev']['revenue']) => void;
}) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th className="mono">REVENUE</th>
            <th className="mono">ERLÖSKONTO</th>
            <th className="mono">{extra.label}</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => {
            const row = revenue[key] ?? { account: null };
            return (
              <tr key={key}>
                <td className="mono">{labels[key]}</td>
                <td>
                  <input
                    className="field__input"
                    value={str(row.account)}
                    onChange={(e) => onChange({ ...revenue, [key]: { ...row, account: num(e.target.value) } })}
                  />
                </td>
                <td>
                  <input
                    className="field__input"
                    value={row[extra.field] ?? ''}
                    onChange={(e) => onChange({ ...revenue, [key]: { ...row, [extra.field]: e.target.value || null } })}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SellerCheck({ seller, problems }: { seller: SellerParty; problems: Record<EInvoiceProfile, EInvoiceProblem[]> }) {
  const rows: [string, string | null][] = [
    ['NAME', seller.name],
    ['STREET', seller.street],
    ['POSTCODE · CITY', [seller.postcode, seller.city].filter(Boolean).join(' ') || null],
    ['COUNTRY', seller.country],
    ['VAT ID', seller.vat_id],
    ['STEUERNUMMER', seller.tax_number],
    ['CONTACT', [seller.contact_name, seller.phone, seller.email].filter(Boolean).join(' · ') || null],
    ['E-INVOICE ADDRESS', seller.einvoice_address ?? seller.email],
  ];
  return (
    <div className="totals">
      {rows.map(([label, value]) => (
        <div key={label} className="totals__row mono">
          <span>{label}</span>
          <span>{value ?? '—'}</span>
        </div>
      ))}
      {(['xrechnung', 'zugferd'] as const).map((profile) => (
        <div key={profile} className="totals__row mono" style={{ alignItems: 'flex-start' }}>
          <span>{profile === 'xrechnung' ? 'XRECHNUNG' : 'ZUGFERD EN 16931'}</span>
          <span style={{ textAlign: 'right', textTransform: 'none' }}>
            {problems[profile].length === 0
              ? 'READY'
              : problems[profile].map((p) => (
                  <div key={p.term + p.field}>
                    {p.term}: set {SELLER_ENV[p.field] ?? p.field}
                  </div>
                ))}
          </span>
        </div>
      ))}
    </div>
  );
}
