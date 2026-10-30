import { useCallback, useEffect, useState } from 'react';
import type { ReportSettings } from '../../shared/types';
import { api, ApiError, errorText } from '../api';
import { ts } from '../format';
import { Can, useCan } from '../access';
import { describeValue } from './ParamForm';

interface Props {
  onAuthLost: () => void;
}

/** The zones this browser knows; the server checks the one chosen either way. */
const ZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
})();

export function SettingsView({ onAuthLost }: Props) {
  const [settings, setSettings] = useState<ReportSettings | null>(null);
  const [timezone, setTimezone] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const canManage = useCan('manage');

  const load = useCallback(async () => {
    try {
      const s = await api.settings();
      setSettings(s);
      setTimezone(s.timezone);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      setError(errorText(err, 'Failed to load settings'));
    }
  }, [onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setError('');
    setSaved(false);
    try {
      const s = await api.saveSettings({ timezone });
      setSettings(s);
      setSaved(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      setError(errorText(err, 'Save failed'));
    }
  }

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">MODULE SETTINGS</div>
          <h1 className="resource__title">Settings</h1>
          <p className="resource__desc">
            Relative dates in report parameters — {describeValue('today').toLowerCase()},{' '}
            {describeValue('prev_month_start').toLowerCase()}, {describeValue('today-7')} — are days
            where the office is. The time zone decides when &ldquo;today&rdquo; begins, so a monthly
            export that runs just after midnight covers the right month.
          </p>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      {settings && (
        <div className="builder">
          <label className="field" style={{ minWidth: 260 }}>
            <span className="field__label mono">TIME ZONE (IANA)</span>
            {ZONES.length > 0 ? (
              <select className="field__input" value={timezone} disabled={!canManage} onChange={(e) => setTimezone(e.target.value)}>
                {!ZONES.includes(timezone) && <option value={timezone}>{timezone}</option>}
                {ZONES.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            ) : (
              <input className="field__input" value={timezone} disabled={!canManage} onChange={(e) => setTimezone(e.target.value)} />
            )}
          </label>
          <Can level="manage">
            <button className="btn btn--primary" onClick={() => void save()} disabled={timezone === settings.timezone}>
              SAVE
            </button>
          </Can>
          <span className="hint mono" style={{ margin: 0 }}>
            {saved ? 'SAVED · ' : ''}
            {settings.updated_by ? `LAST CHANGED BY ${settings.updated_by} · ${ts(settings.updated_at)}` : 'DEFAULT — NEVER CHANGED'}
          </span>
        </div>
      )}
    </div>
  );
}
