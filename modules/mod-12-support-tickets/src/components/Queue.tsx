import { useCallback, useEffect, useState } from 'react';
import type { Agent, SlaLeg, TicketRow } from '../../shared/types';
import { api, ApiError } from '../api';
import { fmtRelative } from '../format';
import { PriorityBadge, SlaBadge, StatusBadge } from './Badges';

interface Props {
  agents: Agent[];
  onOpen: (ref: string) => void;
  onAuthLost: () => void;
}

const STATUS_FILTERS = ['', 'new', 'open', 'pending', 'resolved', 'closed'];
const PRIORITY_FILTERS = ['', 'urgent', 'high', 'normal', 'low'];

function SlaLegCell({ tag, leg }: { tag: string; leg: SlaLeg }) {
  return (
    <div className="sla-cell__leg">
      <span className="sla-cell__tag">{tag}</span>
      <SlaBadge leg={leg} />
      <span className="sla-cell__when">
        {leg.met_at ? '' : leg.state === 'breached' ? fmtRelative(leg.due_at) : `due ${fmtRelative(leg.due_at)}`}
      </span>
    </div>
  );
}

export function Queue({ agents, onOpen, onAuthLost }: Props) {
  const [rows, setRows] = useState<TicketRow[] | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [assignee, setAssignee] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      if (status) params.set('status', status);
      if (priority) params.set('priority', priority);
      if (assignee) params.set('assignee', assignee);
      const { tickets } = await api.tickets(params);
      setRows(tickets);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load the queue');
    }
  }, [search, status, priority, assignee, onAuthLost]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 150);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ SUP.01 · INBOUND QUEUE</div>
          <h1 className="resource__title">Queue</h1>
          <p className="resource__desc">
            new → open → pending → resolved → closed. Every change is an append-only event; SLA state is
            derived from the wall clock at read time.
          </p>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="toolbar">
        <input
          className="field__input toolbar__search"
          placeholder="Search ref, subject, requester…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className="field__input toolbar__filter" value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUS_FILTERS.map((s) => (
            <option key={s} value={s}>
              {s ? s.toUpperCase() : 'ALL STATUS'}
            </option>
          ))}
        </select>
        <select className="field__input toolbar__filter" value={priority} onChange={(e) => setPriority(e.target.value)}>
          {PRIORITY_FILTERS.map((p) => (
            <option key={p} value={p}>
              {p ? p.toUpperCase() : 'ALL PRIORITY'}
            </option>
          ))}
        </select>
        <select className="field__input toolbar__filter" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <option value="">ALL ASSIGNEES</option>
          <option value="unassigned">UNASSIGNED</option>
          {agents.map((a) => (
            <option key={a.id} value={String(a.id)}>
              {a.name}
            </option>
          ))}
        </select>
        <span className="toolbar__count mono">{rows ? `${rows.length} TICKETS` : ''}</span>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">REF</th>
              <th className="mono">SUBJECT</th>
              <th className="mono">STATUS</th>
              <th className="mono">PRIORITY</th>
              <th className="mono">ASSIGNEE</th>
              <th className="mono">SLA</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((t) => (
              <tr key={t.ref}>
                <td className="mono">
                  <button className="linklike mono" onClick={() => onOpen(t.ref)}>
                    {t.ref}
                  </button>
                </td>
                <td className="table__subject" title={t.subject}>
                  {t.subject}
                  <div className="table__id mono">{t.requester_name}</div>
                </td>
                <td>
                  <StatusBadge status={t.status} />
                </td>
                <td>
                  <PriorityBadge priority={t.priority} />
                </td>
                <td className="table__id">{t.assignee_name ?? '—'}</td>
                <td>
                  <div className="sla-cell">
                    <SlaLegCell tag="FR" leg={t.sla.first_response} />
                    <SlaLegCell tag="RES" leg={t.sla.resolution} />
                  </div>
                </td>
              </tr>
            ))}
            {rows && rows.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={6}>
                  NO TICKETS MATCH
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
