import { useState, type FormEvent } from 'react';
import type { FieldDef, ResourceDef } from '../../shared/resources';
import { api, ApiError, type Row } from '../api';

interface Props {
  resource: ResourceDef;
  /** null → create form, otherwise edit the given record. */
  record: Row | null;
  onClose: () => void;
  onSaved: () => void;
  onAuthLost: () => void;
}

function initialValue(field: FieldDef, record: Row | null): string {
  const raw = record?.[field.name];
  if (raw === null || raw === undefined) return '';
  if (field.type === 'boolean') return raw ? 'true' : 'false';
  return String(raw);
}

export function RecordForm({ resource, record, onClose, onSaved, onAuthLost }: Props) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(resource.fields.map((f) => [f.name, initialValue(f, record)])),
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function set(name: string, value: string) {
    setValues((prev) => ({ ...prev, [name]: value }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setFieldErrors({});

    const payload: Record<string, unknown> = {};
    for (const field of resource.fields) {
      const raw = values[field.name] ?? '';
      if (raw === '') payload[field.name] = null;
      else if (field.type === 'number') payload[field.name] = Number(raw);
      else if (field.type === 'boolean') payload[field.name] = raw === 'true';
      else payload[field.name] = raw;
    }

    try {
      if (record) await api.update(resource.name, record.id, payload);
      else await api.create(resource.name, payload);
      onSaved();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          onAuthLost();
          return;
        }
        setFieldErrors(Object.fromEntries(err.details.map((d) => [d.field, d.message])));
        setError(err.details.length > 0 ? '' : err.message);
      } else {
        setError('Request failed');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal" role="dialog" aria-modal="true">
      <div className="modal__backdrop" onClick={onClose} />
      <form className="modal__card" onSubmit={(e) => void submit(e)}>
        <div className="modal__eyebrow mono">
          {record ? `EDIT · ${resource.name.toUpperCase()} #${record.id}` : `NEW · ${resource.name.toUpperCase()}`}
        </div>
        <h2 className="modal__title">{record ? 'Edit record' : 'Create record'}</h2>

        <div className="modal__fields">
          {resource.fields.map((field) => (
            <label key={field.name} className="field">
              <span className="field__label mono">
                {field.label.toUpperCase()}
                {field.required && <span className="field__req"> *</span>}
              </span>
              {field.type === 'select' && field.options ? (
                <select
                  className="field__input"
                  value={values[field.name]}
                  onChange={(e) => set(field.name, e.target.value)}
                >
                  <option value="">—</option>
                  {field.options.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              ) : field.type === 'boolean' ? (
                <select
                  className="field__input"
                  value={values[field.name]}
                  onChange={(e) => set(field.name, e.target.value)}
                >
                  <option value="">—</option>
                  <option value="true">yes</option>
                  <option value="false">no</option>
                </select>
              ) : (
                <input
                  className="field__input"
                  type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                  step={field.type === 'number' ? 'any' : undefined}
                  value={values[field.name]}
                  onChange={(e) => set(field.name, e.target.value)}
                />
              )}
              {fieldErrors[field.name] && (
                <span className="field__error mono">{fieldErrors[field.name]}</span>
              )}
            </label>
          ))}
        </div>

        {error && <div className="modal__error mono">{error}</div>}

        <div className="modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            CANCEL
          </button>
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? 'SAVING…' : record ? 'SAVE CHANGES' : 'CREATE →'}
          </button>
        </div>
      </form>
    </div>
  );
}
