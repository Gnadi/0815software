import { useCallback, useEffect, useState } from 'react';
import { api, type PartyOption } from '../api';
import type { ShellContext } from '../../shared/types';

/**
 * The shared context: one customer and one date range, honoured by every widget.
 *
 * The customer is a PS-11 party id, never a name. That is what makes "the same
 * customer" mean the same thing in fourteen databases — a name would have to
 * match in all of them, and would silently half-match.
 *
 * When PS-11 is not wired the picker says so instead of offering an empty
 * search box, because an empty search box looks like "no customers" rather than
 * "this stack has no customer master".
 */

interface Props {
  context: ShellContext;
  customersConfigured: boolean;
  onChange: (context: ShellContext) => void;
}

export function ContextBar({ context, customersConfigured, onChange }: Props) {
  const [search, setSearch] = useState('');
  const [options, setOptions] = useState<PartyOption[] | null>(null);
  const [open, setOpen] = useState(false);

  const find = useCallback(async (q: string) => {
    try {
      const { parties } = await api.parties(q);
      setOptions(parties);
    } catch {
      setOptions([]);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => void find(search), 200);
    return () => clearTimeout(timer);
  }, [open, search, find]);

  return (
    <div className="ws__ctx">
      {context.party !== undefined ? (
        <span className="ws__chip mono">
          <span>{context.party_name ?? `PARTY ${context.party}`}</span>
          <button
            title="Show every customer again"
            onClick={() => onChange({ ...context, party: undefined, party_name: undefined })}
          >
            ✕
          </button>
        </span>
      ) : customersConfigured ? (
        <div style={{ position: 'relative' }}>
          <button className="ws__chip mono" onClick={() => setOpen((v) => !v)}>
            CUSTOMER: ALL
          </button>
          {open && (
            <div className="picker__card" style={{ position: 'absolute', top: '110%', left: 0, width: 300, zIndex: 40 }}>
              <input
                className="field__input"
                placeholder="Search customers…"
                value={search}
                autoFocus
                onChange={(e) => setSearch(e.target.value)}
              />
              <div className="rows" style={{ marginTop: 10 }}>
                {options === null && <span className="widget__stale mono">SEARCHING…</span>}
                {options?.length === 0 && <span className="widget__stale mono">NO MATCHES</span>}
                {options?.map((party) => (
                  <button
                    key={party.id}
                    className="picker__opt"
                    onClick={() => {
                      onChange({ ...context, party: party.id, party_name: party.name });
                      setOpen(false);
                      setSearch('');
                    }}
                  >
                    {party.name}
                    {party.vat_id ? ` · ${party.vat_id}` : ''}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <span className="ws__chip mono" title="Set CUSTOMERS_URL to filter the board by customer">
          NO CUSTOMER MASTER
        </span>
      )}

      <input
        className="ws__date"
        type="date"
        value={context.from ?? ''}
        title="From"
        onChange={(e) => onChange({ ...context, from: e.target.value || undefined })}
      />
      <input
        className="ws__date"
        type="date"
        value={context.to ?? ''}
        title="To"
        onChange={(e) => onChange({ ...context, to: e.target.value || undefined })}
      />
      {(context.from || context.to) && (
        <button
          className="ws__chip mono"
          onClick={() => onChange({ ...context, from: undefined, to: undefined })}
        >
          CLEAR DATES
        </button>
      )}
    </div>
  );
}
