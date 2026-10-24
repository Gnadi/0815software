import { useEffect, useState } from 'react';
import type { BillReadingSettings as Settings } from '../../shared/types';
import { api, type BillReadingState } from '../api';
import { useCan } from '../access';

/**
 * Which model may read supplier invoices (server/bill-reading.ts). E-invoices
 * and printed PDFs are read by PS-04 without one; a model is what reads
 * scans and photos — and it means the invoice leaves the building, so it is
 * the administrator's choice, off by default.
 */

const MODELS: { value: Settings['model']; label: string }[] = [
  { value: null, label: 'None — e-invoices and printed PDFs only, nothing leaves PS-04' },
  { value: 'anthropic', label: 'Anthropic (reads scans and photos)' },
  { value: 'openai', label: 'OpenAI (text only)' },
  { value: 'gemini', label: 'Google Gemini (text only)' },
  { value: 'ollama', label: 'Ollama, self-hosted (text only)' },
  { value: 'kimi', label: 'Kimi (text only)' },
];

export function BillReadingSettings({ onError }: { onError: (err: unknown) => void }) {
  const [state, setState] = useState<BillReadingState | null>(null);
  const [busy, setBusy] = useState(false);
  const canManage = useCan('manage');

  useEffect(() => {
    api.billReading().then(setState, onError);
  }, [onError]);

  if (!state) return null;

  async function choose(model: Settings['model']) {
    setBusy(true);
    try {
      setState(await api.saveBillReading(model));
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="section-title mono">BILLS · READING THEM FROM THE DOCUMENT</div>
      <p className="resource__desc mono">
        {state.available
          ? 'PS-04 reads e-invoices (XRechnung, ZUGFeRD, ebInterface) exactly and printed PDFs from their labels. A model reads what has no text layer — the invoice is then sent to that provider.'
          : 'Not connected: set AI_URL to PS-04 AI Platform to read bills from their documents. Bills are typed until then.'}
        {state.updated_at && ` · Last changed ${state.updated_at.slice(0, 16).replace('T', ' ')} by ${state.updated_by}`}
      </p>
      <div className="editor__meta">
        <label className="field" style={{ gridColumn: '1 / -1' }}>
          <span className="field__label mono">MODEL FOR DOCUMENTS WITHOUT STRUCTURED DATA</span>
          <select
            className="field__input"
            value={state.model ?? ''}
            disabled={!canManage || busy || !state.available}
            onChange={(e) => void choose((e.target.value || null) as Settings['model'])}
          >
            {MODELS.map((m) => (
              <option key={m.value ?? ''} value={m.value ?? ''}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </>
  );
}
