import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Item, Me } from '../../shared/types';
import { api, ApiError } from '../api';

/**
 * The example screen. It shows the pattern every screen should follow: the
 * server enforces access (server/access.ts), and the UI only HIDES what the
 * person cannot do, so nobody is offered a button that answers 403.
 */
export function ItemsView({ access, onAuthLost }: { access: Me['access']; onAuthLost: () => void }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');

  const canEdit = access === 'edit' || access === 'manage';
  const canManage = access === 'manage';

  const guard = useCallback(
    async (action: () => Promise<unknown>) => {
      setError('');
      try {
        await action();
        setItems((await api.items()).items);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) onAuthLost();
        else setError(err instanceof ApiError ? err.message : 'Something went wrong');
      }
    },
    [onAuthLost],
  );

  useEffect(() => {
    void guard(async () => undefined);
  }, [guard]);

  function create(event: FormEvent) {
    event.preventDefault();
    void guard(async () => {
      await api.createItem({ title, notes });
      setTitle('');
      setNotes('');
    });
  }

  return (
    <section>
      <header className="resource__head">
        <div>
          <div className="resource__eyebrow mono">{{N}} · ITEMS</div>
          <h1 className="resource__title">Items</h1>
        </div>
      </header>
      {error && <div className="resource__error mono">{error}</div>}

      {canEdit && (
        <form className="toolbar" onSubmit={create}>
          <input className="field__input" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <input className="field__input" placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <button className="btn btn--primary" type="submit" disabled={title.trim() === ''}>
            ADD
          </button>
        </form>
      )}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Title</th>
              <th>Status</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items?.length === 0 && (
              <tr>
                <td className="table__empty" colSpan={5}>
                  Nothing here yet.
                </td>
              </tr>
            )}
            {items?.map((item) => (
              <tr key={item.id}>
                <td className="table__id mono">{item.id}</td>
                <td>
                  {item.title}
                  {item.notes && <div className="note-cell">{item.notes}</div>}
                </td>
                <td className="mono">{item.status.toUpperCase()}</td>
                <td className="mono">{item.updated_at.slice(0, 10)}</td>
                <td className="table__rowactions">
                  {canEdit && (
                    <button
                      className="rowbtn mono"
                      onClick={() => void guard(() => api.setStatus(item.id, item.status === 'done' ? 'open' : 'done'))}
                    >
                      {item.status === 'done' ? 'REOPEN' : 'DONE'}
                    </button>
                  )}
                  {canManage && (
                    <button className="rowbtn mono" onClick={() => void guard(() => api.archive(item.id))}>
                      ARCHIVE
                    </button>
                  )}
                  {canEdit && (
                    <button className="rowbtn rowbtn--danger mono" onClick={() => void guard(() => api.remove(item.id))}>
                      DELETE
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
