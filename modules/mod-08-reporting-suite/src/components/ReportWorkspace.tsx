import { useCallback, useEffect, useState } from 'react';
import type { PivotResult, QueryResult, Report } from '../../shared/types';
import { api, ApiError, exportCsvUrl } from '../api';
import { pivotCell } from '../format';
import { ResultTable } from './ReportEditor';

type Tab = 'preview' | 'pivot' | 'chart';

interface Props {
  id: number;
  onBack: () => void;
  onEdit: (id: number) => void;
  onAuthLost: () => void;
}

export function ReportWorkspace({ id, onBack, onEdit, onAuthLost }: Props) {
  const [report, setReport] = useState<Report | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [tab, setTab] = useState<Tab>('preview');
  const [error, setError] = useState('');
  const [runMsg, setRunMsg] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const r = await api.report(id);
      setReport(r);
      setResult(await api.runReport(id));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      setError(err instanceof Error ? err.message : 'Failed to run report');
    }
  }, [id, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runNow() {
    setRunMsg('');
    try {
      const run = await api.runNow(id);
      setRunMsg(
        run.status === 'ok'
          ? `Export ok — ${run.row_count} rows → ${run.file_path}`
          : `Export failed: ${run.error}`,
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      setRunMsg(err instanceof Error ? err.message : 'Run failed');
    }
  }

  if (error) return <div className="resource__error mono">{error}</div>;
  if (!report || !result) return <div className="boot mono">RUNNING…</div>;

  return (
    <div>
      <button className="backlink mono" onClick={onBack}>
        ← ALL REPORTS
      </button>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">REPORT #{report.id}</div>
          <h1 className="resource__title">{report.name}</h1>
          {report.description && <p className="resource__desc">{report.description}</p>}
        </div>
        <div className="resource__actions">
          <button className="btn btn--ghost" onClick={() => onEdit(report.id)}>
            EDIT SQL
          </button>
          <a className="btn btn--ghost" href={exportCsvUrl(report.id)}>
            DOWNLOAD CSV
          </a>
          <button className="btn btn--primary" onClick={() => void runNow()}>
            RUN EXPORT NOW
          </button>
        </div>
      </div>

      {runMsg && <div className="resource__error mono" style={{ borderColor: 'var(--line-strong)', color: 'var(--fg-dim)' }}>{runMsg}</div>}

      <div className="tabs">
        {(['preview', 'pivot', 'chart'] as Tab[]).map((t) => (
          <button key={t} className={`tab ${tab === t ? 'is-active' : ''}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      {tab === 'preview' && (
        <>
          <div className="section-title mono">
            {result.rows.length} ROWS · {result.elapsed_ms}MS{result.truncated ? ' · TRUNCATED' : ''}
          </div>
          <ResultTable result={result} />
        </>
      )}
      {tab === 'pivot' && <PivotBuilder reportId={report.id} result={result} onAuthLost={onAuthLost} />}
      {tab === 'chart' && <ChartBuilder reportId={report.id} result={result} onAuthLost={onAuthLost} />}
    </div>
  );
}

// ── Pivot builder ──────────────────────────────────────────────────────

function PivotBuilder({
  reportId,
  result,
  onAuthLost,
}: {
  reportId: number;
  result: QueryResult;
  onAuthLost: () => void;
}) {
  const cols = result.columns;
  const [row, setRow] = useState(cols[0] ?? '');
  const [col, setCol] = useState('');
  const [measure, setMeasure] = useState(cols[cols.length - 1] ?? '');
  const [aggregation, setAggregation] = useState('sum');
  const [pivot, setPivot] = useState<PivotResult | null>(null);
  const [error, setError] = useState('');

  async function build() {
    setError('');
    try {
      const config = {
        row,
        col: col || null,
        measure: aggregation === 'count' && !measure ? '*' : measure,
        aggregation,
      };
      setPivot(await api.pivot(reportId, config));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      setPivot(null);
      setError(err instanceof Error ? err.message : 'Pivot failed');
    }
  }

  return (
    <div>
      <div className="builder">
        <label className="field">
          <span className="field__label mono">ROW DIMENSION</span>
          <select className="field__input" value={row} onChange={(e) => setRow(e.target.value)}>
            {cols.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label mono">COLUMN DIMENSION</span>
          <select className="field__input" value={col} onChange={(e) => setCol(e.target.value)}>
            <option value="">(none)</option>
            {cols.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label mono">MEASURE</span>
          <select className="field__input" value={measure} onChange={(e) => setMeasure(e.target.value)}>
            {aggregation === 'count' && <option value="*">* (rows)</option>}
            {cols.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label mono">AGGREGATION</span>
          <select
            className="field__input"
            value={aggregation}
            onChange={(e) => setAggregation(e.target.value)}
          >
            {['sum', 'count', 'avg', 'min', 'max'].map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn--primary" onClick={() => void build()}>
          BUILD PIVOT
        </button>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      {pivot && (
        <div className="table-wrap result-scroll">
          <table className="table pivot">
            <thead>
              <tr>
                <th className="pivot__corner pivot__rowhead">{row}</th>
                {pivot.columns.map((c) => (
                  <th key={c} className="table__num">
                    {c}
                  </th>
                ))}
                {!pivot.flat && <th className="table__num is-total">Total</th>}
              </tr>
            </thead>
            <tbody>
              {pivot.rows.map((r) => (
                <tr key={r.key}>
                  <td className="pivot__rowhead">{r.key}</td>
                  {r.values.map((v, i) => (
                    <td key={i} className={`table__num ${v === null ? 'is-empty' : ''}`}>
                      {pivotCell(v)}
                    </td>
                  ))}
                  {!pivot.flat && <td className="table__num is-total">{pivotCell(r.total)}</td>}
                </tr>
              ))}
              <tr>
                <td className="pivot__rowhead is-total">Total</td>
                {pivot.columnTotals.map((v, i) => (
                  <td key={i} className="table__num is-total">
                    {pivotCell(v)}
                  </td>
                ))}
                {!pivot.flat && <td className="table__num is-total">{pivotCell(pivot.grandTotal)}</td>}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Chart builder ──────────────────────────────────────────────────────

function ChartBuilder({
  reportId,
  result,
  onAuthLost,
}: {
  reportId: number;
  result: QueryResult;
  onAuthLost: () => void;
}) {
  const cols = result.columns;
  const [kind, setKind] = useState('bar');
  const [x, setX] = useState(cols[0] ?? '');
  const [y, setY] = useState(cols[cols.length - 1] ?? '');
  const [name, setName] = useState('');
  const [svg, setSvg] = useState('');
  const [embed, setEmbed] = useState('');
  const [error, setError] = useState('');

  async function preview() {
    setError('');
    setEmbed('');
    try {
      setSvg(await api.chartPreview(reportId, { kind, x_column: x, y_column: y }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      setSvg('');
      setError(err instanceof Error ? err.message : 'Chart preview failed');
    }
  }

  async function save() {
    setError('');
    try {
      const chart = await api.createChart({
        report_id: reportId,
        name: name || `${kind} of ${y}`,
        kind,
        x_column: x,
        y_column: y,
      });
      const e = await api.chartEmbed(chart.id);
      setEmbed(`${window.location.origin}${e.path}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      setError(err instanceof Error ? err.message : 'Save failed');
    }
  }

  return (
    <div>
      <div className="builder">
        <label className="field">
          <span className="field__label mono">KIND</span>
          <select className="field__input" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="bar">bar</option>
            <option value="line">line</option>
          </select>
        </label>
        <label className="field">
          <span className="field__label mono">X COLUMN</span>
          <select className="field__input" value={x} onChange={(e) => setX(e.target.value)}>
            {cols.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label mono">Y COLUMN</span>
          <select className="field__input" value={y} onChange={(e) => setY(e.target.value)}>
            {cols.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label mono">CHART NAME</span>
          <input className="field__input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button className="btn btn--ghost" onClick={() => void preview()}>
          PREVIEW
        </button>
        <button className="btn btn--primary" onClick={() => void save()} disabled={!svg}>
          SAVE + EMBED
        </button>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      {svg && <div className="chart-panel" dangerouslySetInnerHTML={{ __html: svg }} />}

      {embed && (
        <div className="embed-box">
          <span className="embed-box__label mono">EMBED URL — RENDERS WITHOUT A SESSION</span>
          <div className="embed-box__row">
            <span className="embed-box__url">{embed}</span>
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => void navigator.clipboard?.writeText(embed)}
            >
              COPY
            </button>
          </div>
          <span className="embed-box__code">
            {`<iframe src="${embed}" width="720" height="360" frameborder="0"></iframe>`}
          </span>
        </div>
      )}
    </div>
  );
}
