import type { AbsenceTypeDef, RequestStatus } from '../../shared/types';

export function StatusBadge({ status }: { status: RequestStatus }) {
  return <span className={`badge mono badge--${status}`}>{status.toUpperCase()}</span>;
}

/**
 * The type badge carries the one fact that decides whether a request touches
 * the balance at all, so it is shown next to the type rather than buried in a
 * legend: a colleague looking at three sick days should be able to see, in the
 * list, why they cost nothing.
 */
export function TypeBadge({ type, types }: { type: string; types: AbsenceTypeDef[] }) {
  const def = types.find((candidate) => candidate.key === type);
  const label = def ? def.label.split(' / ')[0] : type;
  return (
    <span className={`badge mono badge--type ${def && !def.deducts ? 'badge--nodeduct' : ''}`}>
      {label?.toUpperCase()}
    </span>
  );
}
