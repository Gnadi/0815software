import { useCallback, useEffect, useState } from 'react';
import type { Report } from '../../shared/types';
import { api, ApiError, exportCsvUrl } from '../api';

interface Props {
  onOpen: (id: number) => void;
  onNew: () => void;
  onEdit: (id: number) => void;
  onAuthLost: () => void;
}

export function ReportsView({ onOpen, onNew, onEdit, onAuthLost }: Props) {
  const [reports, setReports] = useState<Report[]>([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const { reports } = await api.reports(search);
      setReports(reports);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      setError(err instanceof Error ? err.message : 'Failed to load reports');
    }
  }, [search, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(id: number) {
    if (!confirm('Delete this report? Its charts, schedule and run history go with it.')) return;
    try {
      await api.deleteReport(id);
      void load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">SAVED REPORTS</div>
          <h1 className="resource__title">Reports</h1>
          <p className="resource__desc">
            A report is a name and a read-only SQL SELECT over your source database. Open one to
            preview, pivot, chart or export it.
          </p>
        </div>
        <div className="resource__actions">
          <button className="btn btn--primary" onClick={onNew}>
            NEW REPORT +
          </button>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="toolbar">
        <input
          className="field__input toolbar__search"
          placeholder="Search reports…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="toolbar__count mono">{reports.length} REPORTS</span>
      </div>

      {reports.length === 0 ? (
        <div className="table-wrap">
          <div className="table__empty mono">NO REPORTS YET</div>
        </div>
      ) : (
        <div className="cardlist">
          {reports.map((r) => (
            <div className="reportcard" key={r.id}>
              <div>
                <button className="reportcard__name linklike" onClick={() => onOpen(r.id)}>
                  {r.name}
                </button>
                <div className="reportcard__desc">{r.description ?? 'No description'}</div>
              </div>
              <div className="reportcard__actions">
                <button className="rowbtn" onClick={() => onOpen(r.id)}>
                  OPEN
                </button>
                <button className="rowbtn" onClick={() => onEdit(r.id)}>
                  EDIT
                </button>
                <a className="rowbtn" href={exportCsvUrl(r.id)}>
                  CSV
                </a>
                <button className="rowbtn rowbtn--danger" onClick={() => void remove(r.id)}>
                  DELETE
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
