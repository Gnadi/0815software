import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Holiday, Region } from '../../shared/calendar';
import { addDays, formatDate, isWeekend, weekday } from '../../shared/calendar';
import { api, ApiError, type AppConfig } from '../api';
import { fmtMonth, WEEKDAY_LABELS } from '../format';

interface Props {
  config: AppConfig;
  onAuthLost: () => void;
}

/** Every day of `month` (0-based), padded so the grid starts on a Monday. */
function monthCells(year: number, month: number): (string | null)[] {
  const first = formatDate(new Date(Date.UTC(year, month, 1)));
  const lead = (weekday(first) + 6) % 7; // Monday-first
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let day = first; Number(day.slice(5, 7)) === month + 1; day = addDays(day, 1)) cells.push(day);
  return cells;
}

export function CalendarView({ config, onAuthLost }: Props) {
  const [region, setRegion] = useState<Region>(config.default_region);
  const [compare, setCompare] = useState<Region | ''>('');
  const [year, setYear] = useState(Number(config.today.slice(0, 4)));
  const [primary, setPrimary] = useState<Holiday[]>([]);
  const [other, setOther] = useState<Holiday[]>([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([
        api.holidays(region, year),
        compare === '' ? Promise.resolve(null) : api.holidays(compare, year),
      ]);
      setPrimary(a.holidays);
      setOther(b?.holidays ?? []);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load the calendar');
    }
  }, [region, compare, year, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  const byDate = useMemo(() => new Map(primary.map((holiday) => [holiday.date, holiday.name])), [primary]);
  const otherByDate = useMemo(() => new Map(other.map((holiday) => [holiday.date, holiday.name])), [other]);

  /**
   * Days the two regions disagree about. This is the module's whole argument
   * in one number: a company with people in Bayern and Berlin is running two
   * different working-day calendars whether or not its leave tool admits it.
   */
  const differences = useMemo(() => {
    if (compare === '') return [];
    const all = new Set([...byDate.keys(), ...otherByDate.keys()]);
    return [...all].filter((date) => byDate.has(date) !== otherByDate.has(date)).sort();
  }, [compare, byDate, otherByDate]);

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ ABS.05 · CALENDAR</div>
          <h1 className="resource__title">Public holidays {year}</h1>
          <p className="resource__desc">
            Computed, never stored — from the fixed dates and the Easter offsets, per region. The same function
            decides what a request costs, so a day greyed out here is a day nobody is charged for.
          </p>
        </div>
        <div className="resource__actions">
          <button className="btn btn--ghost" onClick={() => setYear((y) => y - 1)}>
            ← {year - 1}
          </button>
          <button className="btn btn--ghost" onClick={() => setYear((y) => y + 1)}>
            {year + 1} →
          </button>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="toolbar">
        <select className="toolbar__select mono" value={region} onChange={(e) => setRegion(e.target.value as Region)}>
          {config.regions.map((option) => (
            <option key={option.code} value={option.code}>
              {option.code} · {option.label}
            </option>
          ))}
        </select>
        <select
          className="toolbar__select mono"
          value={compare}
          onChange={(e) => setCompare(e.target.value as Region | '')}
        >
          <option value="">COMPARE WITH…</option>
          {config.regions
            .filter((option) => option.code !== region)
            .map((option) => (
              <option key={option.code} value={option.code}>
                {option.code} · {option.label}
              </option>
            ))}
        </select>
        <span className="toolbar__count mono">
          {primary.length} HOLIDAYS
          {compare !== '' && ` · ${differences.length} DAY(S) DIFFER FROM ${compare}`}
        </span>
      </div>

      <div className="months">
        {Array.from({ length: 12 }, (_, month) => (
          <section key={month} className="month">
            <h3 className="month__title mono">{fmtMonth(year, month)}</h3>
            <div className="month__grid">
              {WEEKDAY_LABELS.map((label) => (
                <span key={label} className="month__wd mono">
                  {label}
                </span>
              ))}
              {monthCells(year, month).map((day, index) => {
                if (day === null) return <span key={`pad-${index}`} className="month__cell month__cell--pad" />;
                const name = byDate.get(day);
                const differs = compare !== '' && byDate.has(day) !== otherByDate.has(day);
                const classes = [
                  'month__cell',
                  'mono',
                  isWeekend(day) ? 'month__cell--weekend' : '',
                  name ? 'month__cell--holiday' : '',
                  differs ? 'month__cell--differs' : '',
                  day === config.today ? 'month__cell--today' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                return (
                  <span key={day} className={classes} title={name ?? otherByDate.get(day) ?? undefined}>
                    {Number(day.slice(8))}
                  </span>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Holiday</th>
              <th>Scope</th>
              {compare !== '' && <th>{compare}</th>}
            </tr>
          </thead>
          <tbody>
            {primary.map((holiday) => (
              <tr key={holiday.date}>
                <td className="mono">{holiday.date}</td>
                <td>{holiday.name}</td>
                <td className="mono table__muted">{holiday.nationwide ? 'NATIONWIDE' : 'REGIONAL'}</td>
                {compare !== '' && (
                  <td className={`mono ${otherByDate.has(holiday.date) ? 'table__muted' : 'cell--alert'}`}>
                    {otherByDate.has(holiday.date) ? 'ALSO A HOLIDAY' : 'WORKING DAY'}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
