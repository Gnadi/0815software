import { useCallback, useEffect, useState } from 'react';
import type { ProgramDetail as ProgramDetailData } from '../../shared/types';
import { api, ApiError } from '../api';
import { fmtDate, fmtEur } from '../format';
import { ProgramStatusBadge, StatusBadge } from './Badges';

interface Props {
  programId: number;
  onBack: () => void;
  onOpenApplication: (id: number) => void;
  onAuthLost: () => void;
}

export function ProgramDetail({ programId, onBack, onOpenApplication, onAuthLost }: Props) {
  const [program, setProgram] = useState<ProgramDetailData | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setProgram(await api.program(programId));
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load the program');
    }
  }, [programId, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleStatus() {
    if (!program) return;
    setBusy(true);
    setError('');
    try {
      const next = program.status === 'open' ? 'closed' : 'open';
      setProgram(
        await api.updateProgram(program.id, {
          name: program.name,
          funding_body: program.funding_body,
          category: program.category,
          funding_rate: program.funding_rate,
          max_grant_cents: program.max_grant_cents,
          application_deadline: program.application_deadline,
          description: program.description,
          status: next,
        }),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update the program');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!program) return;
    setBusy(true);
    setError('');
    try {
      await api.deleteProgram(program.id);
      onBack();
    } catch (err) {
      // A program with applications returns 409 — surface it, do not navigate.
      setError(err instanceof ApiError ? err.message : 'Failed to delete the program');
    } finally {
      setBusy(false);
    }
  }

  if (!program) {
    return (
      <div>
        <button className="backlink mono" onClick={onBack}>
          ← BACK TO PROGRAMS
        </button>
        {error ? <div className="resource__error mono">{error}</div> : <div className="boot mono">LOADING…</div>}
      </div>
    );
  }

  return (
    <div>
      <button className="backlink mono" onClick={onBack}>
        ← BACK TO PROGRAMS
      </button>

      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">{program.funding_body.toUpperCase()} · {program.category_label.toUpperCase()}</div>
          <h1 className="resource__title">{program.name}</h1>
          {program.description && <p className="resource__desc">{program.description}</p>}
        </div>
        <div className="resource__actions">
          <button className="btn btn--ghost" onClick={() => void toggleStatus()} disabled={busy}>
            {program.status === 'open' ? 'CLOSE PROGRAM' : 'REOPEN PROGRAM'}
          </button>
          <button className="btn btn--danger" onClick={() => void remove()} disabled={busy}>
            DELETE
          </button>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="detail">
        <div className="detail__main">
          <div className="section-title mono">OUR APPLICATIONS · {program.applications.length}</div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th className="mono">REF</th>
                  <th className="mono">TITLE</th>
                  <th className="mono">STATUS</th>
                  <th className="mono num">REQUESTED</th>
                  <th className="mono num">APPROVED</th>
                  <th className="mono num">REMAINING</th>
                </tr>
              </thead>
              <tbody>
                {program.applications.map((a) => (
                  <tr key={a.id}>
                    <td className="mono">
                      <button className="linklike mono" onClick={() => onOpenApplication(a.id)}>
                        {a.ref}
                      </button>
                    </td>
                    <td className="table__title" title={a.title}>
                      {a.title}
                    </td>
                    <td>
                      <StatusBadge status={a.status} />
                    </td>
                    <td className="num mono">{fmtEur(a.requested_amount_cents)}</td>
                    <td className="num mono">{a.approved_amount_cents === null ? '—' : fmtEur(a.approved_amount_cents)}</td>
                    <td className="num mono">{a.remaining_cents === null ? '—' : fmtEur(a.remaining_cents)}</td>
                  </tr>
                ))}
                {program.applications.length === 0 && (
                  <tr>
                    <td className="table__empty mono" colSpan={6}>
                      NO APPLICATIONS YET
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <aside className="detail__side">
          <div className="panel">
            <div className="panel__title mono">PROGRAM</div>
            <div className="panel__row">
              <span className="mono">STATUS</span>
              <ProgramStatusBadge status={program.status} />
            </div>
            <div className="panel__row">
              <span className="mono">FUNDING RATE</span>
              <span className="num mono">{program.funding_rate}%</span>
            </div>
            <div className="panel__row">
              <span className="mono">MAX GRANT</span>
              <span className="num mono">{fmtEur(program.max_grant_cents)}</span>
            </div>
            <div className="panel__row">
              <span className="mono">DEADLINE</span>
              <span className="mono">{program.application_deadline ? fmtDate(program.application_deadline) : 'rolling'}</span>
            </div>
            <div className="panel__row">
              <span className="mono">CURRENCY</span>
              <span className="mono">{program.currency}</span>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
