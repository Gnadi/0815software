import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { PublicTicket } from '../../shared/types';
import { api, ApiError } from '../api';
import { fmtDateTime } from '../format';
import { PriorityBadge, StatusBadge } from './Badges';
import { AttachmentList, FilePicker, toUploads } from './Files';

/**
 * Rate a resolved ticket: five stars and an optional word. Once per
 * resolution — afterwards the page shows what was given.
 */
function Rating({ ticket, onRate }: { ticket: PublicTicket; onRate: (score: number, comment: string) => Promise<void> }) {
  const [score, setScore] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  if (!ticket.rating) return null;
  const { can_rate, given } = ticket.rating;
  if (!can_rate && !given) return null;
  return (
    <div className="public__panel" id="rating">
      <div className="panel__title mono">HOW DID WE DO?</div>
      {can_rate ? (
        <>
          <div className="stars" role="radiogroup" aria-label="Your rating">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" role="radio" aria-checked={score === n} aria-label={`${n} of 5`} className={`stars__star ${n <= score ? 'is-on' : ''}`} onClick={() => setScore(n)}>
                ★
              </button>
            ))}
          </div>
          <textarea className="field__input" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Anything you want to tell us? (optional)" maxLength={2000} />
          <button
            className="btn btn--primary"
            disabled={busy || score === 0}
            onClick={() => {
              setBusy(true);
              void onRate(score, comment).finally(() => setBusy(false));
            }}
          >
            SEND RATING →
          </button>
        </>
      ) : (
        given && (
          <p className="public__lede">
            You rated this {given.score} of 5{given.comment ? ` — “${given.comment}”` : ''}. Thank you.
          </p>
        )
      )}
    </div>
  );
}

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
  const [files, setFiles] = useState<File[]>([]);
  const [limits, setLimits] = useState<{ max_bytes: number; per_message: number } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .publicConfig()
      .then((c) => setLimits(c.attachments))
      .catch(() => setLimits(null));
  }, []);

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
      const updated = await api.publicComment(ticketRef, token, reply, await toUploads(files));
      setTicket(updated);
      setReply('');
      setFiles([]);
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
                  {ev.type === 'created' && (
                    <>
                      <span className="event__line">Ticket submitted.</span>
                      <AttachmentList attachments={ev.attachments} href={(id) => api.publicAttachmentUrl(ticket.ref, token, id)} />
                    </>
                  )}
                  {ev.type === 'status_change' && (
                    <span className="event__line">Status changed to {ev.to?.toUpperCase()}.</span>
                  )}
                  {ev.type === 'comment' && (
                    <div className={`comment comment--${ev.author_type === 'agent' ? 'agent' : 'requester'}`}>
                      {ev.body}
                      <AttachmentList attachments={ev.attachments} href={(id) => api.publicAttachmentUrl(ticket.ref, token, id)} />
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        <Rating
          ticket={ticket}
          onRate={async (score, comment) => {
            try {
              setTicket(await api.publicRate(ticketRef, token, score, comment));
            } catch (err) {
              setError(err instanceof ApiError ? err.message : 'Could not send your rating');
            }
          }}
        />

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
          {limits && <FilePicker files={files} onChange={setFiles} maxBytes={limits.max_bytes} perMessage={limits.per_message} disabled={busy} />}
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
