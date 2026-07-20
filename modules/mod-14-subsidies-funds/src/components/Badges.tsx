import type { ApplicationStatus, DeadlineState, ObligationState, ProgramStatus } from '../../shared/types';
import { stateLabel } from '../format';

export function StatusBadge({ status }: { status: ApplicationStatus }) {
  return <span className={`badge mono badge--${status}`}>{status.replace('_', ' ').toUpperCase()}</span>;
}

export function ProgramStatusBadge({ status }: { status: ProgramStatus }) {
  return <span className={`badge mono badge--${status}`}>{status.toUpperCase()}</span>;
}

export function DeadlineBadge({ state }: { state: DeadlineState | ObligationState }) {
  return <span className={`badge mono badge--${state}`}>{stateLabel(state)}</span>;
}
