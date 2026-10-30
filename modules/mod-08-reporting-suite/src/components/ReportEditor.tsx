import { useCallback, useEffect, useState } from 'react';
import type { ParamType, ParamValues, QueryResult, ReportParam } from '../../shared/types';
import { PARAM_TYPES } from '../../shared/types';
import { api, ApiError, errorText, type SourceSchema } from '../api';
import { cell } from '../format';
import { DateValueInput, ParamForm, given } from './ParamForm';

/** A parameter as the editor holds it: choices as one comma-separated line. */
interface DraftParam {
  name: string;
  label: string;
  type: ParamType;
  required: boolean;
  default: string;
  choices: string;
}

const toDraft = (p: ReportParam): DraftParam => ({ ...p, default: p.default ?? '', choices: p.choices.join(', ') });

const fromDraft = (d: DraftParam): ReportParam => ({
  name: d.name.trim(),
  label: d.label.trim() || d.name.trim(),
  type: d.type,
  required: d.required,
  default: d.default.trim() === '' ? null : d.default.trim(),
  choices: d.type === 'choice' ? d.choices.split(',').map((c) => c.trim()).filter(Boolean) : [],
});

/**
 * The `:names` the SQL seems to use — a convenience for the author; the
 * server reads the SQL properly (literals and comments aside) when saving.
 */
