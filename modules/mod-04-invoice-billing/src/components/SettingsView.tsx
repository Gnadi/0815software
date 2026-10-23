import { useCallback, useEffect, useState } from 'react';
import type { FieldError } from '../../shared/types';
import {
  api,
  ApiError,
  type AccountingSettings,
  type AccountingSettingsResponse,
  type SellerFieldState,
  type SellerSettingsResponse,
} from '../api';
import { Can, useCan } from '../access';
import { fmtDate } from '../format';

/**
 * SETTINGS — what someone with `manage` maintains: this company as seller (letterhead,
 * bank account, and the fields an e-invoice needs), and the DATEV / BMD
 * export settings the tax adviser provides.
 *
 * Seller fields show where their current value comes from. Saving a field
 * overrides the SELLER_* environment (and PS-11 for the fields it does not
 * manage); clearing it falls back again. Issued invoices never change — they
 * carry the seller frozen at issue.
 *
 * Everyone with a level here may READ the settings; changing them needs
 * `manage` (server/access.ts). Below that the screen shows the same fields,
 * disabled, so a person can still see which numbers the export uses.
 */

interface Props {
  onAuthLost: () => void;
}

const SELLER_LABELS: Record<string, { label: string; hint?: string; multiline?: boolean }> = {
  name: { label: 'COMPANY NAME' },
  addressLines: { label: 'ADDRESS (PRINTED)', hint: 'one line per line: street, PLZ Ort, country', multiline: true },
  street: { label: 'STREET', hint: 'empty → read from the address' },
  postcode: { label: 'POSTCODE', hint: 'empty → read from the address' },
  city: { label: 'CITY', hint: 'empty → read from the address' },
  country: { label: 'COUNTRY (ISO)', hint: 'DE or AT — empty → from the address / VAT id' },
  vatId: { label: 'VAT ID (BT-31)' },
  taxNumber: { label: 'STEUERNUMMER (BT-32)' },
  registration: { label: 'REGISTER NUMBER (BT-30)', hint: 'HRB 12345 / FN 123456a — needed without a VAT id' },
  identifier: { label: 'SELLER IDENTIFIER (BT-29)', hint: 'scheme:id, e.g. 0088:4000001000005 for a GLN — identifies you without VAT id or register number' },
  iban: { label: 'IBAN', hint: 'printed on invoices and the debtor of every payment file' },
  bic: { label: 'BIC' },
  contactName: { label: 'CONTACT PERSON (BT-41)', hint: 'required for XRechnung' },
  phone: { label: 'CONTACT PHONE (BT-42)', hint: 'required for XRechnung' },
  email: { label: 'CONTACT EMAIL (BT-43)', hint: 'required for XRechnung' },
  einvoiceAddress: { label: 'E-INVOICE ADDRESS (BT-34)', hint: 'email, Leitweg-ID or Peppol ID like 0088:4000001000005 — empty → contact email' },
};

const SOURCE_LABEL: Record<SellerFieldState['source'], string> = {
  settings: 'SET HERE',
  platform: 'FROM PS-11',
  env: 'FROM ENV',
  unset: 'NOT SET',
};

const num = (raw: string): number | null => (raw.trim() === '' ? null : Number(raw));
const str = (value: number | null | undefined): string => (value === null || value === undefined ? '' : String(value));

function stamp(at: string | null, by: string | null): string {
  return at ? `Last saved ${fmtDate(at)}${by ? ` by ${by}` : ''}` : 'Never saved — the suggested defaults apply';
}

