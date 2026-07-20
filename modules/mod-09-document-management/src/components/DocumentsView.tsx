import { useCallback, useEffect, useState } from 'react';
import type { DocumentSummary } from '../../shared/types';
import { api, ApiError } from '../api';
import { formatDate } from '../format';

interface Props {
  onOpen: (id: number) => void;
  onAuthLost: () => void;
}

export function DocumentsView({ onOpen, onAuthLost }: Props) {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { documents: docs } = await api.documents({
        search: search || undefined,
        tag: tag || undefined,
      });
      setDocuments(docs);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [search, tag, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void api.tags().then(({ tags: t }) => setTags(t)).catch(() => setTags([]));
  }, []);

  return (
    <>
      <div className="page__head">
        <div className="page__eyebrow mono">MOD-09 · ACROSS ALL YOUR MATTERS</div>
        <h1 className="page__title">All Documents</h1>
        <p className="page__desc">Every non-deleted document you can access. Filter by tag or search titles.</p>
      </div>

      {error && <div className="page__error mono">{error}</div>}

      <div className="toolbar">
        <input
          className="field__input toolbar__search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search titles…"
        />
        <select className="field__input toolbar__select" value={tag} onChange={(e) => setTag(e.target.value)}>
          <option value="">All tags</option>
          {tags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        {(search || tag) && (
          <button
            className="toolbar__clear mono"
            onClick={() => {
              setSearch('');
              setTag('');
            }}
          >
            CLEAR
          </button>
        )}
        <span className="toolbar__count mono">{loading ? '…' : `${documents.length} DOCS`}</span>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Matter</th>
              <th>Tags</th>
              <th className="table__num">Version</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {documents.length === 0 && (
              <tr>
                <td className="table__empty" colSpan={6}>
                  NO DOCUMENTS
                </td>
              </tr>
            )}
            {documents.map((d) => (
              <tr key={d.id} className="table__row-link" onClick={() => onOpen(d.id)}>
                <td>{d.title}</td>
                <td className="mono">{d.matter_key}</td>
                <td>
                  {d.tags.map((t) => (
                    <span key={t} className="tag mono">
                      {t}
                    </span>
                  ))}
                </td>
                <td className="table__num">v{d.current_version}</td>
                <td className="mono">{formatDate(d.updated_at)}</td>
                <td className="table__arrow">→</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
