import { useCallback, useEffect, useState } from 'react';
import type { OrgNode } from '../../shared/types';
import { api, ApiError } from '../api';

interface Props {
  onOpen: (id: number) => void;
  onAuthLost: () => void;
}

export function OrgChartView({ onOpen, onAuthLost }: Props) {
  const [roots, setRoots] = useState<OrgNode[] | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const { roots: tree } = await api.orgChart();
      setRoots(tree);
      setError('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Failed to load the org chart');
    }
  }, [onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (id: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderNode = (node: OrgNode, depth: number) => {
    const isCollapsed = collapsed.has(node.id);
    return (
      <div key={node.id}>
        <div className="tree__row" style={{ paddingLeft: depth * 26 }}>
          {node.report_count > 0 ? (
            <button className="tree__toggle mono" onClick={() => toggle(node.id)} aria-label="toggle">
              {isCollapsed ? '▸' : '▾'}
            </button>
          ) : (
            <span className="tree__toggle tree__toggle--leaf mono">·</span>
          )}
          <button className="linklike" onClick={() => onOpen(node.id)}>
            {node.name}
          </button>
          <span className="tree__title">{node.job_title}</span>
          <span className="badge badge--dept mono">{node.department_code}</span>
          {node.report_count > 0 && (
            <span className="tree__count mono">
              {node.report_count} {node.report_count === 1 ? 'REPORT' : 'REPORTS'}
            </span>
          )}
        </div>
        {!isCollapsed && node.reports.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ DIR.03 · HIERARCHY</div>
          <h1 className="resource__title">Org chart</h1>
          <p className="resource__desc">
            Active employees only — the manager graph is a forest, enforced server-side.
          </p>
        </div>
        <div className="resource__actions">
          <button className="btn btn--ghost" onClick={() => setCollapsed(new Set())}>
            EXPAND ALL
          </button>
        </div>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="tree">
        {roots?.map((root) => renderNode(root, 0))}
        {roots && roots.length === 0 && <div className="table__empty mono">NO ACTIVE EMPLOYEES</div>}
      </div>
    </div>
  );
}
