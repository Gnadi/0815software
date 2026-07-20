import type { AppConfig } from '../../shared/types';
import { fmtMinutes } from '../format';

interface Props {
  config: AppConfig;
}

export function SlaPolicyView({ config }: Props) {
  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ SUP.04 · POLICY</div>
          <h1 className="resource__title">SLA policy</h1>
          <p className="resource__desc">
            Targets are wall-clock elapsed time from the moment a ticket is created. First response is met by
            the first public agent reply; resolution is met the first time a ticket enters <em>resolved</em>. A
            leg goes at-risk within {config.at_risk_minutes} minutes of its due time. Business hours / calendars
            are out of scope. This table is rendered straight from{' '}
            <span className="mono">server/sla-config.ts</span> — the single source of truth.
          </p>
        </div>
      </div>

      <div className="table-wrap" style={{ maxWidth: 620 }}>
        <table className="table" style={{ minWidth: 0 }}>
          <thead>
            <tr>
              <th className="mono">PRIORITY</th>
              <th className="mono">FIRST RESPONSE</th>
              <th className="mono">RESOLUTION</th>
            </tr>
          </thead>
          <tbody>
            {config.priorities.map((p) => (
              <tr key={p}>
                <td>
                  <span className={`badge mono badge--${p}`}>{p.toUpperCase()}</span>
                </td>
                <td className="mono">{fmtMinutes(config.sla[p].first_response_minutes)}</td>
                <td className="mono">{fmtMinutes(config.sla[p].resolution_minutes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section-title mono">STATUS WORKFLOW</div>
      <div className="table-wrap" style={{ maxWidth: 620 }}>
        <table className="table" style={{ minWidth: 0 }}>
          <thead>
            <tr>
              <th className="mono">STATUS</th>
              <th className="mono">CAN MOVE TO</th>
            </tr>
          </thead>
          <tbody>
            {config.statuses.map((s) => (
              <tr key={s}>
                <td>
                  <span className={`badge mono badge--${s}`}>{s.toUpperCase()}</span>
                </td>
                <td className="mono table__id">
                  {config.transitions[s].length ? config.transitions[s].map((t) => t.toUpperCase()).join('  ·  ') : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
