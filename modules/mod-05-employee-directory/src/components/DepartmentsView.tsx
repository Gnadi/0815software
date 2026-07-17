import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { DepartmentRow } from '../../shared/types';
import { api, ApiError } from '../api';

interface Props {
  onAuthLost: () => void;
}

interface ModalState {
  /** null = create. */
  editing: DepartmentRow | null;
}

export function DepartmentsView({ onAuthLost }: Props) {
  const [rows, setRows] = useState<DepartmentRow[] | null>(null);
  const [error, setError] = useState('');
  const [modal, setModal] = useState<ModalState | null>(null);

  const load = useCallback(async () => {
    try {
      const { departments } = await api.departments();
      setRows(departments);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load departments');
    }
  }, [onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(dept: DepartmentRow) {
    if (!window.confirm(`Delete department ${dept.code} · ${dept.name}?`)) return;
    try {
      await api.deleteDepartment(dept.id);
      await load();
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ DIR.02 · STRUCTURE</div>
          <h1 className="resource__title">Departments</h1>
          <p className="resource__desc">The department tree — deletable only while empty.</p>
        </div>
        <div className="resource__actions">
          <button className="btn btn--primary" onClick={() => setModal({ editing: null })}>
            + ADD DEPARTMENT
          </button>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">CODE</th>
              <th className="mono">NAME</th>
              <th className="mono">PARENT</th>
              <th className="mono">EMPLOYEES</th>
              <th className="mono">CHILDREN</th>
              <th className="mono"></th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((dept) => (
              <tr key={dept.id}>
                <td>
                  <span className="badge badge--dept mono">{dept.code}</span>
                </td>
                <td>{dept.name}</td>
                <td>{dept.parent_name ?? '—'}</td>
                <td className="mono table__id">{dept.employee_count}</td>
                <td className="mono table__id">{dept.child_count}</td>
                <td>
                  <div className="table__rowactions">
                    <button className="rowbtn mono" onClick={() => setModal({ editing: dept })}>
                      EDIT
                    </button>
                    <button
                      className="rowbtn rowbtn--danger mono"
                      disabled={dept.employee_count > 0 || dept.child_count > 0}
                      onClick={() => void remove(dept)}
                    >
                      DELETE
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {rows && rows.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={6}>
                  NO DEPARTMENTS YET
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {modal && (
        <DepartmentModal
          initial={modal.editing}
          all={rows ?? []}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            void load();
          }}
          onAuthLost={onAuthLost}
        />
      )}
    </div>
  );
}

function DepartmentModal({
  initial,
  all,
  onClose,
  onSaved,
  onAuthLost,
}: {
  initial: DepartmentRow | null;
  all: DepartmentRow[];
  onClose: () => void;
  onSaved: () => void;
  onAuthLost: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [code, setCode] = useState(initial?.code ?? '');
  const [parentId, setParentId] = useState(initial?.parent_id ? String(initial.parent_id) : '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const payload = { name, code, parent_id: parentId ? Number(parentId) : null };
    try {
      if (initial) await api.updateDepartment(initial.id, payload);
      else await api.createDepartment(payload);
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else if (err instanceof ApiError && err.details.length > 0) {
        setError(err.details.map((d) => `${d.field}: ${d.message}`).join(' · '));
      } else setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal">
      <div className="modal__backdrop" onClick={onClose} />
      <form className="modal__card" onSubmit={(e) => void submit(e)}>
        <div className="modal__eyebrow mono">{initial ? `DEPARTMENT #${initial.id}` : 'NEW DEPARTMENT'}</div>
        <h2 className="modal__title">{initial ? 'Edit department' : 'Add department'}</h2>
        {error && <div className="modal__error mono">{error}</div>}
        <div className="modal__fields">
          <label className="field">
            <span className="field__label mono">
              NAME <span className="field__req">*</span>
            </span>
            <input className="field__input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
          <label className="field">
            <span className="field__label mono">
              CODE <span className="field__req">*</span>
            </span>
            <input className="field__input mono" value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
          <label className="field">
            <span className="field__label mono">PARENT DEPARTMENT</span>
            <select className="field__input" value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">— none (top level) —</option>
              {all
                .filter((d) => d.id !== initial?.id)
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.code} · {d.name}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <div className="modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            CANCEL
          </button>
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? 'SAVING…' : 'SAVE'}
          </button>
        </div>
      </form>
    </div>
  );
}
