import { useCallback, useEffect, useState } from 'react';
import type { MailboxStatus } from '../../shared/types';
import { api, ApiError, type SettingsView as SettingsData } from '../api';
import { fmtDateTime } from '../format';

/**
 * How the desk talks to requesters — a manager's screen: satisfaction
 * ratings, replies by email, and the support mailbox read through PS-05.
 * What needs a platform service says so when the service is not wired.
 */

const ACTION_LABEL: Record<string, string> = { created: 'NEW TICKET', appended: 'REPLY', noted: 'INTERNAL NOTE', ignored: 'IGNORED', failed: 'FAILED' };

export function SettingsView({ onAuthLost }: { onAuthLost: () => void }) {
  const [data, setData] = useState<SettingsData | null>(null);
  const [mailbox, setMailbox] = useState<MailboxStatus | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof ApiError && err.details.length > 0 ? `${err.message}: ${err.details.map((d) => d.message).join(' · ')}` : err instanceof Error ? err.message : 'Request failed');
    },
    [onAuthLost],
  );

  const load = useCallback(async () => {
    try {
      const [s, m] = await Promise.all([api.settings(), api.mailbox()]);
      setData(s);
      setMailbox(m);
    } catch (err) {
      fail(err);
    }
  }, [fail]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<string | void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const message = await action();
      if (message) setNotice(message);
      await load();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }
  const save = (values: Record<string, unknown>) =>
    run(async () => {
      await api.saveSettings(values);
      return 'Saved.';
    });

  if (!data || !mailbox) return error ? <div className="resource__error mono">{error}</div> : <div className="boot mono">LOADING…</div>;
  const { settings } = data;

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ SUP.06 · SETTINGS{data.updated_by ? ` · LAST CHANGED BY ${data.updated_by.toUpperCase()} · ${fmtDateTime(data.updated_at!)}` : ''}</div>
          <h1 className="resource__title">Settings</h1>
          <p className="resource__desc">
            How the desk reaches requesters. Mail goes out through PS-03 ({data.notification_configured ? 'connected' : 'not connected — set NOTIFICATION_URL'}); links in it point to{' '}
            <span className="mono">{data.public_base_url}</span>.
          </p>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}
      {notice && <div className="mono table__id">{notice}</div>}

      <div className="section-title mono">SATISFACTION RATINGS</div>
      <label className="check">
        <input type="checkbox" checked={settings.csat.enabled} disabled={busy} onChange={(e) => void save({ csat: { enabled: e.target.checked, invite_by_email: e.target.checked && settings.csat.invite_by_email } })} />
        <span>The requester may rate a resolved ticket, 1 to 5 stars, on their status page — once per resolution.</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.csat.invite_by_email} disabled={busy || !settings.csat.enabled || !data.notification_configured} onChange={(e) => void save({ csat: { invite_by_email: e.target.checked } })} />
        <span>And is invited by email when a ticket is resolved.{!data.notification_configured && ' (Needs PS-03.)'}</span>
      </label>

      <div className="section-title mono">REPLIES BY EMAIL</div>
      <label className="check">
        <input type="checkbox" checked={settings.reply_by_email} disabled={busy || !data.notification_configured} onChange={(e) => void save({ reply_by_email: e.target.checked })} />
        <span>
          Public replies go to the requester by email, with the ticket reference in the subject so an answer finds its way back. Internal notes never do.
          {!data.notification_configured && ' (Needs PS-03.)'}
        </span>
      </label>

      <div className="section-title mono">SUPPORT MAILBOX · PS-05</div>
      {!mailbox.configured ? (
        <p className="resource__desc">
          Not connected. Set <span className="mono">INTEGRATION_URL</span> and <span className="mono">PLATFORM_SERVICE_TOKEN</span>, and create an IMAP mailbox connection in PS-05. Until then mail
          can still come in through <span className="mono">POST /api/intake/email</span>.
        </p>
      ) : (
        <>
          <p className="resource__desc">
            New mail opens a ticket; a reply with <span className="mono">[TKT-…]</span> in the subject lands on that ticket — as an internal note when it is not from the requester. Auto-replies and
            bounces are ignored. Each message is taken once, then marked read in the mailbox.
          </p>
          {mailbox.connections_error && <div className="resource__error mono">PS-05: {mailbox.connections_error}</div>}
          <div className="policy-grid">
            <label className="field">
              <span className="field__label mono">MAILBOX</span>
              <select
                className="field__input"
                value={settings.mailbox.connection_id ?? ''}
                disabled={busy}
                onChange={(e) => void save({ mailbox: { connection_id: e.target.value === '' ? null : Number(e.target.value), enabled: e.target.value === '' ? false : settings.mailbox.enabled } })}
              >
                <option value="">— choose —</option>
                {mailbox.connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.account ?? '—'} {c.status !== 'connected' ? `(${c.status})` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field__label mono">CHECK EVERY (SECONDS)</span>
              <input className="field__input" type="number" min={30} max={3600} defaultValue={settings.mailbox.poll_seconds} disabled={busy} onBlur={(e) => Number(e.target.value) !== settings.mailbox.poll_seconds && void save({ mailbox: { poll_seconds: Number(e.target.value) } })} />
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={settings.mailbox.enabled} disabled={busy || settings.mailbox.connection_id === null} onChange={(e) => void save({ mailbox: { enabled: e.target.checked } })} />
            <span>Read it automatically while the server runs.</span>
          </label>
          <div className="editbar">
            <button
              className="btn btn--ghost"
              disabled={busy || settings.mailbox.connection_id === null}
              onClick={() =>
                void run(async () => {
                  const probe = await api.testMailbox();
                  return `Connected to ${probe.mailbox}: ${probe.exists} messages, ${probe.unseen} unread.`;
                })
              }
            >
              TEST CONNECTION
            </button>
            <button
              className="btn btn--primary"
              disabled={busy || settings.mailbox.connection_id === null}
              onClick={() =>
                void run(async () => {
                  const r = await api.pollMailbox();
                  return `Read ${r.fetched} message${r.fetched === 1 ? '' : 's'}${r.duplicates > 0 ? ` (${r.duplicates} taken before)` : ''}${r.remaining > 0 ? ` — ${r.remaining} more next time` : ''}.`;
                })
              }
            >
              CHECK NOW →
            </button>
          </div>
          {mailbox.last_poll && (
            <p className={`mono table__id ${mailbox.last_poll.ok ? '' : 'resource__error'}`}>
              LAST CHECKED {fmtDateTime(mailbox.last_poll.at)} · {mailbox.last_poll.ok ? `OK · ${mailbox.last_poll.fetched} MESSAGES` : `FAILED · ${mailbox.last_poll.error}`}
            </p>
          )}
          {mailbox.recent.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th className="mono">RECEIVED</th>
                    <th className="mono">FROM</th>
                    <th className="mono">SUBJECT</th>
                    <th className="mono">BECAME</th>
                  </tr>
                </thead>
                <tbody>
                  {mailbox.recent.map((m) => (
                    <tr key={m.id}>
                      <td className="mono table__id">{fmtDateTime(m.received_at)}</td>
                      <td>{m.from_address ?? '—'}</td>
                      <td>{m.subject}</td>
                      <td className="mono">
                        {ACTION_LABEL[m.action]}
                        {m.ticket_ref ? ` · ${m.ticket_ref}` : ''}
                        {m.reason && <div className="table__id">{m.reason}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <div className="section-title mono">ATTACHMENTS</div>
      <p className="resource__desc">
        Stored in this module's database, so a backup carries them{data.files_configured ? '; PS-06 keeps a copy of each' : ''}. Limits are set with{' '}
        <span className="mono">ATTACHMENT_MAX_BYTES</span> and <span className="mono">ATTACHMENTS_PER_MESSAGE</span>.
      </p>
    </div>
  );
}
