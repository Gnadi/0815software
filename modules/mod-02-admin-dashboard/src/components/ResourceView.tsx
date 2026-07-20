import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FieldDef, ResourceDef } from '../../shared/resources';
import { api, ApiError, exportUrl, type Row } from '../api';
import { RecordForm } from './RecordForm';

interface Props {
  resource: ResourceDef;
  onAuthLost: () => void;
}

type SortDir = 'asc' | 'desc';

const PAGE_SIZE = 25;

function formatCell(field: FieldDef, value: string | number | null): string {
  if (value === null || value === undefined || value === '') return '—';
  if (field.type === 'boolean') return value ? 'YES' : 'NO';
  if (field.type === 'number' && typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  return String(value);
}

export function ResourceView({ resource, onAuthLost }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState('id');
  const [dir, setDir] = useState<SortDir>('asc');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<Row | 'new' | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const tableFields = useMemo(() => resource.fields.filter((f) => !f.hideInTable), [resource]);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const queryParams = useCallback(
    (paged: boolean): URLSearchParams => {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      for (const [field, value] of Object.entries(filters)) {
        if (value !== '') params.set(`f_${field}`, value);
      }
      params.set('sort', sort);
      params.set('dir', dir);
      if (paged) {
        params.set('page', String(page));
        params.set('pageSize', String(PAGE_SIZE));
      }
      return params;
    },
    [search, filters, sort, dir, page],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.list(resource.name, queryParams(true));
      setRows(data.rows);
      setTotal(data.total);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [resource.name, queryParams, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  function resetAndReload() {
    setSelected(new Set());
    void load();
  }

  function toggleSort(field: string) {
    if (sort === field) setDir(dir === 'asc' ? 'desc' : 'asc');
    else {
      setSort(field);
      setDir('asc');
    }
    setPage(1);
  }

  function setFilter(field: string, value: string) {
    setFilters((prev) => ({ ...prev, [field]: value }));
    setPage(1);
  }

  function toggleRow(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === rows.length ? new Set<number>() : new Set(rows.map((r) => r.id)),
    );
  }

  async function guarded(action: () => Promise<unknown>) {
    try {
      await action();
      resetAndReload();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Action failed');
    }
  }

  const hasActiveFilters = search !== '' || Object.values(filters).some((v) => v !== '');

  return (
    <section className="resource">
      <header className="resource__head">
        <div>
          <div className="resource__eyebrow mono">RESOURCE · {resource.name.toUpperCase()}</div>
          <h1 className="resource__title">{resource.label}</h1>
          {resource.description && <p className="resource__desc">{resource.description}</p>}
        </div>
        <div className="resource__actions">
          <a className="btn btn--ghost" href={exportUrl(resource.name, queryParams(false))} download>
            EXPORT CSV ↓
          </a>
          <button className="btn btn--primary" onClick={() => setEditing('new')}>
            + NEW RECORD
          </button>
        </div>
      </header>

      <div className="toolbar">
        <input
          className="toolbar__search field__input"
          placeholder={`Search ${resource.label.toLowerCase()}…`}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        {hasActiveFilters && (
          <button
            className="toolbar__clear mono"
            onClick={() => {
              setSearch('');
              setFilters({});
              setPage(1);
            }}
          >
            CLEAR FILTERS ×
          </button>
        )}
        <div className="toolbar__count mono">
          {total} {total === 1 ? 'ROW' : 'ROWS'}
        </div>
      </div>

      {selected.size > 0 && (
        <div className="bulkbar">
          <span className="mono">{selected.size} SELECTED</span>
          <a
            className="bulkbar__btn mono"
            href={exportUrl(resource.name, new URLSearchParams({ ids: [...selected].join(',') }))}
            download
          >
            EXPORT SELECTED ↓
          </a>
          <button
            className="bulkbar__btn bulkbar__btn--danger mono"
            onClick={() => {
              if (window.confirm(`Delete ${selected.size} record(s)? This cannot be undone.`)) {
                void guarded(() => api.bulkDelete(resource.name, [...selected]));
              }
            }}
          >
            DELETE SELECTED ×
          </button>
        </div>
      )}

      {error && <div className="resource__error mono">{error}</div>}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="table__check">
                <input
                  type="checkbox"
                  checked={rows.length > 0 && selected.size === rows.length}
                  onChange={toggleAll}
                  aria-label="Select all rows"
                />
              </th>
              <th className="mono table__sortable" onClick={() => toggleSort('id')}>
                ID {sort === 'id' ? (dir === 'asc' ? '↑' : '↓') : ''}
              </th>
              {tableFields.map((f) => (
                <th key={f.name} className="mono table__sortable" onClick={() => toggleSort(f.name)}>
                  {f.label.toUpperCase()} {sort === f.name ? (dir === 'asc' ? '↑' : '↓') : ''}
                </th>
              ))}
              <th className="mono">ACTIONS</th>
            </tr>
            <tr className="table__filters">
              <th />
              <th />
              {tableFields.map((f) => (
                <th key={f.name}>
                  {f.type === 'select' && f.options ? (
                    <select
                      className="table__filter"
                      value={filters[f.name] ?? ''}
                      onChange={(e) => setFilter(f.name, e.target.value)}
                    >
                      <option value="">all</option>
                      {f.options.map((opt) => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </select>
                  ) : f.type === 'boolean' ? (
                    <select
                      className="table__filter"
                      value={filters[f.name] ?? ''}
                      onChange={(e) => setFilter(f.name, e.target.value)}
                    >
                      <option value="">all</option>
                      <option value="true">yes</option>
                      <option value="false">no</option>
                    </select>
                  ) : (
                    <input
                      className="table__filter"
                      placeholder="filter"
                      value={filters[f.name] ?? ''}
                      onChange={(e) => setFilter(f.name, e.target.value)}
                    />
                  )}
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={selected.has(row.id) ? 'is-selected' : ''}>
                <td className="table__check">
                  <input
                    type="checkbox"
                    checked={selected.has(row.id)}
                    onChange={() => toggleRow(row.id)}
                    aria-label={`Select row ${row.id}`}
                  />
                </td>
                <td className="mono table__id">{row.id}</td>
                {tableFields.map((f) => (
                  <td key={f.name} className={f.type === 'number' ? 'table__num' : ''}>
                    {formatCell(f, row[f.name] ?? null)}
                  </td>
                ))}
                <td className="table__rowactions">
                  <button className="rowbtn mono" onClick={() => setEditing(row)}>
                    EDIT
                  </button>
                  <button
                    className="rowbtn rowbtn--danger mono"
                    onClick={() => {
                      if (window.confirm(`Delete record #${row.id}?`)) {
                        void guarded(() => api.remove(resource.name, row.id));
                      }
                    }}
                  >
                    DEL
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr>
                <td className="table__empty mono" colSpan={tableFields.length + 3}>
                  NO ROWS{hasActiveFilters ? ' MATCH THE CURRENT FILTERS' : ''}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <footer className="pager">
        <button
          className="pager__btn mono"
          disabled={page <= 1}
          onClick={() => setPage((p) => p - 1)}
        >
          ← PREV
        </button>
        <span className="pager__info mono">
          PAGE {page} / {pageCount}
        </span>
        <button
          className="pager__btn mono"
          disabled={page >= pageCount}
          onClick={() => setPage((p) => p + 1)}
        >
          NEXT →
        </button>
      </footer>

      {editing && (
        <RecordForm
          resource={resource}
          record={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            resetAndReload();
          }}
          onAuthLost={onAuthLost}
        />
      )}
    </section>
  );
}
