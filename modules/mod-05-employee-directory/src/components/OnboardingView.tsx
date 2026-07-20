import { useCallback, useEffect, useState } from 'react';
import type { OnboardingEntry, OnboardingFlags, OnboardingLists } from '../../shared/types';
import { api, ApiError } from '../api';
import { fmtDate, fmtRelativeDays } from '../format';

interface Props {
  onOpen: (id: number) => void;
  onAuthLost: () => void;
}

const FLAGS: { key: keyof OnboardingFlags; label: string }[] = [
  { key: 'account_created', label: 'ACCOUNT' },
  { key: 'hardware_issued', label: 'HARDWARE' },
  { key: 'intro_meeting_booked', label: 'INTRO MEETING' },
];

export function OnboardingView({ onOpen, onAuthLost }: Props) {
  const [lists, setLists] = useState<OnboardingLists | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setLists(await api.onboarding());
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load onboarding');
    }
  }, [onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(entry: OnboardingEntry, key: keyof OnboardingFlags) {
    try {
      await api.setOnboarding(entry.id, { [key]: !entry.onboarding[key] });
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Update failed');
    }
  }

  const renderTable = (entries: OnboardingEntry[], empty: string) => (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th className="mono">NAME</th>
            <th className="mono">TITLE</th>
            <th className="mono">DEPT</th>
            <th className="mono">STARTS</th>
            <th className="mono">CHECKLIST</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td>
                <button className="linklike" onClick={() => onOpen(entry.id)}>
                  {entry.name}
                </button>
              </td>
              <td>{entry.job_title}</td>
              <td>
                <span className="badge badge--dept mono">{entry.department_code}</span>
              </td>
              <td className="mono table__id">
                {fmtDate(entry.start_date)} · {fmtRelativeDays(entry.days_until_start)}
              </td>
              <td>
                <div className="checklist">
                  {FLAGS.map(({ key, label }) => (
                    <label key={key} className={`check mono ${entry.onboarding[key] ? 'is-done' : ''}`}>
                      <input
                        type="checkbox"
                        checked={entry.onboarding[key]}
                        onChange={() => void toggle(entry, key)}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </td>
            </tr>
          ))}
          {entries.length === 0 && (
            <tr>
              <td className="table__empty mono" colSpan={5}>
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ DIR.04 · HR ONBOARDING</div>
          <h1 className="resource__title">Onboarding</h1>
          <p className="resource__desc">
            Starting within 30 days or started within the last 14 — with the three stored checklist flags.
          </p>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      {lists && (
        <>
          <div className="section-title mono">STARTING SOON ({lists.upcoming.length})</div>
          {renderTable(lists.upcoming, 'NOBODY STARTS IN THE NEXT 30 DAYS')}
          <div className="section-title mono">JUST STARTED ({lists.recent.length})</div>
          {renderTable(lists.recent, 'NOBODY STARTED IN THE LAST 14 DAYS')}
        </>
      )}
    </div>
  );
}
