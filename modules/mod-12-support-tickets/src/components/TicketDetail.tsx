import { useCallback, useEffect, useState } from 'react';
import type {
  Agent,
  AppConfig,
  Priority,
  Status,
  TicketDetail as TicketDetailData,
  TicketEvent,
} from '../../shared/types';
import { api, ApiError } from '../api';
import { fmtDateTime, fmtRelative } from '../format';
import { PriorityBadge, SlaBadge, StatusBadge } from './Badges';

interface Props {
  ticketRef: string;
  config: AppConfig;
  agents: Agent[];
  onBack: () => void;
  onAuthLost: () => void;
}

function EventRow({ ev, agentName }: { ev: TicketEvent; agentName: string }) {
  const actor =
    ev.actor_type === 'agent' ? `${ev.actor} · agent` : ev.actor_type === 'system' ? 'system' : ev.actor;
  return (
    <div className="event">
      <div className="event__meta">
        <span className="event__when mono">{fmtDateTime(ev.created_at)}</span>
        <span className="event__actor">{actor}</span>
      </div>
      <div className="event__body">
        {ev.type === 'created' && (
          <span className="event__line">
            Ticket created via {ev.payload.channel ?? 'web'} at {(ev.payload.to_priority ?? 'normal').toUpperCase()} priority.
          </span>
        )}
        {ev.type === 'status_change' && (
          <span className="event__line">
            {ev.payload.reopened ? 'Reopened' : 'Status'} → {ev.payload.to?.toUpperCase()}
            {ev.payload.from ? ` (from ${ev.payload.from})` : ''}.
          </span>
        )}
        {ev.type === 'priority_change' && (
          <span className="event__line">
            Priority {ev.payload.from_priority?.toUpperCase()} → {ev.payload.to_priority?.toUpperCase()}.
          </span>
        )}
        {ev.type === 'assignment' && (
          <span className="event__line">
            {ev.payload.assignee_id === null || ev.payload.assignee_id === undefined
              ? 'Unassigned.'
              : `Assigned to ${ev.payload.assignee_name ?? agentName}.`}
          </span>
        )}
        {ev.type === 'comment' && (
          <div
            className={`comment comment--${ev.actor_type === 'agent' ? (ev.visibility === 'internal' ? 'internal' : 'agent') : 'requester'}`}
          >
            <span className="comment__tag mono">
              {ev.visibility === 'internal' ? 'INTERNAL NOTE' : ev.actor_type === 'agent' ? 'PUBLIC REPLY' : 'REQUESTER'}
            </span>
            {ev.payload.body}
          </div>
        )}
      </div>
    </div>
  );
}

