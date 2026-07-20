import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { admin, ApiError, type AdminCategory } from '../api';

export function CategoriesAdmin({ onAuthLost }: { onAuthLost: () => void }) {
  const [categories, setCategories] = useState<AdminCategory[]>([]);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: number; name: string; position: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const guard = useCallback(
    (err: unknown, fallback: string): string => {
      if (err instanceof ApiError && err.status === 401) {
        onAuthLost();
        return '';
      }
      return err instanceof ApiError ? err.message : fallback;
    },
    [onAuthLost],
  );

  const load = useCallback(async () => {
    try {
      setCategories((await admin.categories()).categories);
    } catch (err) {
      setError(guard(err, 'Could not load categories'));
    }
  }, [guard]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError('');
    try {
      await admin.createCategory({ name: name.trim(), position: categories.length + 1 });
      setName('');
      await load();
    } catch (err) {
      setError(guard(err, 'Could not create the category'));
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    if (!editing) return;
    setBusy(true);
    setError('');
    try {
      await admin.updateCategory(editing.id, {
        name: editing.name,
        position: Number(editing.position) || 0,
      });
      setEditing(null);
      await load();
    } catch (err) {
      setError(guard(err, 'Could not save the category'));
    } finally {
      setBusy(false);
    }
  }

  async function remove(category: AdminCategory) {
    if (!window.confirm(`Delete category "${category.name}"?`)) return;
    setError('');
    try {
      await admin.deleteCategory(category.id);
      await load();
    } catch (err) {
      setError(guard(err, 'Could not delete the category'));
    }
  }

  return (
    <section>
      <div className="resource__head">
        <div>
          <p className="resource__eyebrow mono">CATEGORIES</p>
          <h1 className="resource__title">Categories</h1>
          <p className="resource__desc">Position controls the shop's ordering. A category with products cannot be deleted.</p>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <form className="toolbar" onSubmit={(e) => void create(e)}>
        <input
          className="field__input toolbar__search"
          placeholder="New category name…"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="btn btn--primary" type="submit" disabled={busy || !name.trim()}>
          ADD +
        </button>
      </form>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">POS</th>
              <th className="mono">NAME</th>
              <th className="mono">PRODUCTS</th>
              <th className="mono">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {categories.map((c) => (
              <tr key={c.id}>
                {editing?.id === c.id ? (
                  <>
                    <td>
                      <input
                        className="field__input cartline__qty mono"
                        type="number"
                        value={editing.position}
                        onChange={(e) => setEditing({ ...editing, position: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        className="field__input"
                        value={editing.name}
                        onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                      />
                    </td>
                    <td className="table__num mono">{c.product_count}</td>
                    <td>
                      <div className="table__rowactions">
                        <button className="rowbtn mono" onClick={() => void saveEdit()} disabled={busy}>
                          SAVE
                        </button>
                        <button className="rowbtn mono" onClick={() => setEditing(null)}>
                          CANCEL
                        </button>
                      </div>
                    </td>
                  </>
                ) : (
                  <>
                    <td className="table__num mono">{c.position}</td>
                    <td>{c.name}</td>
                    <td className="table__num mono">{c.product_count}</td>
                    <td>
                      <div className="table__rowactions">
                        <button
                          className="rowbtn mono"
                          onClick={() => setEditing({ id: c.id, name: c.name, position: String(c.position) })}
                        >
                          EDIT
                        </button>
                        <button
                          className="rowbtn rowbtn--danger mono"
                          onClick={() => void remove(c)}
                          disabled={c.product_count > 0}
                          title={c.product_count > 0 ? 'Move or delete its products first' : undefined}
                        >
                          DELETE
                        </button>
                      </div>
                    </td>
                  </>
                )}
              </tr>
            ))}
            {categories.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={4}>NO CATEGORIES</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