export function SettingsView({ onAuthLost }: Props) {
  const [seller, setSeller] = useState<SellerSettingsResponse | null>(null);
  const [sellerForm, setSellerForm] = useState<Record<string, string>>({});
  const [config, setConfig] = useState<AccountingSettingsResponse | null>(null);
  const [settings, setSettings] = useState<AccountingSettings | null>(null);
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

  const showSeller = (response: SellerSettingsResponse) => {
    setSeller(response);
    setSellerForm(Object.fromEntries(response.fields.map((f) => [f.key, f.setting ?? ''])));
  };

  const load = useCallback(async () => {
    try {
      const [sellerSettings, accounting] = await Promise.all([api.sellerSettings(), api.accountingSettings()]);
      showSeller(sellerSettings);
      setConfig(accounting);
      setSettings(accounting.settings);
    } catch (err) {
      handle(err);
    }
  }, [handle]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(what: 'seller' | 'accounting') {
    setBusy(true);
    setError('');
    setDetails([]);
    setNotice('');
    try {
      if (what === 'seller') {
        const editable = Object.fromEntries(
          Object.entries(sellerForm).filter(([key]) => !seller?.fields.find((f) => f.key === key)?.locked),
        );
        showSeller(await api.saveSellerSettings(editable));
        setNotice('Seller saved. Invoices issued before keep the seller they were issued with.');
      } else if (settings) {
        const saved = await api.saveAccountingSettings(settings);
        setSettings(saved.settings);
        setConfig((c) => (c ? { ...c, settings: saved.settings, updated_at: saved.updated_at, updated_by: saved.updated_by } : c));
        setNotice('Export settings saved.');
      }
    } catch (err) {
      handle(err);
    } finally {
      setBusy(false);
    }
  }

  if (!seller || !config || !settings) {
    return error ? <div className="resource__error mono">{error}</div> : <div className="boot mono">LOADING…</div>;
  }

  const datev = settings.datev;
  const bmd = settings.bmd;
  const setDatev = (patch: Partial<AccountingSettings['datev']>) => setSettings({ ...settings, datev: { ...datev, ...patch } });
  const setBmd = (patch: Partial<AccountingSettings['bmd']>) => setSettings({ ...settings, bmd: { ...bmd, ...patch } });
  const applySuggestions = (chart: 'SKR03' | 'SKR04') => {
    const revenue = { ...datev.revenue };
    for (const [key, account] of Object.entries(config.suggested[chart])) revenue[key] = { ...revenue[key], account };
    setDatev({ chart, revenue });
  };

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ INV.05 · ADMINISTRATION</div>
          <h1 className="resource__title">Settings</h1>
          <p className="resource__desc">
            Your company as it appears on invoices and e-invoices, and the account settings your tax adviser gives
            you for DATEV and BMD.
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
                  {SELLER_LABELS[d.field]?.label ?? d.field}: {d.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {notice && <div className="resource__desc mono">{notice}</div>}
      {!canManage && (
        <div className="resource__desc mono">
          READ-ONLY — changing the seller or the export settings needs the MANAGE level in this module.
        </div>
      )}

      <fieldset disabled={!canManage} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      {/* ── Seller ── */}
      <div className="section-title mono">SELLER · LETTERHEAD AND E-INVOICE</div>
      <p className="resource__desc mono">
        {stamp(seller.updated_at, seller.updated_by)}
        {seller.platform_managed && ' · Name, address, VAT id, IBAN and BIC are managed in PS-11 Customers'}
      </p>
      <div className="editor__meta">
        {seller.fields.map((f) => {
          const meta = SELLER_LABELS[f.key] ?? { label: f.key };
          const placeholder = f.locked
            ? (f.value ?? '')
            : f.source === 'settings'
              ? ''
              : (f.value ?? meta.hint ?? '');
          return (
            <label key={f.key} className={`field ${meta.multiline ? 'editor__note' : ''}`}>
              <span className="field__label mono">
                {meta.label} · <span className="table__id">{f.locked ? 'PS-11' : SOURCE_LABEL[f.source]}</span>
              </span>
              {meta.multiline ? (
                <textarea
                  className="field__input"
                  rows={3}
                  disabled={f.locked}
                  value={f.locked ? (f.value ?? '') : (sellerForm[f.key] ?? '')}
                  placeholder={placeholder}
                  title={`Empty → ${f.env}`}
                  onChange={(e) => setSellerForm({ ...sellerForm, [f.key]: e.target.value })}
                />
              ) : (
                <input
                  className="field__input"
                  disabled={f.locked}
                  value={f.locked ? (f.value ?? '') : (sellerForm[f.key] ?? '')}
                  placeholder={placeholder}
                  title={`Empty → ${f.env}`}
                  onChange={(e) => setSellerForm({ ...sellerForm, [f.key]: e.target.value })}
                />
              )}
            </label>
          );
        })}
      </div>
      <div className="totals">
        {(['xrechnung', 'zugferd', 'ebinterface'] as const).map((profile) => (
          <div key={profile} className="totals__row mono" style={{ alignItems: 'flex-start' }}>
            <span>{{ xrechnung: 'XRECHNUNG', zugferd: 'ZUGFERD EN 16931', ebinterface: 'EBINTERFACE 6.1' }[profile]}</span>
            <span style={{ textAlign: 'right', textTransform: 'none' }}>
              {seller.problems[profile].length === 0
                ? 'READY'
                : seller.problems[profile].map((p) => <div key={p.term + p.field}>{p.term}: {p.message}</div>)}
            </span>
          </div>
        ))}
      </div>
      <Can level="manage">
        <div className="editor__actions">
          <button className="btn btn--primary" disabled={busy} onClick={() => void save('seller')}>
            SAVE SELLER →
          </button>
        </div>
      </Can>

      {/* ── DATEV ── */}
      <div className="section-title mono">DATEV</div>
      <p className="resource__desc mono">{stamp(config.updated_at, config.updated_by)}</p>
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

      {/* ── BMD ── */}
      <div className="section-title mono">BMD NTCS</div>
      <p className="resource__desc mono">
        Steuercodes come from your client&rsquo;s NTCS tax code table — ask your adviser. Groups without an account and a
        code make the export refuse rather than guess.
      </p>
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
      <Can level="manage">
        <div className="editor__actions">
          <button className="btn btn--primary" disabled={busy} onClick={() => void save('accounting')}>
            SAVE EXPORT SETTINGS →
          </button>
        </div>
      </Can>
      </fieldset>
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
