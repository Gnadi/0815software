import { useCallback, useEffect, useState } from 'react';
import type { AppConfig, PoRow } from '../../shared/types';
import { api, ApiError, exportCsvUrl } from '../api';
import { fmtEur } from '../format';

interface Props {
  config: AppConfig;
  onAuthLost: () => void;
}

export function ExportView({ config, onAuthLost }: Props) {
  const [ordered, setOrdered] = useState<PoRow[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const { pos } = await api.pos(new URLSearchParams({ status: 'ordered' }));
      setOrdered(pos);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, [onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ PRC.04 · ERP EXPORT</div>
          <h1 className="resource__title">CSV Export</h1>
          <p className="resource__desc">
            Ordered POs, one CSV row per line, rendered through a declarative profile. Profiles are server
            config (server/export-profiles.ts) — adding an ERP format is one config entry, zero code.
          </p>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="stat-row">
        <div className="stat">
          <div className="stat__label mono">ORDERED POS IN EXPORT</div>
          <div className="stat__value">{ordered ? ordered.length : '…'}</div>
        </div>
        <div className="stat">
          <div className="stat__label mono">EXPORT VOLUME (NET)</div>
          <div className="stat__value">{ordered ? fmtEur(ordered.reduce((s, p) => s + p.total_cents, 0)) : '…'}</div>
        </div>
      </div>

      <div className="section-title mono">PROFILES</div>
      <div className="profiles">
        {config.profiles.map((profile) => (
          <div key={profile.name} className="profile">
            <div className="profile__name mono">
              {profile.name} <span className="table__id">· delimiter “{profile.delimiter}”</span>
            </div>
            <div className="profile__desc">{profile.description}</div>
            <div className="profile__cols mono">{profile.columns.map((c) => c.header).join(' · ')}</div>
            <a className="btn btn--primary" href={exportCsvUrl(profile.name)}>
              DOWNLOAD CSV ↓
            </a>
          </div>
        ))}
      </div>

      <div className="section-title mono">WHAT GETS EXPORTED</div>
      <p className="resource__desc">
        POs whose status is <span className="mono">ordered</span> — fully approved and sent to the supplier,
        not yet closed. Close a PO after importing it into your ERP to take it out of the next export.
      </p>
    </div>
  );
}
