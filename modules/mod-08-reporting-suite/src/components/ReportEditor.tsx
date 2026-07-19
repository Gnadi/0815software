import { useCallback, useEffect, useState } from 'react';
import type { QueryResult } from '../../shared/types';
import { api, ApiError, type SourceSchema } from '../api';
import { cell } from '../format';

interface Props {
  id: number | null;
  onDone: (id: number | null) => void;
  onAuthLost: () => void;
}

export function ReportEditor({ id, onDone, onAuthLost }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [sql, setSql] = useState('SELECT * FROM orders LIMIT 50');
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
      setPreview(await api.preview(sql));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      setPreview(null);
      setError(err instanceof Error ? err.message : 'Preview failed');
    }
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      const values = { name, description, sql };
      const saved = id === null ? await api.createReport(values) : await api.updateReport(id, values);
      onDone(saved.id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      setError(err instanceof Error ? err.message : 'Save failed');
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
          {schema ? schema.policy.max_rows.toLocaleString('en-US') : '10,000'} rows.
        </p>

        {schema && (
          <div className="schema">
            {schema.tables.map((t) => (
              <div className="schema__table" key={t.table}>
                <span className="schema__name">{t.table}</span> ({t.columns.join(', ')})
              </div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
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
