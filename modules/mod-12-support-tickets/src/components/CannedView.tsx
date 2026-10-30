import { useCallback, useEffect, useState } from 'react';
import { CANNED_PLACEHOLDERS, type CannedResponse } from '../../shared/types';
import { api, ApiError } from '../api';
import { useCan } from '../access';
import { fmtDateTime } from '../format';

/**
 * The team's canned responses. Everyone sees them; a manager writes them.
 * In a ticket's reply box they are filled for that ticket and can be edited
 * before sending.
 */
export function CannedView({ onAuthLost }: { onAuthLost: () => void }) {
  const canManage = useCan('manage');
  const [items, setItems] = useState<CannedResponse[]>([]);
  const [editing, setEditing] = useState<{ id: number | null; title: string; body: string } | null>(null);
  const [error, setError] = useState('');
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
      setItems((await api.canned()).canned_responses);
    } catch (err) {
      fail(err);
    }
  }, [fail]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
      await load();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ SUP.05 · CANNED RESPONSES</div>
          <h1 className="resource__title">Canned responses</h1>
          <p className="resource__desc">
            Reply templates for the team. Placeholders are filled per ticket: {CANNED_PLACEHOLDERS.map((p) => `{{${p}}}`).join(' ')}. The count is the replies that started from one.
          </p>
        </div>
        {canManage && !editing && (
          <button className="btn btn--primary" onClick={() => setEditing({ id: null, title: '', body: '' })}>
            NEW RESPONSE →
          </button>
        )}
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      {editing && (
        <div className="panel">
          <label className="field">
            <span className="field__label mono">TITLE</span>
            <input className="field__input" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
          </label>
          <label className="field">
            <span className="field__label mono">TEXT</span>
            <textarea className="field__input" rows={8} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} placeholder={'Hello {{requester_first_name}},\n\n…\n\n{{agent_name}}'} />
          </label>
          <div className="editbar">
            <button
              className="btn btn--primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (editing.id === null) await api.createCanned({ title: editing.title, body: editing.body });
                  else await api.updateCanned(editing.id, { title: editing.title, body: editing.body });
                  setEditing(null);
                })
              }
            >
              SAVE →
            </button>
            <button className="btn btn--ghost" disabled={busy} onClick={() => setEditing(null)}>
              CANCEL
            </button>
          </div>
        </div>
      )}

      {items.length === 0 ? (
        <p className="resource__desc">None yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th className="mono">TITLE</th>
                <th className="mono">TEXT</th>
                <th className="mono">USED</th>
                <th className="mono">CHANGED</th>
                {canManage && <th />}
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id} style={c.active ? undefined : { opacity: 0.5 }}>
                  <td>
                    {c.title}
                    {!c.active && <span className="mono table__id"> · OFF</span>}
                  </td>
                  <td className="table__subject" style={{ whiteSpace: 'pre-line', maxWidth: 420 }}>
                    {c.body.length > 160 ? `${c.body.slice(0, 160)}…` : c.body}
                  </td>
                  <td className="mono">{c.uses}</td>
                  <td className="mono table__id">
                    {fmtDateTime(c.updated_at)} · {c.updated_by}
                  </td>
                  {canManage && (
                    <td className="mono">
                      <button className="linklike mono" disabled={busy} onClick={() => setEditing({ id: c.id, title: c.title, body: c.body })}>
                        EDIT
                      </button>{' '}
                      <button className="linklike mono" disabled={busy} onClick={() => void run(() => api.updateCanned(c.id, { active: !c.active }))}>
                        {c.active ? 'SWITCH OFF' : 'SWITCH ON'}
                      </button>{' '}
                      <button className="linklike mono" disabled={busy} onClick={() => window.confirm(`Delete "${c.title}"? Replies keep their text.`) && void run(() => api.deleteCanned(c.id))}>
                        DELETE
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
