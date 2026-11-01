import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { formatBytes, type Disposal, type DueDocument, type RetentionClass } from '../../shared/types';
import { api, ApiError, errorText } from '../api';
import { formatDateTime } from '../format';

interface Props {
  onOpenDocument: (id: number) => void;
  onAuthLost: () => void;
}

type Preset = { name: string; years: number; basis: string };

/**
 * Retention for administrators: the classes and the law behind them, the
 * documents whose period has ended, and the record of what was destroyed.
 * Disposal happens here, one document at a time, confirmed — never on its own.
 */
export function RetentionView({ onOpenDocument, onAuthLost }: Props) {
  const [classes, setClasses] = useState<RetentionClass[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [due, setDue] = useState<DueDocument[]>([]);
  const [disposals, setDisposals] = useState<Disposal[]>([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [c, d, x] = await Promise.all([api.retentionClasses(), api.due(), api.disposals()]);
      setClasses(c.classes);
      setPresets(c.presets);
      setDue(d.documents);
      setDisposals(x.disposals);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(errorText(err, 'Failed to load'));
    }
  }, [onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>) {
    setError('');
    try {
      await action();
      await load();
    } catch (err) {
      setError(errorText(err, 'Failed'));
    }
  }

  async function dispose(d: DueDocument) {
    const typed = window.prompt(
      `Dispose of "${d.title}" (${d.matter_key})?\n\nAll ${d.version_count} version(s) and their files are destroyed for good. Kept until ${d.retention_end} under ${d.class_name}.\n\nType DISPOSE to confirm.`,
    );
    if (typed !== 'DISPOSE') return;
    await run(() => api.dispose(d.id));
  }

  const missing = presets.filter((p) => !classes.some((c) => c.name === p.name));

  return (
    <>
      <div className="page__head">
        <div className="page__eyebrow mono">MOD-09 · ADMINISTRATION</div>
        <h1 className="page__title">Retention</h1>
        <p className="page__desc">
          How long documents must be kept, and disposing of them once that has passed. A period starts at the end of the calendar
          year of the document's date (BAO § 132, UGB § 212, HGB § 257, AO § 147). A legal hold keeps a document whatever the date
          says. Nothing is disposed of automatically.
        </p>
      </div>

      {error && <div className="page__error mono">{error}</div>}

      <h2 className="detail__heading mono">DUE FOR DISPOSAL ({due.length})</h2>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Document</th>
              <th>Class</th>
              <th>Dated</th>
              <th>Kept until</th>
              <th className="table__num">Versions</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {due.length === 0 && (
              <tr>
                <td className="table__empty" colSpan={6}>
                  NOTHING IS DUE
                </td>
              </tr>
            )}
            {due.map((d) => (
              <tr key={d.id}>
                <td>
                  {d.deleted ? d.title : <button className="linklike" onClick={() => onOpenDocument(d.id)}>{d.title}</button>}
                  <div className="detail__hint">
                    {d.matter_key}
                    {d.deleted && ' · deleted, bytes still kept'}
                  </div>
                </td>
                <td className="table__wrap">
                  {d.class_name}
                  <div className="detail__hint">{d.basis}</div>
                </td>
                <td className="mono">{d.document_date}</td>
                <td className="mono">{d.retention_end}</td>
                <td className="table__num">
                  {d.version_count} · {formatBytes(d.size_bytes)}
                </td>
                <td>
                  <button className="btn btn--danger" onClick={() => void dispose(d)}>
                    DISPOSE
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="detail__heading mono">CLASSES ({classes.length})</h2>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th className="table__num">Years</th>
              <th>Legal basis</th>
              <th className="table__num">Documents</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {classes.map((c) => (
              <ClassRow key={c.id} cls={c} onSave={(input) => run(() => api.updateRetentionClass(c.id, input))} onDelete={() => run(() => api.deleteRetentionClass(c.id))} />
            ))}
          </tbody>
        </table>
      </div>
      <NewClass onCreate={(input) => run(() => api.createRetentionClass(input))} />
      {missing.length > 0 && (
        <div className="card">
          <span className="field__label mono">PRESETS — CHECK THEM AGAINST YOUR OWN OBLIGATIONS</span>
          {missing.map((p) => (
            <div key={p.name} className="formrow">
              <span className="field--grow">
                {p.name} · {p.years} years
                <div className="detail__hint">{p.basis}</div>
              </span>
              <button className="btn btn--ghost" onClick={() => void run(() => api.createRetentionClass(p))}>
                ADD
              </button>
            </div>
          ))}
        </div>
      )}

      <h2 className="detail__heading mono">DISPOSED ({disposals.length})</h2>
      <div className="table-wrap">
        <table className="table table--tight">
          <thead>
            <tr>
              <th>When</th>
              <th>By</th>
              <th>Document</th>
              <th>Under</th>
              <th className="table__num">Versions</th>
              <th>Copies elsewhere</th>
            </tr>
          </thead>
          <tbody>
            {disposals.length === 0 && (
              <tr>
                <td className="table__empty" colSpan={6}>
                  NOTHING DISPOSED YET
                </td>
              </tr>
            )}
            {disposals.map((x) => (
              <tr key={x.id}>
                <td className="mono">{formatDateTime(x.disposed_at)}</td>
                <td>{x.disposed_by_name}</td>
                <td className="mono">
                  #{x.document_id} · {x.matter_key}
                </td>
                <td>
                  {x.retention_class} · kept until {x.retention_end}
                </td>
                <td className="table__num">
                  {x.versions} · {formatBytes(x.bytes)}
                </td>
                <td className="mono">
                  {Object.entries(x.mirrors)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(' · ') || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ClassRow({ cls, onSave, onDelete }: { cls: RetentionClass; onSave: (input: Record<string, unknown>) => Promise<void>; onDelete: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(cls.name);
  const [years, setYears] = useState(String(cls.years));
  const [basis, setBasis] = useState(cls.basis);
  if (!editing) {
    return (
      <tr>
        <td>{cls.name}</td>
        <td className="table__num">{cls.years}</td>
        <td className="table__wrap">{cls.basis}</td>
        <td className="table__num">{cls.document_count}</td>
        <td className="table__actions">
          <button className="rowbtn" onClick={() => setEditing(true)}>
            EDIT
          </button>
          {cls.document_count === 0 && (
            <button className="rowbtn" onClick={() => void onDelete()}>
              DELETE
            </button>
          )}
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <td>
        <input className="field__input" value={name} onChange={(e) => setName(e.target.value)} />
      </td>
      <td>
        <input className="field__input" type="number" min={1} max={100} value={years} onChange={(e) => setYears(e.target.value)} />
      </td>
      <td>
        <input className="field__input" value={basis} onChange={(e) => setBasis(e.target.value)} />
      </td>
      <td className="table__num">{cls.document_count}</td>
      <td className="table__actions">
        <button className="rowbtn" onClick={() => void onSave({ name, years: Number(years), basis }).then(() => setEditing(false))}>
          SAVE
        </button>
        <button className="rowbtn" onClick={() => setEditing(false)}>
          CANCEL
        </button>
      </td>
    </tr>
  );
}

function NewClass({ onCreate }: { onCreate: (input: Record<string, unknown>) => Promise<void> }) {
  const [name, setName] = useState('');
  const [years, setYears] = useState('');
  const [basis, setBasis] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    await onCreate({ name, years: Number(years), basis });
    setName('');
    setYears('');
    setBasis('');
  }
  return (
    <form className="card card--form formrow" onSubmit={(e) => void submit(e)}>
      <label className="field field--grow">
        <span className="field__label mono">NEW CLASS</span>
        <input className="field__input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Employment records" />
      </label>
      <label className="field">
        <span className="field__label mono">YEARS</span>
        <input className="field__input" type="number" min={1} max={100} value={years} onChange={(e) => setYears(e.target.value)} />
      </label>
      <label className="field field--grow">
        <span className="field__label mono">LEGAL BASIS</span>
        <input className="field__input" value={basis} onChange={(e) => setBasis(e.target.value)} placeholder="the law that requires it" />
      </label>
      <button className="btn btn--primary" type="submit" disabled={!name.trim() || !years}>
        ADD
      </button>
    </form>
  );
}