export function TicketDetail({ ticketRef, config, agents, onBack, onAuthLost }: Props) {
  const [ticket, setTicket] = useState<TicketDetailData | null>(null);
  const [error, setError] = useState('');
  const [reply, setReply] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'internal'>('public');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setTicket(await api.ticket(ticketRef));
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load the ticket');
    }
  }, [ticketRef, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(fn: () => Promise<TicketDetailData>) {
    setBusy(true);
    setError('');
    try {
      setTicket(await fn());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof ApiError ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  async function sendComment() {
    if (reply.trim() === '') return;
    await act(() => api.comment(ticketRef, reply, visibility));
    setReply('');
  }

  if (!ticket) {
    return (
      <div>
        <button className="backlink mono" onClick={onBack}>
          ← BACK TO QUEUE
        </button>
        {error ? <div className="resource__error mono">{error}</div> : <div className="boot mono">LOADING…</div>}
      </div>
    );
  }

  const agentName = ticket.assignee_name ?? '';

  return (
    <div>
      <button className="backlink mono" onClick={onBack}>
        ← BACK TO QUEUE
      </button>

      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">{ticket.ref} · {ticket.channel.toUpperCase()} INTAKE</div>
          <h1 className="resource__title">{ticket.subject}</h1>
          <p className="resource__desc">
            {ticket.requester_name} · {ticket.requester_email} · opened {fmtDateTime(ticket.created_at)}
          </p>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="detail">
        <div className="detail__main">
          <div className="panel">
            <div className="panel__title mono">ORIGINAL MESSAGE</div>
            <div className="comment comment--requester">{ticket.body}</div>
          </div>

          <div className="section-title mono">TIMELINE · APPEND-ONLY</div>
          <div className="thread">
            {ticket.events.map((ev) => (
              <EventRow key={ev.id} ev={ev} agentName={agentName} />
            ))}
          </div>

          <div className="composer">
            <div className="composer__tabs">
              <button
                className={`chooser__btn ${visibility === 'public' ? 'is-active' : ''}`}
                onClick={() => setVisibility('public')}
              >
                PUBLIC REPLY
              </button>
              <button
                className={`chooser__btn ${visibility === 'internal' ? 'is-active' : ''}`}
                onClick={() => setVisibility('internal')}
              >
                INTERNAL NOTE
              </button>
            </div>
            <textarea
              className="field__input"
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              placeholder={
                visibility === 'public'
                  ? 'Reply to the requester — visible on their status page…'
                  : 'Internal note — never shown to the requester…'
              }
            />
            <div className="composer__actions">
              <button className="btn btn--primary" onClick={() => void sendComment()} disabled={busy || reply.trim() === ''}>
                {visibility === 'public' ? 'POST REPLY →' : 'ADD NOTE →'}
              </button>
            </div>
          </div>
        </div>

        <aside className="detail__side">
          <div className="panel">
            <div className="panel__title mono">STATE</div>
            <div className="panel__row">
              <span className="mono">STATUS</span>
              <StatusBadge status={ticket.status} />
            </div>
            <div className="panel__row">
              <span className="mono">PRIORITY</span>
              <PriorityBadge priority={ticket.priority} />
            </div>
            <div className="panel__row">
              <span className="mono">ASSIGNEE</span>
              <span>{ticket.assignee_name ?? '—'}</span>
            </div>
          </div>

          <div className="panel">
            <div className="panel__title mono">SLA · DERIVED</div>
            <div className="panel__row">
              <span className="mono">FIRST RESPONSE</span>
              <SlaBadge leg={ticket.sla.first_response} />
            </div>
            <div className="panel__row">
              <span className="mono" style={{ color: 'var(--fg-mute)' }}>DUE</span>
              <span className="mono" style={{ fontSize: 11 }}>{fmtRelative(ticket.sla.first_response.due_at)}</span>
            </div>
            <div className="panel__row">
              <span className="mono">RESOLUTION</span>
              <SlaBadge leg={ticket.sla.resolution} />
            </div>
            <div className="panel__row">
              <span className="mono" style={{ color: 'var(--fg-mute)' }}>DUE</span>
              <span className="mono" style={{ fontSize: 11 }}>{fmtRelative(ticket.sla.resolution.due_at)}</span>
            </div>
          </div>

          <div className="panel">
            <div className="panel__title mono">SET STATUS</div>
            <div className="chooser">
              {config.statuses.map((s: Status) => {
                const allowed = s === ticket.status || ticket.allowed_transitions.includes(s);
                return (
                  <button
                    key={s}
                    className={`chooser__btn ${s === ticket.status ? 'is-active' : ''}`}
                    disabled={busy || s === ticket.status || !allowed}
                    onClick={() => void act(() => api.setStatus(ticketRef, s))}
                  >
                    {s.toUpperCase()}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="panel">
            <div className="panel__title mono">SET PRIORITY</div>
            <div className="chooser">
              {config.priorities.map((p: Priority) => (
                <button
                  key={p}
                  className={`chooser__btn ${p === ticket.priority ? 'is-active' : ''}`}
                  disabled={busy || p === ticket.priority}
                  onClick={() => void act(() => api.setPriority(ticketRef, p))}
                >
                  {p.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div className="panel">
            <div className="panel__title mono">ASSIGN</div>
            <div className="chooser">
              <button
                className={`chooser__btn ${ticket.assignee_id === null ? 'is-active' : ''}`}
                disabled={busy || ticket.assignee_id === null}
                onClick={() => void act(() => api.assign(ticketRef, null))}
              >
                UNASSIGNED
              </button>
              {agents.map((a) => (
                <button
                  key={a.id}
                  className={`chooser__btn ${ticket.assignee_id === a.id ? 'is-active' : ''}`}
                  disabled={busy || ticket.assignee_id === a.id}
                  onClick={() => void act(() => api.assign(ticketRef, a.id))}
                >
                  {a.name}
                </button>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
