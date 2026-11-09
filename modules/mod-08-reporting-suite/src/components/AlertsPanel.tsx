import { useCallback, useEffect, useState } from 'react';
import { api, errorText, type ReportAlert } from '../api';

/**
 * "Tell me when …" — a person's thresholds on this report's figure: the named
 * column of the first row, checked on every run, a push when it crosses
 * (server/alerts.ts). Anyone who may read the report may set their own.
 */
export function AlertsPanel({ reportId, columns }: { reportId: number; columns: string[] }) {
  const [alerts, setAlerts] = useState<ReportAlert[]>([]);
  const [column, setColumn] = useState(columns[0] ?? '');
  const [op, setOp] = useState<'above' | 'below'>('above');
  const [threshold, setThreshold] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setAlerts((await api.alerts(reportId)).alerts);
    } catch (err) {
      setError(errorText(err, 'Could not load your alerts'));
    }
  }, [reportId]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!columns.includes(column)) setColumn(columns[0] ?? '');
  }, [columns, column]);

  return (
    <div className="alerts">
      <div className="field__label mono">TELL ME WHEN THE FIRST ROW’S …</div>
      {error && <div className="resource__error mono">{error}</div>}
      <form
        className="alerts__form"
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          api
            .createAlert(reportId, { column, op, threshold: Number(threshold.replace(',', '.')) })
            .then(() => {
              setThreshold('');
              return load();
            })
            .catch((err) => setError(errorText(err, 'Could not save the alert')));
        }}
      >
        <select className="field__input" value={column} onChange={(e) => setColumn(e.target.value)} aria-label="Column">
          {columns.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select className="field__input" value={op} onChange={(e) => setOp(e.target.value as 'above' | 'below')} aria-label="Direction">
          <option value="above">goes above</option>
          <option value="below">goes below</option>
        </select>
        <input className="field__input" inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} placeholder="value" aria-label="Threshold" />
        <button className="btn mono" type="submit" disabled={!column || threshold.trim() === ''}>
          ADD
        </button>
      </form>
      {alerts.length > 0 && (
        <ul className="alerts__list mono">
          {alerts.map((a) => (
            <li key={a.id}>
              {a.column_name} {a.op} {a.threshold}{' '}
              <button className="btn btn--ghost mono" onClick={() => void api.deleteAlert(a.id).then(load).catch((err) => setError(errorText(err, 'Could not remove it')))}>
                REMOVE
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
