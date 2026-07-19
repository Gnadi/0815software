import type { ReactNode } from 'react';
import type { StageInfo } from '../../shared/types';

export function StageBadge({ stageKey, label }: { stageKey: string; label: string }) {
  return <span className={`badge mono badge--${stageKey}`}>{label.toUpperCase()}</span>;
}

export function ActivityBadge({ type }: { type: string }) {
  return <span className={`badge mono badge--${type}`}>{type}</span>;
}

export function Field({
  label,
  required,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field__label mono">
        {label}
        {required && <span className="field__req"> *</span>}
      </span>
      {children}
      {error && <span className="field__error mono">{error}</span>}
    </label>
  );
}

export function Modal({
  eyebrow,
  title,
  error,
  onClose,
  children,
  actions,
}: {
  eyebrow: string;
  title: string;
  error?: string;
  onClose: () => void;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div className="modal">
      <div className="modal__backdrop" onClick={onClose} />
      <div className="modal__card">
        <div className="modal__eyebrow mono">{eyebrow}</div>
        <h2 className="modal__title">{title}</h2>
        {error && <div className="modal__error mono">{error}</div>}
        {children}
        <div className="modal__actions">{actions}</div>
      </div>
    </div>
  );
}

/** Ordered active (non-terminal) stages from config. */
export function activeStages(stages: StageInfo[]): StageInfo[] {
  return stages.filter((s) => !s.terminal);
}
