import { useCallback, useEffect, useState } from 'react';
import type { ReminderSent, TimerSettings } from '../../shared/types';
import { timer as timerApi } from '../api';

/**
 * The office's part of the timer: the time zone that decides what "today"
 * and "midnight" mean, and the reminders (server/reminders.ts) — each off
 * until switched on here, sent through PS-03 once per person and occasion.
 */
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function TimerSettingsPanel({ onError }: { onError: (err: unknown) => void }) {
  const [s, setS] = useState<TimerSettings | null>(null);
  const [meta, setMeta] = useState<{ updated_at: string | null; updated_by: string | null; notification_configured: boolean } | null>(null);
  const [sent, setSent] = useState<ReminderSent[]>([]);
  const [due, setDue] = useState<{ kind: string; name: string; ref: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      const [settings, reminders] = await Promise.all([timerApi.settings(), timerApi.reminders()]);
      setS(settings.settings);
      setMeta(settings);
      setSent(reminders.sent);
      setDue(reminders.due);
    } catch (err) {
      onError(err);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!s) return;
    setBusy(true);
    setNote('');
    try {
      await timerApi.saveSettings(s);
      await load();
      setNote('Saved.');
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  async function sendNow() {
    setBusy(true);
    setNote('');
    try {
      const r = await timerApi.runReminders();
      setNote(`${r.sent.length} reminder(s) sent.`);
      await load();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  if (!s || !meta) return null;
  return (
    <>
      <div className="section-title mono">TIMER & REMINDERS · THE OFFICE'S</div>
      <p className="resource__desc mono">
        {meta.notification_configured ? 'Reminders go out through PS-03, once per person and occasion.' : 'PS-03 is not connected (NOTIFICATION_URL): no reminder is sent until it is.'}
        {meta.updated_at && ` · Last changed ${meta.updated_at.slice(0, 16).replace('T', ' ')} by ${meta.updated_by}`}
      </p>
      <div className="editbar">
        <label className="field">
          <span className="field__label mono">TIME ZONE</span>
          <input className="field__input" value={s.timezone} onChange={(e) => setS({ ...s, timezone: e.target.value })} />
        </label>
        <label className="field">
          <span className="field__label mono">PS-03 CHANNEL</span>
          <input className="field__input" value={s.channel} onChange={(e) => setS({ ...s, channel: e.target.value })} />
        </label>
      </div>
      <div className="editbar">
        <label className="field">
          <span className="field__label mono">REMIND: LAST WEEK NOT SUBMITTED</span>
          <input type="checkbox" checked={s.week_reminder.enabled} onChange={(e) => setS({ ...s, week_reminder: { ...s.week_reminder, enabled: e.target.checked } })} />
        </label>
        <label className="field">
          <span className="field__label mono">FROM</span>
          <select className="field__input" value={s.week_reminder.weekday} onChange={(e) => setS({ ...s, week_reminder: { ...s.week_reminder, weekday: Number(e.target.value) } })}>
            {WEEKDAYS.map((d, i) => (
              <option key={d} value={i + 1}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label mono">AT (HOUR)</span>
          <input className="field__input field__input--narrow" type="number" min={0} max={23} value={s.week_reminder.hour} onChange={(e) => setS({ ...s, week_reminder: { ...s.week_reminder, hour: Number(e.target.value) } })} />
        </label>
      </div>
      <div className="editbar">
        <label className="field">
          <span className="field__label mono">REMIND: TIMER STILL RUNNING</span>
          <input type="checkbox" checked={s.timer_reminder.enabled} onChange={(e) => setS({ ...s, timer_reminder: { ...s.timer_reminder, enabled: e.target.checked } })} />
        </label>
        <label className="field">
          <span className="field__label mono">AFTER (HOURS)</span>
          <input
            className="field__input field__input--narrow"
            type="number"
            min={0.5}
            max={24}
            step={0.5}
            value={s.timer_reminder.after_minutes / 60}
            onChange={(e) => setS({ ...s, timer_reminder: { ...s.timer_reminder, after_minutes: Math.round(Number(e.target.value) * 60) } })}
          />
        </label>
        <button className="btn btn--primary" disabled={busy} onClick={() => void save()}>
          SAVE →
        </button>
        <button className="btn" disabled={busy || !meta.notification_configured || due.length === 0} onClick={() => void sendNow()}>
          SEND {due.length} DUE NOW
        </button>
      </div>
      {note && <div className="mono table__id">{note}</div>}
      <div className="table-wrap">
        <table className="table">
          <tbody>
            {sent.length === 0 && (
              <tr>
                <td className="table__empty mono">NO REMINDERS SENT YET</td>
              </tr>
            )}
            {sent.map((r) => (
              <tr key={r.id}>
                <td className="mono table__id">{r.sent_at.slice(0, 16).replace('T', ' ')}</td>
                <td>{r.employee_name}</td>
                <td className="mono">{r.kind === 'week_not_submitted' ? `week of ${r.ref} not submitted` : 'timer left running'}</td>
                <td className="mono table__id">{r.to_address}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
