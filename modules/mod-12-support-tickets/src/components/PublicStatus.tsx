import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { PublicTicket } from '../../shared/types';
import { api, ApiError } from '../api';
import { fmtDateTime } from '../format';
import { PriorityBadge, StatusBadge } from './Badges';

interface Props {
  ticketRef: string;
  token: string;
}

function authorLabel(authorType: string, author: string): string {
  if (authorType === 'agent') return `${author} · support`;
  if (authorType === 'system') return 'system';
  return author;
}

export function PublicStatus({ ticketRef, token }: Props) {
  const [ticket, setTicket] = useState<PublicTicket | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState('');
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setTicket(await api.publicTicket(ticketRef, token));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNotFound(true);
      else setError(err instanceof Error ? err.message : 'Could not load the ticket');
    }
  }, [ticketRef, token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const updated = await api.publicComment(ticketRef, token, reply);
      setTicket(updated);
      setReply('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add your follow-up');
    } finally {
      setBusy(false);
    }
  }

  if (notFound) {
    return (
      <div className="public">
        <div className="public__card">
          <div className="public__head">
            <div className="public__eyebrow mono">MOD-12 · SUPPORT DESK</div>
            <h1 className="public__title">Ticket not found</h1>
            <p className="public__lede">
              This link is invalid or has expired. Check that you used the full link from your confirmation,
              including the token.
            </p>
          </div>
          <div className="public__foot mono">
            <a href="/">← SUBMIT A NEW TICKET</a>
          </div>
        </div>
      </div>
    );
  }

  if (!ticket) {
    return <div className="boot mono">LOADING…</div>;
  }

  const isResolved = ticket.status === 'resolved' || ticket.status === 'closed';

  return (
    <div className="public">
      <div className="public__card">
        <div className="public__head">
          <div className="public__eyebrow mono">MOD-12 · TICKET {ticket.ref}</div>
          <h1 className="public__title">{ticket.subject}</h1>
          <div className="status-hero">
            <StatusBadge status={ticket.status} />
            <PriorityBadge priority={ticket.priority} />
            <span className="mono" style={{ fontSize: 10, color: 'var(--fg-mute)' }}>
              OPENED {fmtDateTime(ticket.created_at)}
            </span>
          </div>
        </div>

        <div className="public__panel">
          <div className="panel__title mono">CONVERSATION</div>
          {error && <div className="resource__error mono">{error}</div>}
          <div className="thread">
            {ticket.events.map((ev, i) => (
              <div className="event" key={i}>
                <div className="event__meta">
                  <span className="event__when mono">{fmtDateTime(ev.created_at)}</span>
                  <span className="event__actor">{authorLabel(ev.author_type, ev.author)}</span>
                </div>
                <div className="event__body">
                  {ev.type === 'created' && <span className="event__line">Ticket submitted.</span>}
                  {ev.type === 'status_change' && (
                    <span className="event__line">Status changed to {ev.to?.toUpperCase()}.</span>
                  )}
                  {ev.type === 'comment' && (
                    <div className={`comment comment--${ev.author_type === 'agent' ? 'agent' : 'requester'}`}>
                      {ev.body}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        <form className="public__panel" onSubmit={(e) => void submit(e)}>
          <div className="panel__title mono">ADD A FOLLOW-UP</div>
          {isResolved && (
            <p className="field__label mono" style={{ color: 'var(--warn)' }}>
              THIS TICKET IS {ticket.status.toUpperCase()} — POSTING A FOLLOW-UP WILL REOPEN IT.
            </p>
          )}
          <textarea
            className="field__input"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Add more detail or reply to support…"
          />
          <button className="btn btn--primary" type="submit" disabled={busy || reply.trim() === ''}>
            {busy ? 'SENDING…' : 'SEND FOLLOW-UP →'}
          </button>
        </form>

        <div className="public__foot mono">
          <a href="/">← SUBMIT A NEW TICKET</a>
          <span>0815SOFTWARE · MIT</span>
        </div>
      </div>
    </div>
  );
}
