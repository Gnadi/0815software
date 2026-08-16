import type { CaseStatus, Deadline } from '../../shared/types';
import { fmtDeadline, humanize, stateLabel } from '../format';

export function StatusBadge({ status }: { status: CaseStatus }) {
  return <span className={`badge mono badge--${status}`}>{humanize(status)}</span>;
}

export function OutcomeBadge({ outcome }: { outcome: string }) {
  return <span className="badge mono badge--outcome">{humanize(outcome)}</span>;
}

/**
 * A statutory deadline, rendered as its state and its distance in one chip.
 *
 * `missed` is shown for a late fulfilment too, not just for an unfulfilled
 * one — "we answered, three weeks late" is precisely what an audit asks
 * about, and a badge that flipped to MET when the reply landed would hide it.
 */
export function DeadlineBadge({ label, deadline }: { label: string; deadline: Deadline }) {
  return (
    <span className={`badge mono badge--${deadline.state}`} title={`due ${deadline.due_at}`}>
      {label} {stateLabel(deadline.state)}
      {deadline.met_at === null && ` · ${fmtDeadline(deadline.days_remaining)}`}
    </span>
  );
}
