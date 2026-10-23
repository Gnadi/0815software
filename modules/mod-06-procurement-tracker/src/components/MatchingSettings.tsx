import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type MatchingSettingsResponse } from '../api';
import { Can, useCan } from '../access';
import { fmtEur } from '../format';

/**
 * The three-way match rules and the receiving warehouse — the office's
 * (`manage`), shown to everyone so a held invoice can be explained.
 */
export function MatchingSettingsView({ onAuthLost }: { onAuthLost: () => void }) {
  const [data, setData] = useState<MatchingSettingsResponse | null>(null);
  const [percent, setPercent] = useState('');
  const [cap, setCap] = useState('');
  const [warehouse, setWarehouse] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const canManage = useCan('manage');

  const handle = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof ApiError && err.details.length > 0 ? `${err.message}: ${err.details.map((d) => d.message).join(' · ')}` : err instanceof Error ? err.message : 'Request failed');
    },
    [onAuthLost],
  );

  const load = useCallback(async () => {
    try {
      const d = await api.matchingSettings();
      setData(d);
      setPercent(String(d.settings.tolerance_percent).replace('.', ','));
      setCap((d.settings.tolerance_cap_cents / 100).toFixed(2).replace('.', ','));
      setWarehouse(d.settings.receiving_warehouse ?? '');
    } catch (err) {
      handle(err);
    }
  }, [handle]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setError('');
    setSaved(false);
    try {
      await api.saveMatchingSettings({
        tolerance_percent: Number(percent.replace(',', '.')),
        tolerance_cap_cents: Math.round(Number(cap.replace(',', '.')) * 100),
        receiving_warehouse: warehouse || null,
      });
      await load();
      setSaved(true);
    } catch (err) {
      handle(err);
    }
  }

  if (!data) return error ? <div className="resource__error mono">{error}</div> : <div className="boot mono">LOADING…</div>;
  const s = data.settings;
  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ PRC.05 · MATCHING</div>
          <h1 className="resource__title">Receiving &amp; three-way match</h1>
          <p className="resource__desc">
            An invoice against a PO is paid without anyone releasing it when its net amount is no more than what has arrived, valued at the PO's prices, plus the
            tolerance: {String(s.tolerance_percent).replace('.', ',')} % of it, at most {fmtEur(s.tolerance_cap_cents)}. More than that is held in MOD-04 until the
            goods arrive or a manager releases it with a reason.
          </p>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}
      {saved && <div className="mono table__id">SAVED</div>}

      <div className="receive-bar">
        <label className="field">
          <span className="field__label mono">TOLERANCE %</span>
          <input className="field__input receive-input" value={percent} disabled={!canManage} onChange={(e) => setPercent(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label mono">AT MOST (€)</span>
          <input className="field__input receive-input" value={cap} disabled={!canManage} onChange={(e) => setCap(e.target.value)} />
        </label>
        <label className="field" style={{ minWidth: 220 }}>
          <span className="field__label mono">RECEIVING WAREHOUSE (MOD-03)</span>
          {data.warehouses ? (
            <select className="field__input" value={warehouse} disabled={!canManage} onChange={(e) => setWarehouse(e.target.value)}>
              <option value="">— book no stock —</option>
              {data.warehouses.map((w) => (
                <option key={w.code} value={w.code}>
                  {w.code} · {w.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="field__input"
              value={warehouse}
              disabled={!canManage}
              placeholder={data.inventory_configured ? 'MOD-03 is not answering — type the code' : 'Set INVENTORY_URL to book stock'}
              onChange={(e) => setWarehouse(e.target.value)}
            />
          )}
        </label>
        <Can level="manage">
          <button className="btn btn--primary" onClick={() => void save()}>
            SAVE →
          </button>
        </Can>
      </div>
      {data.updated_by && (
        <p className="resource__desc mono table__id">
          CHANGED {data.updated_at?.slice(0, 10)} BY {data.updated_by}
        </p>
      )}
    </div>
  );
}
