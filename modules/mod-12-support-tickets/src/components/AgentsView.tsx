import type { Agent } from '../../shared/types';

interface Props {
  agents: Agent[];
}

export function AgentsView({ agents }: Props) {
  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ SUP.03 · TEAM</div>
          <h1 className="resource__title">Agents</h1>
          <p className="resource__desc">
            The support team tickets can be assigned to. Agents are seeded server-side; this catalogue module
            keeps the roster read-only and deliberately out of scope for editing (see the README).
          </p>
        </div>
      </div>

      <div className="table-wrap">
        <table className="table" style={{ minWidth: 520 }}>
          <thead>
            <tr>
              <th className="mono">NAME</th>
              <th className="mono">EMAIL</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id}>
                <td>{a.name}</td>
                <td className="mono table__id">{a.email}</td>
              </tr>
            ))}
            {agents.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={2}>
                  NO AGENTS SEEDED
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
