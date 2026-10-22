import { useCallback, useEffect, useState } from 'react';
import type { LeaveSettings } from '../../shared/types';
import { api } from '../api';

/**
 * The holiday calendar absences are counted against: the country's statutory
 * days (computed, not typed — shared/holidays.ts) plus the company's own.
 * Changing it re-prices every request, since days are derived, not stored.
 */
export function LeaveSettingsPanel({ year, onSaved, onError }: { year: number; onSaved: () => void; onError: (err: unknown) => void }) {
  const [settings, setSettings] = useState<LeaveSettings | null>(null);
  const [stamp, setStamp] = useState<{ updated_at: string | null; updated_by: string | null }>({ updated_at: null, updated_by: null });
  const [holidays, setHolidays] = useState<{ date: string; name: string }[]>([]);
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, h] = await Promise.all([api.leaveSettings(), api.holidays(year)]);
      setSettings(s.settings);
      setStamp({ updated_at: s.updated_at, updated_by: s.updated_by });
      setHolidays(h.holidays);
    } catch (err) {
      onError(err);
    }
  }, [year, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(next: LeaveSettings) {
    setBusy(true);
    try {
      await api.saveLeaveSettings(next);
      await load();
      onSaved();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  if (!settings) return null;
  return (
    <>
      <div className="section-title mono">HOLIDAY CALENDAR {year}</div>
      <div className="editbar">
        <select
          className="field__input field__input--narrow"
          value={settings.country}
          disabled={busy}
          onChange={(e) => void save({ ...settings, country: e.target.value as LeaveSettings['country'] })}
        >
          <option value="AT">Austria — statutory holidays</option>
          <option value="DE">Germany — nationwide holidays</option>
        </select>
        <input className="field__input field__input--narrow" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <input className="field__input" placeholder="Company or regional day off, e.g. Christmas Eve" value={name} onChange={(e) => setName(e.target.value)} />
        <button
          className="btn btn--primary"
          disabled={busy || date === '' || name.trim() === ''}
          onClick={() =>
            void save({ ...settings, extra_holidays: [...settings.extra_holidays, { date, name: name.trim() }] }).then(() => {
              setDate('');
              setName('');
            })
          }
        >
          ADD DAY OFF
        </button>
        {stamp.updated_by && (
          <span className="toolbar__count mono">
            CHANGED {stamp.updated_at?.slice(0, 10)} · {stamp.updated_by}
          </span>
        )}
      </div>
      <div className="table-wrap">
        <table className="table">
          <tbody>
            {holidays.map((h) => {
              const extra = settings.extra_holidays.some((x) => x.date === h.date && x.name === h.name);
              return (
                <tr key={`${h.date}-${h.name}`}>
                  <td className="mono table__id">{h.date}</td>
                  <td>{h.name}</td>
                  <td className="mono">{extra ? 'COMPANY' : 'STATUTORY'}</td>
                  <td>
                    {extra && (
                      <div className="table__rowactions">
                        <button
                          className="rowbtn rowbtn--danger"
                          disabled={busy}
                          onClick={() => void save({ ...settings, extra_holidays: settings.extra_holidays.filter((x) => !(x.date === h.date && x.name === h.name)) })}
                        >
                          REMOVE
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
