import { useEffect, useState, type FormEvent } from 'react';
import type { DepartmentRow, Employee, EmployeeRow } from '../../shared/types';
import { api, ApiError } from '../api';

interface Props {
  /** null = create a new employee. */
  initial: Employee | null;
  onClose: () => void;
  onSaved: (id: number) => void;
  onAuthLost: () => void;
}

/** Create/edit form for an employee, in a modal. */
export function EmployeeModal({ initial, onClose, onSaved, onAuthLost }: Props) {
  const [departments, setDepartments] = useState<DepartmentRow[]>([]);
  const [managers, setManagers] = useState<EmployeeRow[]>([]);
  const [values, setValues] = useState({
    name: initial?.name ?? '',
    email: initial?.email ?? '',
    job_title: initial?.job_title ?? '',
    department_id: initial ? String(initial.department_id) : '',
    manager_id: initial?.manager_id ? String(initial.manager_id) : '',
    phone: initial?.phone ?? '',
    location: initial?.location ?? '',
    start_date: initial?.start_date ?? '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const [depts, emps] = await Promise.all([
          api.departments(),
          api.employees(new URLSearchParams({ status: 'active' })),
        ]);
        setDepartments(depts.departments);
        setManagers(emps.employees.filter((e) => e.id !== initial?.id));
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) onAuthLost();
      }
    })();
  }, [initial?.id, onAuthLost]);

  const set = (key: keyof typeof values) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const payload = {
      ...values,
      department_id: values.department_id ? Number(values.department_id) : null,
      manager_id: values.manager_id ? Number(values.manager_id) : null,
    };
    try {
      const saved = initial
        ? await api.updateEmployee(initial.id, payload)
        : await api.createEmployee(payload);
      onSaved(saved.id);
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
        <div className="modal__eyebrow mono">{initial ? `EMPLOYEE #${initial.id}` : 'NEW EMPLOYEE'}</div>
        <h2 className="modal__title">{initial ? 'Edit employee' : 'Add employee'}</h2>
        {error && <div className="modal__error mono">{error}</div>}
        <div className="modal__fields">
          <label className="field">
            <span className="field__label mono">
              NAME <span className="field__req">*</span>
            </span>
            <input className="field__input" value={values.name} onChange={set('name')} autoFocus />
          </label>
          <label className="field">
            <span className="field__label mono">
              EMAIL <span className="field__req">*</span>
            </span>
            <input className="field__input" value={values.email} onChange={set('email')} />
          </label>
          <label className="field">
            <span className="field__label mono">
              JOB TITLE <span className="field__req">*</span>
            </span>
            <input className="field__input" value={values.job_title} onChange={set('job_title')} />
          </label>
          <label className="field">
            <span className="field__label mono">
              DEPARTMENT <span className="field__req">*</span>
            </span>
            <select className="field__input" value={values.department_id} onChange={set('department_id')}>
              <option value="">— select —</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.code} · {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label mono">MANAGER</span>
            <select className="field__input" value={values.manager_id} onChange={set('manager_id')}>
              <option value="">— none (org chart root) —</option>
              {managers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} · {m.job_title}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label mono">
              START DATE <span className="field__req">*</span>
            </span>
            <input className="field__input" type="date" value={values.start_date} onChange={set('start_date')} />
          </label>
          <label className="field">
            <span className="field__label mono">PHONE</span>
            <input className="field__input" value={values.phone} onChange={set('phone')} />
          </label>
          <label className="field">
            <span className="field__label mono">LOCATION / OFFICE</span>
            <input className="field__input" value={values.location} onChange={set('location')} />
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