function namesIn(sql: string): string[] {
  const code = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ' ');
  return [...new Set([...code.matchAll(/(?<![A-Za-z0-9_$:]):([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!))];
}

interface Props {
  id: number | null;
  onDone: (id: number | null) => void;
  onAuthLost: () => void;
}

export function ReportEditor({ id, onDone, onAuthLost }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [sql, setSql] = useState('SELECT * FROM orders LIMIT 50');
  const [params, setParams] = useState<DraftParam[]>([]);
  const [values, setValues] = useState<ParamValues>({});
  const [schema, setSchema] = useState<SourceSchema | null>(null);
  const [preview, setPreview] = useState<QueryResult | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setSchema(await api.source());
      if (id !== null) {
        const r = await api.report(id);
        setName(r.name);
        setDescription(r.description ?? '');
        setSql(r.sql);
        setParams(r.params.map(toDraft));
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, [id, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runPreview() {
    setError('');
    try {
      setPreview(await api.preview(sql, params.map(fromDraft), given(values)));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      setPreview(null);
      setError(errorText(err, 'Preview failed'));
    }
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      const report = { name, description, sql, params: params.map(fromDraft) };
      const saved = id === null ? await api.createReport(report) : await api.updateReport(id, report);
      onDone(saved.id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      setError(errorText(err, 'Save failed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <button className="backlink mono" onClick={() => onDone(id)}>
        ← BACK
      </button>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">{id === null ? 'NEW' : 'EDIT'} REPORT</div>
          <h1 className="resource__title">{id === null ? 'New report' : name || 'Edit report'}</h1>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="editor">
        <label className="field">
          <span className="field__label mono">NAME</span>
          <input className="field__input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field" style={{ marginTop: 14 }}>
          <span className="field__label mono">DESCRIPTION</span>
          <input
            className="field__input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label className="field" style={{ marginTop: 14 }}>
          <span className="field__label mono">SQL — SELECT ONLY</span>
          <textarea
            className="field__input sql-input"
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            spellCheck={false}
          />
        </label>
        <p className="hint mono">
          Read-only. Single statement, must start with SELECT or WITH. Row cap{' '}
          {schema ? schema.policy.max_rows.toLocaleString('en-US') : '10,000'} rows. Parameters
          are written :name — e.g. WHERE order_date BETWEEN :from AND :to — and bound, never
          pasted into the SQL. An optional one is NULL when left empty: (:region IS NULL OR
          region = :region).
        </p>

        <ParamEditor sql={sql} params={params} onChange={setParams} />

        {schema && (
          <div className="schema">
            {schema.tables.map((t) => (
              <div className="schema__table" key={t.table}>
                <span className="schema__name">{t.table}</span> ({t.columns.join(', ')})
              </div>
            ))}
          </div>
        )}

        <div style={{ marginTop: 16 }}>
          <ParamForm params={params.filter((p) => p.name.trim() !== '').map(fromDraft)} values={values} onChange={setValues} />
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn--ghost" onClick={() => void runPreview()}>
            RUN PREVIEW
          </button>
        </div>

        {preview && (
          <>
            <div className="section-title mono">
              PREVIEW · {preview.rows.length} ROWS · {preview.elapsed_ms}MS
              {preview.truncated ? ' · TRUNCATED' : ''}
            </div>
            <ResultTable result={preview} />
          </>
        )}

        <div className="editor__actions">
          <button className="btn btn--ghost" onClick={() => onDone(id)}>
            CANCEL
          </button>
          <button className="btn btn--primary" onClick={() => void save()} disabled={saving}>
            {saving ? 'SAVING…' : 'SAVE REPORT'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ParamEditor({ sql, params, onChange }: { sql: string; params: DraftParam[]; onChange: (p: DraftParam[]) => void }) {
  const set = (i: number, patch: Partial<DraftParam>) => onChange(params.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const blank = (name = ''): DraftParam => ({ name, label: '', type: 'text', required: false, default: '', choices: '' });
  const undeclared = namesIn(sql).filter((n) => !params.some((p) => p.name.trim() === n));
  return (
    <div style={{ marginTop: 14 }}>
      <div className="section-title mono">PARAMETERS · {params.length}</div>
      {params.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>:name</th>
                <th>Label</th>
                <th>Type</th>
                <th>Required</th>
                <th>Default</th>
                <th>Choices</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {params.map((p, i) => (
                <tr key={i}>
                  <td>
                    <input className="field__input mono" style={{ minWidth: 100 }} value={p.name} onChange={(e) => set(i, { name: e.target.value })} />
                  </td>
                  <td>
                    <input className="field__input" style={{ minWidth: 100 }} value={p.label} placeholder={p.name} onChange={(e) => set(i, { label: e.target.value })} />
                  </td>
                  <td>
                    <select className="field__input" style={{ minWidth: 100 }} value={p.type} onChange={(e) => set(i, { type: e.target.value as ParamType, default: '' })}>
                      {PARAM_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input type="checkbox" checked={p.required} onChange={(e) => set(i, { required: e.target.checked })} />
                  </td>
                  <td style={{ minWidth: 290 }}>
                    {p.type === 'date' ? (
                      <DateValueInput value={p.default} onChange={(v) => set(i, { default: v })} />
                    ) : p.type === 'choice' ? (
                      <select className="field__input" value={p.default} onChange={(e) => set(i, { default: e.target.value })}>
                        <option value="">—</option>
                        {fromDraft(p).choices.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input className="field__input" value={p.default} onChange={(e) => set(i, { default: e.target.value })} />
                    )}
                  </td>
                  <td>
                    {p.type === 'choice' ? (
                      <input className="field__input" style={{ minWidth: 140 }} placeholder="North, South, East" value={p.choices} onChange={(e) => set(i, { choices: e.target.value })} />
                    ) : (
                      <span className="mono" style={{ color: 'var(--fg-mute)' }}>
                        —
                      </span>
                    )}
                  </td>
                  <td className="table__rowactions">
                    <button className="rowbtn rowbtn--danger" title="Remove" aria-label={`Remove :${p.name}`} onClick={() => onChange(params.filter((_, j) => j !== i))}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="chips">
        <button className="chip" onClick={() => onChange([...params, blank()])}>
          + PARAMETER
        </button>
        {undeclared.map((n) => (
          <button key={n} className="chip" onClick={() => onChange([...params, blank(n)])}>
            + DECLARE :{n}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ResultTable({ result }: { result: QueryResult }) {
  if (result.columns.length === 0) {
    return (
      <div className="table-wrap">
        <div className="table__empty mono">NO COLUMNS</div>
      </div>
    );
  }
  return (
    <div className="table-wrap result-scroll">
      <table className="table">
        <thead>
          <tr>
            {result.columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.length === 0 ? (
            <tr>
              <td className="table__empty mono" colSpan={result.columns.length}>
                NO ROWS
              </td>
            </tr>
          ) : (
            result.rows.slice(0, 500).map((row, i) => (
              <tr key={i}>
                {result.columns.map((c) => (
                  <td key={c} className={typeof row[c] === 'number' ? 'table__num' : ''}>
                    {cell(row[c])}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
