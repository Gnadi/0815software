import { useCallback, useEffect, useState } from 'react';
import type { FollowUp } from '../../shared/types';
import { api, ApiError } from '../api';
import { ActivityBadge } from './ui';

export function FollowUpsView({
  onOpenDeal,
  onOpenContact,
  onAuthLost,
}: {
  onOpenDeal: (id: number) => void;
  onOpenContact: (id: number) => void;
  onAuthLost: () => void;
}) {
  const [followups, setFollowups] = useState<FollowUp[]>([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setFollowups((await api.followups()).followups);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load follow-ups');
    }
  }, [onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  async function markDone(id: number) {
    try {
      await api.setDone(id, true);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Action failed');
    }
  }

  const overdue = followups.filter((f) => f.overdue);

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">FOLLOW-UPS</div>
          <h1 className="resource__title">Open follow-ups</h1>
          <p className="resource__desc">
            Derived from activities with a due date that are not yet done. {overdue.length} overdue.
          </p>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="table-wrap">
        {followups.length === 0 && <div className="board__empty mono" style={{ padding: 40 }}>NOTHING DUE — INBOX ZERO</div>}
        {followups.map((f) => (
          <div className="followup" key={f.id}>
            <span className={`followup__due mono ${f.overdue ? 'is-overdue' : ''}`}>
              {f.overdue ? 'OVERDUE ' : ''}
              {f.due_date}
            </span>
            <div className="followup__main">
              <div className="followup__subject">
                <ActivityBadge type={f.type} /> {f.subject}
              </div>
              <div className="followup__link mono">
                {f.deal_id && f.deal_title && (
                  <button className="linklike" onClick={() => onOpenDeal(f.deal_id!)}>
                    {f.deal_title}
                  </button>
                )}
                {f.deal_id && f.contact_id && ' · '}
                {f.contact_id && f.contact_name && (
                  <button className="linklike" onClick={() => onOpenContact(f.contact_id!)}>
                    {f.contact_name}
                  </button>
                )}
              </div>
            </div>
            <button className="rowbtn" onClick={() => void markDone(f.id)}>
              MARK DONE
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
