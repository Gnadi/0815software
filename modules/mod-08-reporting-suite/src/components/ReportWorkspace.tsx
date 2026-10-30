import { useCallback, useEffect, useState } from 'react';
import type { ExportFormat, ParamValues, PivotConfig, PivotResult, QueryResult, Report } from '../../shared/types';
import { CHART_KINDS } from '../../shared/types';
import { api, ApiError, errorText, exportCsvUrl, exportXlsxUrl, missingRequired } from '../api';
import { pivotCell } from '../format';
import { ResultTable } from './ReportEditor';
import { ParamForm, describeValues, given } from './ParamForm';
import { Can } from '../access';

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
  const [runError, setRunError] = useState('');
  const [runMsg, setRunMsg] = useState('');
  const [format, setFormat] = useState<ExportFormat>('xlsx');
  // What the form says, and what the result on screen was run with.
  const [values, setValues] = useState<ParamValues>({});
  const [applied, setApplied] = useState<ParamValues>({});

  const run = useCallback(
    async (r: Report, v: ParamValues) => {
      setRunError('');
      setApplied(v);
      if (missingRequired(r.params, v).length > 0) {
        setResult(null);
        return;
      }
      try {
        setResult(await api.runReport(r.id, v));
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return onAuthLost();
        setResult(null);
        setRunError(errorText(err, 'Failed to run report'));
      }
    },
    [onAuthLost],
  );

  const load = useCallback(async () => {
    setError('');
    try {
      const r = await api.report(id);
      setReport(r);
      await run(r, {});
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      setError(errorText(err, 'Failed to load report'));
    }
  }, [id, onAuthLost, run]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runNow() {
    setRunMsg('');
    try {
      const r = await api.runNow(id, format, applied);
      setRunMsg(
        r.status === 'ok'
          ? `Export ok — ${r.row_count} rows → ${r.file_path}`
          : `Export failed: ${r.error}`,
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      setRunMsg(errorText(err, 'Run failed'));
    }
  }

  if (error) return <div className="resource__error mono">{error}</div>;
  if (!report) return <div className="boot mono">RUNNING…</div>;
  const missing = missingRequired(report.params, applied);

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
          <Can level="manage">
            <button className="btn btn--ghost" onClick={() => onEdit(report.id)}>
              EDIT SQL
            </button>
          </Can>
          <a className="btn btn--ghost" href={exportCsvUrl(report.id, applied)}>
            CSV
          </a>
          <a className="btn btn--ghost" href={exportXlsxUrl(report.id, applied)}>
            EXCEL
          </a>
          <Can>
            <select className="field__input" style={{ width: 90 }} value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)} aria-label="Export format">
              <option value="xlsx">xlsx</option>
              <option value="csv">csv</option>
            </select>
            <button className="btn btn--primary" onClick={() => void runNow()} disabled={missing.length > 0}>
              RUN EXPORT NOW
            </button>
          </Can>
        </div>
      </div>

      <ParamForm params={report.params} values={values} onChange={setValues}>
        <button className="btn btn--primary" onClick={() => void run(report, given(values))}>
          RUN
        </button>
      </ParamForm>

      {runMsg && <div className="resource__error mono" style={{ borderColor: 'var(--line-strong)', color: 'var(--fg-dim)' }}>{runMsg}</div>}

      <div className="tabs">
        {(['preview', 'pivot', 'chart'] as Tab[]).map((t) => (
          <button key={t} className={`tab ${tab === t ? 'is-active' : ''}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      {runError && <div className="resource__error mono">{runError}</div>}
      {!result && !runError && missing.length > 0 && (
        <div className="table-wrap">
          <div className="table__empty mono">
            FILL IN {missing.map((p) => p.label.toUpperCase()).join(', ')} AND RUN
          </div>
        </div>
      )}
      {result && tab === 'preview' && (
        <>
          <div className="section-title mono">
            {result.rows.length} ROWS · {result.elapsed_ms}MS{result.truncated ? ' · TRUNCATED' : ''}
          </div>
          <ResultTable result={result} />
        </>
      )}
      {result && tab === 'pivot' && <PivotBuilder reportId={report.id} result={result} values={applied} onAuthLost={onAuthLost} />}
      {result && tab === 'chart' && <ChartBuilder reportId={report.id} result={result} values={applied} onAuthLost={onAuthLost} />}
    </div>
  );
}

// ── Pivot builder ──────────────────────────────────────────────────────

function PivotBuilder({
  reportId,
  result,
  values,
  onAuthLost,
}: {
  reportId: number;
  result: QueryResult;
  values: ParamValues;
  onAuthLost: () => void;
}) {
  const cols = result.columns;
  const [row, setRow] = useState(cols[0] ?? '');
  const [col, setCol] = useState('');
  const [measure, setMeasure] = useState(cols[cols.length - 1] ?? '');
  const [aggregation, setAggregation] = useState('sum');
  const [pivot, setPivot] = useState<PivotResult | null>(null);
  const [built, setBuilt] = useState<PivotConfig | null>(null);
  const [error, setError] = useState('');

  async function build() {
    setError('');
    try {
      const config: PivotConfig = {
        row,
        col: col || null,
        measure: aggregation === 'count' && !measure ? '*' : measure,
        aggregation: aggregation as PivotConfig['aggregation'],
      };
      setPivot(await api.pivot(reportId, config, values));
      setBuilt(config);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      setPivot(null);
      setBuilt(null);
      setError(errorText(err, 'Pivot failed'));
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
        {built && (
          <a className="btn btn--ghost" href={exportXlsxUrl(reportId, values, built)} title="The result and this pivot, as two sheets">
            EXCEL WITH PIVOT
          </a>
        )}
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
  values,
  onAuthLost,
}: {
  reportId: number;
  result: QueryResult;
  values: ParamValues;
  onAuthLost: () => void;
}) {
  const cols = result.columns;
  const [kind, setKind] = useState<string>('bar');
  const [x, setX] = useState(cols[0] ?? '');
  const [y, setY] = useState(cols[cols.length - 1] ?? '');
  const [series, setSeries] = useState('');
  const [stacked, setStacked] = useState(false);
  const [name, setName] = useState('');
  const [svg, setSvg] = useState('');
  const [embed, setEmbed] = useState('');
  const [error, setError] = useState('');
  // A pie's slices are the x column; it has no series to split by.
  const config = () => ({ kind, x_column: x, y_column: y, series_column: kind === 'pie' ? null : series || null, stacked: kind !== 'pie' && kind !== 'line' && series !== '' && stacked });

  async function preview() {
    setError('');
    setEmbed('');
    try {
      setSvg(await api.chartPreview(reportId, { ...config(), params: values }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      setSvg('');
      setError(errorText(err, 'Chart preview failed'));
    }
  }

  async function save() {
    setError('');
    try {
      const chart = await api.createChart({
        report_id: reportId,
        name: name || `${kind} of ${y}`,
        ...config(),
        params: values,
      });
      const e = await api.chartEmbed(chart.id);
      setEmbed(`${window.location.origin}${e.path}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      setError(errorText(err, 'Save failed'));
    }
  }

  return (
    <div>
      <div className="builder">
        <label className="field">
          <span className="field__label mono">KIND</span>
          <select className="field__input" value={kind} onChange={(e) => setKind(e.target.value)}>
            {CHART_KINDS.map((k) => (
              <option key={k} value={k}>
                {k === 'pie' ? 'pie (donut)' : k}
              </option>
            ))}
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
        {kind !== 'pie' && (
          <label className="field">
            <span className="field__label mono">SERIES (ONE LINE / BAR PER VALUE)</span>
            <select className="field__input" value={series} onChange={(e) => setSeries(e.target.value)}>
              <option value="">(none)</option>
              {cols.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        )}
        {series !== '' && (kind === 'bar' || kind === 'area') && (
          <label className="field" style={{ minWidth: 0 }}>
            <span className="field__label mono">STACKED</span>
            <input type="checkbox" checked={stacked} onChange={(e) => setStacked(e.target.checked)} style={{ height: 38 }} />
          </label>
        )}
        <label className="field">
          <span className="field__label mono">CHART NAME</span>
          <input className="field__input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button className="btn btn--ghost" onClick={() => void preview()}>
          PREVIEW
        </button>
        <Can>
          <button className="btn btn--primary" onClick={() => void save()} disabled={!svg}>
            SAVE + EMBED
          </button>
        </Can>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      {Object.keys(values).length > 0 && (
        <p className="hint mono">Saved with these values — an embed always shows them: {describeValues(values)}</p>
      )}

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
