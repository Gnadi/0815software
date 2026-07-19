import { useEffect, useState } from 'react';
import type { ExportProfileInfo } from '../../shared/types';
import { api, ApiError, exportCsvUrl } from '../api';
import { addDays, weekStartOf } from '../format';

interface Props {
  onAuthLost: () => void;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function ExportView({ onAuthLost }: Props) {
  const [profiles, setProfiles] = useState<ExportProfileInfo[]>([]);
  const [from, setFrom] = useState<string>(() => addDays(weekStartOf(todayIso()), -21));
  const [to, setTo] = useState<string>(() => addDays(weekStartOf(todayIso()), 6));
  const [error, setError] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const { profiles: list } = await api.exportProfiles();
        setProfiles(list);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) onAuthLost();
        else setError(err instanceof Error ? err.message : 'Failed to load');
      }
    })();
  }, [onAuthLost]);

  const rangeValid = from <= to;

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ TT.06 · EXPORT</div>
          <h1 className="resource__title">Export</h1>
          <p className="resource__desc">
            Export a date range through a declarative CSV profile — to payroll or to billing.
            Profiles are server config (server/export-profiles.ts); adding a format is one config
            entry, zero code. Money is derived from exact minutes, so payroll's rounded hours never
            affect billing amounts.
          </p>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="toolbar">
        <label className="field__label mono">FROM</label>
        <input className="field__input toolbar__filter" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <label className="field__label mono">TO</label>
        <input className="field__input toolbar__filter" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        {!rangeValid && <span className="resource__error mono">FROM must be on or before TO</span>}
      </div>

      <div className="profiles">
        {profiles.map((profile) => (
          <div key={profile.name} className="profile">
            <div className="profile__name mono">
              {profile.name}{' '}
              <span className="table__id">
                · scope “{profile.scope}” · delimiter “{profile.delimiter}”
              </span>
            </div>
            <div className="profile__desc">{profile.description}</div>
            <div className="profile__cols mono">{profile.columns.map((c) => c.header).join(' · ')}</div>
            {rangeValid ? (
              <a className="btn btn--primary" href={exportCsvUrl(profile.name, from, to)}>
                DOWNLOAD CSV ↓
              </a>
            ) : (
              <button className="btn btn--primary" disabled>
                DOWNLOAD CSV ↓
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="section-title mono">SCOPE = ROW GRANULARITY</div>
      <p className="resource__desc">
        <span className="mono">employee</span> — one row per person (payroll hours).{' '}
        <span className="mono">project</span> — one row per project/client (billing amounts).{' '}
        <span className="mono">entry</span> — one row per time entry (full audit detail). The export
        covers every entry whose date falls in the range, regardless of approval status; approval is
        a separate control (see Timesheets).
      </p>
    </div>
  );
}
