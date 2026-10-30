import { useCallback, useEffect, useState } from 'react';
import type {
  Agent,
  AppConfig,
  CannedResponse,
  Priority,
  SlaLeg,
  Status,
  TicketDetail as TicketDetailData,
  TicketEvent,
} from '../../shared/types';
import { api, ApiError } from '../api';
import { fmtDateTime, fmtMinutes, fmtRelative } from '../format';
import { PriorityBadge, SlaBadge, StatusBadge } from './Badges';
import { Can, useCan } from '../access';
import { AttachmentList, FilePicker, toUploads } from './Files';

interface Props {
  ticketRef: string;
  config: AppConfig;
  agents: Agent[];
  onBack: () => void;
  onAuthLost: () => void;
}

function EventRow({ ev, agentName, fileHref }: { ev: TicketEvent; agentName: string; fileHref: (id: number) => string }) {
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
            Ticket created via {ev.payload.channel ?? 'web'} at {(ev.payload.to_priority ?? 'normal').toUpperCase()} priority
            {ev.attachments.length > 0 ? `, with ${ev.attachments.length} file${ev.attachments.length === 1 ? '' : 's'}` : ''}.
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
              {ev.payload.other_sender
                ? `BY EMAIL FROM ${ev.payload.other_sender.toUpperCase()} — NOT THE REQUESTER, KEPT INTERNAL`
                : ev.visibility === 'internal'
                  ? 'INTERNAL NOTE'
                  : ev.actor_type === 'agent'
                    ? 'PUBLIC REPLY'
                    : 'REQUESTER'}
            </span>
            {ev.payload.body}
            <AttachmentList attachments={ev.attachments} href={fileHref} />
          </div>
        )}
      </div>
    </div>
  );
}

function SlaRows({ label, leg }: { label: string; leg: SlaLeg }) {
  return (
    <>
      <div className="panel__row">
        <span className="mono">{label}</span>
        <SlaBadge leg={leg} />
      </div>
      <div className="panel__row">
        <span className="mono" style={{ color: 'var(--fg-mute)' }}>
          {leg.state === 'paused' ? 'DUE IF IT RAN NOW' : 'DUE'}
        </span>
        <span className="mono" style={{ fontSize: 11 }} title={leg.due_at}>
          {fmtRelative(leg.due_at)}
        </span>
      </div>
      {leg.remaining_minutes !== null && (
        <div className="panel__row">
          <span className="mono" style={{ color: 'var(--fg-mute)' }}>LEFT</span>
          <span className="mono" style={{ fontSize: 11 }}>
            {fmtMinutes(leg.remaining_minutes)} {leg.business_hours ? 'BUSINESS HOURS' : ''}
          </span>
        </div>
      )}
    </>
  );
}

export function TicketDetail({ ticketRef, config, agents, onBack, onAuthLost }: Props) {
  const [ticket, setTicket] = useState<TicketDetailData | null>(null);
  const [error, setError] = useState('');
  const [reply, setReply] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'internal'>('public');
  const [files, setFiles] = useState<File[]>([]);
  const [canned, setCanned] = useState<CannedResponse[]>([]);
  const [cannedId, setCannedId] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  // Status, priority and assignment stay visible as state; only an agent who
  // can edit may change them.
  const canEdit = useCan();

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

  useEffect(() => {
    api
      .canned()
      .then((r) => setCanned(r.canned_responses.filter((c) => c.active)))
      .catch(() => setCanned([]));
  }, []);

  async function applyCanned(id: number) {
    try {
      const filled = await api.renderCanned(ticketRef, id);
      setReply(filled.body);
      setCannedId(filled.canned_id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not fill the canned response');
    }
  }

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
    const uploads = await toUploads(files);
    await act(() => api.comment(ticketRef, reply, visibility, uploads, cannedId));
    setReply('');
    setFiles([]);
    setCannedId(undefined);
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
  const fileHref = (id: number) => api.attachmentUrl(ticket.ref, id);
  const opening = ticket.events.find((e) => e.type === 'created');

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
            <div className="comment comment--requester">
              {ticket.body}
              <AttachmentList attachments={opening?.attachments ?? []} href={fileHref} />
            </div>
          </div>

          <div className="section-title mono">TIMELINE · APPEND-ONLY</div>
          <div className="thread">
            {ticket.events.map((ev) => (
              <EventRow key={ev.id} ev={ev} agentName={agentName} fileHref={fileHref} />
            ))}
          </div>

          <Can>
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
              {canned.length > 0 && (
                <select className="field__input composer__canned" value="" onChange={(e) => e.target.value && void applyCanned(Number(e.target.value))}>
                  <option value="">Start from a canned response…</option>
                  {canned.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
              )}
              <textarea
                className="field__input"
                value={reply}
                onChange={(e) => {
                  setReply(e.target.value);
                  if (e.target.value === '') setCannedId(undefined);
                }}
                placeholder={
                  visibility === 'public'
                    ? 'Reply to the requester — visible on their status page…'
                    : 'Internal note — never shown to the requester…'
                }
              />
              <FilePicker files={files} onChange={setFiles} maxBytes={config.attachments.max_bytes} perMessage={config.attachments.per_message} disabled={busy} />
              <div className="composer__actions">
                <button className="btn btn--primary" onClick={() => void sendComment()} disabled={busy || reply.trim() === ''}>
                  {visibility === 'public' ? 'POST REPLY →' : 'ADD NOTE →'}
                </button>
              </div>
            </div>
          </Can>
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
            <div className="panel__title mono">
              SLA · DERIVED · {ticket.sla.policy_version === null ? 'DEFAULT POLICY' : `POLICY V${ticket.sla.policy_version}`}
            </div>
            <SlaRows label="FIRST RESPONSE" leg={ticket.sla.first_response} />
            <SlaRows label="RESOLUTION" leg={ticket.sla.resolution} />
          </div>

          {ticket.ratings.length > 0 && (
            <div className="panel">
              <div className="panel__title mono">RATED BY THE REQUESTER</div>
              {ticket.ratings.map((r) => (
                <div key={r.id} className="rating-line">
                  <span className="mono rating-stars" aria-label={`${r.score} of 5`}>
                    {'★'.repeat(r.score)}
                    {'☆'.repeat(5 - r.score)}
                  </span>
                  <span className="mono table__id">{fmtDateTime(r.created_at)}</span>
                  {r.comment && <p className="rating-comment">{r.comment}</p>}
                </div>
              ))}
            </div>
          )}

          <div className="panel">
            <div className="panel__title mono">SET STATUS</div>
            <div className="chooser">
              {config.statuses.map((s: Status) => {
                const allowed = s === ticket.status || ticket.allowed_transitions.includes(s);
                return (
                  <button
                    key={s}
                    className={`chooser__btn ${s === ticket.status ? 'is-active' : ''}`}
                    disabled={busy || s === ticket.status || !allowed || !canEdit}
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
                  disabled={busy || p === ticket.priority || !canEdit}
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
                disabled={busy || ticket.assignee_id === null || !canEdit}
                onClick={() => void act(() => api.assign(ticketRef, null))}
              >
                UNASSIGNED
              </button>
              {agents.map((a) => (
                <button
                  key={a.id}
                  className={`chooser__btn ${ticket.assignee_id === a.id ? 'is-active' : ''}`}
                  disabled={busy || ticket.assignee_id === a.id || !canEdit}
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
