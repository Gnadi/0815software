import { useCallback, useEffect, useState } from 'react';
import { accountApi, setBadge, type Inbox as InboxModel } from '../account-api';

/**
 * "Waiting for you" — copy-in for both shells. Every module's inbox for this
 * person (server/account.ts collects them), oldest first. Tapping an entry
 * opens the module it belongs to.
 */
export function Inbox({ onOpen, onClose }: { onOpen: (moduleId: string) => void; onClose: () => void }) {
  const [inbox, setInbox] = useState<InboxModel | null>(null);
  const [problem, setProblem] = useState('');

  const load = useCallback(async () => {
    try {
      const next = await accountApi.inbox();
      setInbox(next);
      setBadge(next.count);
      setProblem('');
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'Could not load what waits for you');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="sheet" role="dialog" aria-label="Waiting for you">
      <div className="sheet__head">
        <h2 className="sheet__title mono">WAITING FOR YOU{inbox ? ` · ${inbox.count}` : ''}</h2>
        <button className="btn mono" onClick={() => void load()}>
          REFRESH
        </button>
        <button className="btn mono" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      {problem && <p className="sheet__problem mono">{problem}</p>}
      {inbox && inbox.items.length === 0 && inbox.unavailable.length === 0 && (
        <p className="sheet__empty mono">NOTHING WAITS FOR YOU RIGHT NOW.</p>
      )}
      {inbox && (
        <ul className="inbox">
          {inbox.items.map((item) => (
            <li key={`${item.module}:${item.id}`}>
              <button className={`inbox__item tone--${item.tone}`} onClick={() => onOpen(item.module)}>
                <span className="inbox__module mono">{item.label.toUpperCase()}</span>
                <span className="inbox__title">{item.title}</span>
                {item.detail && <span className="inbox__detail">{item.detail}</span>}
                {item.at && <span className="inbox__at mono">{item.at.slice(0, 10)}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {inbox && inbox.count > inbox.items.length && (
        <p className="sheet__empty mono">AND {inbox.count - inbox.items.length} MORE IN THE MODULES THEMSELVES.</p>
      )}
      {inbox && inbox.unavailable.length > 0 && (
        <p className="sheet__problem mono">
          NOT ANSWERING: {inbox.unavailable.map((u) => u.module).join(', ')} — THIS LIST MAY BE SHORT.
        </p>
      )}
    </div>
  );
}
