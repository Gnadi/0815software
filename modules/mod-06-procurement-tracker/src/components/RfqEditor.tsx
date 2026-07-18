import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';

interface Props {
  id: number | null;
  onDone: (id: number | null) => void;
  onAuthLost: () => void;
}

interface LineForm {
  description: string;
  quantity: string;
  unit: string;
}

const EMPTY_LINE: LineForm = { description: '', quantity: '1', unit: 'pc' };

export function RfqEditor({ id, onDone, onAuthLost }: Props) {
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<LineForm[]>([{ ...EMPTY_LINE }]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(id === null);

  const load = useCallback(async () => {
    if (id === null) return;
    try {
      const rfq = await api.rfqDetail(id);
      setTitle(rfq.title);
      setDueDate(rfq.due_date ?? '');
      setNote(rfq.note ?? '');
      setLines(
        rfq.lines.map((l) => ({
          description: l.description,
          quantity: String(l.quantity),
          unit: l.unit,
        })),
      );
      setLoaded(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load RFQ');
    }
  }, [id, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const values = {
        title,
        due_date: dueDate || null,
        note: note.trim() || null,
        lines: lines.map((l) => ({
          description: l.description,
          quantity: Number(l.quantity.replace(',', '.')),
          unit: l.unit,
        })),
      };
      const rfq = id === null ? await api.createRfq(values) : await api.updateRfq(id, values);
      onDone(rfq.id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onAuthLost();
        return;
      }
      setError(
        err instanceof ApiError
          ? [err.message, ...err.details.map((d) => `${d.field}: ${d.message}`)].join(' · ')
          : 'Request failed',
      );
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <div className="boot mono">LOADING…</div>;

  return (
    <div>
      <button className="backlink mono" onClick={() => onDone(id)}>
        ← BACK
      </button>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ PRC.01 · SOURCING</div>
          <h1 className="resource__title">{id === null ? 'New RFQ' : `Edit RFQ-${id}`}</h1>
          <p className="resource__desc">
            Lines are what suppliers price — they freeze once the first quote arrives.
          </p>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <form className="editor" onSubmit={(e) => void submit(e)}>
        <div className="editor__meta">
          <label className="field">
            <span className="field__label mono">
              TITLE <span className="field__req">*</span>
            </span>
            <input className="field__input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </label>
          <label className="field">
            <span className="field__label mono">QUOTES DUE</span>
            <input className="field__input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </label>
          <label className="field">
            <span className="field__label mono">NOTE</span>
            <input className="field__input" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>

        <div className="section-title mono">LINES</div>
        {lines.map((line, i) => (
          <div key={i} className="line-row line-row--noprice">
            <label className="field">
              <span className="field__label mono">
                DESCRIPTION <span className="field__req">*</span>
              </span>
              <input
                className="field__input"
                value={line.description}
                onChange={(e) => setLines(lines.map((l, j) => (j === i ? { ...l, description: e.target.value } : l)))}
              />
            </label>
            <label className="field">
              <span className="field__label mono">QTY</span>
              <input
                className="field__input"
                value={line.quantity}
                onChange={(e) => setLines(lines.map((l, j) => (j === i ? { ...l, quantity: e.target.value } : l)))}
              />
            </label>
            <label className="field">
              <span className="field__label mono">UNIT</span>
              <input
                className="field__input"
                value={line.unit}
                onChange={(e) => setLines(lines.map((l, j) => (j === i ? { ...l, unit: e.target.value } : l)))}
              />
            </label>
            <button
              className="rowbtn rowbtn--danger mono line-row__remove"
              type="button"
              disabled={lines.length === 1}
              onClick={() => setLines(lines.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </div>
        ))}
        <button className="editor__addline mono" type="button" onClick={() => setLines([...lines, { ...EMPTY_LINE }])}>
          + ADD LINE
        </button>

        <div className="editor__actions">
          <button className="btn btn--ghost" type="button" onClick={() => onDone(id)}>
            CANCEL
          </button>
          <button className="btn btn--primary" type="submit" disabled={busy}>
            {busy ? 'SAVING…' : 'SAVE RFQ →'}
          </button>
        </div>
      </form>
    </div>
  );
}
