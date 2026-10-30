import type { ReactNode } from 'react';
import type { ParamValues, ReportParam } from '../../shared/types';
import { RELATIVE_DATES } from '../../shared/types';

/**
 * Values for a report's parameters. An empty field means "the default"; a
 * date can be fixed or relative ("start of last month"), and a relative one
 * is resolved by the server when the report runs — so a schedule or a chart
 * saved with it keeps meaning "last month" next month.
 */

const RELATIVE_LABELS: Record<(typeof RELATIVE_DATES)[number], string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  week_start: 'Start of this week',
  month_start: 'Start of this month',
  month_end: 'End of this month',
  prev_month_start: 'Start of last month',
  prev_month_end: 'End of last month',
  year_start: 'Start of this year',
  prev_year_start: 'Start of last year',
  prev_year_end: 'End of last year',
};

const OFFSET = /^today([+-])(\d{1,4})$/;

/** How a stored value reads to a person: "Start of last month", "7 days ago". */
export function describeValue(value: string | null | undefined): string {
  if (!value) return '';
  if (value in RELATIVE_LABELS) return RELATIVE_LABELS[value as keyof typeof RELATIVE_LABELS];
  const offset = OFFSET.exec(value);
  if (offset) return `${offset[2]} days ${offset[1] === '-' ? 'ago' : 'from today'}`;
  return value;
}

/** A one-line summary of values, for lists and history. */
export function describeValues(values: Record<string, unknown> | null | undefined): string {
  if (!values) return '';
  return Object.entries(values)
    .filter(([, v]) => v !== null && v !== '')
    .map(([k, v]) => `${k}=${describeValue(String(v))}`)
    .join(' · ');
}

export function DateValueInput({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const offset = OFFSET.exec(value);
  const mode = value === '' ? '' : /^\d{4}-\d{2}-\d{2}$/.test(value) ? 'fixed' : offset ? 'offset' : value;
  return (
    <span style={{ display: 'flex', gap: 6 }}>
      <select
        className="field__input"
        style={mode === 'fixed' || mode === 'offset' ? { minWidth: 140, width: 'auto' } : undefined}
        value={mode}
        disabled={disabled}
        onChange={(e) => {
          const m = e.target.value;
          if (m === 'fixed') onChange(new Date().toISOString().slice(0, 10));
          else if (m === 'offset') onChange('today-7');
          else onChange(m);
        }}
      >
        <option value="">—</option>
        <option value="fixed">Fixed date…</option>
        {RELATIVE_DATES.map((t) => (
          <option key={t} value={t}>
            {RELATIVE_LABELS[t]}
          </option>
        ))}
        <option value="offset">Days from today…</option>
      </select>
      {mode === 'fixed' && <input className="field__input" type="date" style={{ minWidth: 150 }} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />}
      {mode === 'offset' && (
        <input
          className="field__input"
          type="number"
          style={{ width: 90 }}
          title="Negative: days ago"
          value={`${offset![1] === '-' ? '-' : ''}${offset![2]}`}
          disabled={disabled}
          onChange={(e) => {
            const n = Math.trunc(Number(e.target.value) || 0);
            onChange(`today${n < 0 ? '-' : '+'}${Math.min(9999, Math.abs(n))}`);
          }}
        />
      )}
    </span>
  );
}

function ValueInput({ param, value, onChange, disabled }: { param: ReportParam; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  if (param.type === 'date') return <DateValueInput value={value} onChange={onChange} disabled={disabled} />;
  if (param.type === 'choice') {
    return (
      <select className="field__input" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="">{param.required ? '—' : '(all)'}</option>
        {param.choices.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      className="field__input"
      inputMode={param.type === 'number' ? 'decimal' : undefined}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function ParamForm({
  params,
  values,
  onChange,
  disabled,
  children,
}: {
  params: ReportParam[];
  values: ParamValues;
  onChange: (values: ParamValues) => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  if (params.length === 0) return null;
  return (
    <div className="builder">
      {params.map((p) => (
        <label className="field" key={p.name}>
          <span className="field__label mono">
            {p.label.toUpperCase()}
            {p.required ? ' *' : ''}
            {p.default ? ` · DEFAULT ${describeValue(p.default).toUpperCase()}` : ''}
          </span>
          <ValueInput param={p} value={values[p.name] ?? ''} disabled={disabled} onChange={(v) => onChange({ ...values, [p.name]: v })} />
        </label>
      ))}
      {children}
    </div>
  );
}

/** Only the values actually given — an empty field takes the default. */
export function given(values: ParamValues): ParamValues {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ''));
}
