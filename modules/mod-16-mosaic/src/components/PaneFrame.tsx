import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import type { PeerStatus } from '../../shared/types';
import { FRAME_ALLOW, offlineUrl } from '../frame';

/**
 * One pane: a whole module, running in its own process, drawn into a frame and
 * already signed in.
 *
 * THE TICKET IS SINGLE-USE, AND THAT SHAPES THIS ENTIRE COMPONENT. The URL from
 * `/api/embed/:moduleId` redeems exactly once, within thirty seconds, and the
 * module then sets its own cookie and redirects. So the src is fetched ONCE and
 * held in state; it must never be recomputed during a render, or a re-render
 * for any unrelated reason — a drag, a board rename — would point the frame at
 * a spent ticket and the module would answer 401 into a rectangle the person is
 * looking at.
 *
 * That is also why reloading is an explicit button rather than something the
 * browser could do on its own: after the redirect the frame is cross-origin, so
 * this window cannot reach into it, and a fresh view needs a fresh ticket.
 */
export function PaneFrame({ module: peer, offline = false }: { module: PeerStatus | undefined; offline?: boolean }) {
  const [src, setSrc] = useState('');
  const [problem, setProblem] = useState('');
  /** Bumped by RELOAD to ask for a new ticket; never by an ordinary render. */
  const [attempt, setAttempt] = useState(0);
  const live = useRef(true);

  const id = peer?.id;
  const open = useCallback(async () => {
    // Without a connection no ticket can come; an installable module opens
    // from the browser's copy instead (src/frame.ts), the rest say so below.
    if (!id || offline) return;
    try {
      const { url } = await api.embed(id);
      if (live.current) {
        setSrc(url);
        setProblem('');
      }
    } catch (err) {
      if (live.current) setProblem(err instanceof ApiError ? err.message : 'Could not open this module');
    }
  }, [id, offline]);

  useEffect(() => {
    live.current = true;
    void open();
    return () => {
      live.current = false;
    };
  }, [open, attempt]);

  if (!peer) {
    return <p className="pane__state mono">THIS MODULE IS NOT IN THIS STACK</p>;
  }
  if (!peer.configured) {
    return <p className="pane__state mono">{peer.label.toUpperCase()} IS NOT WIRED — SET {peer.id.replace(/^mod-\d+-/, '').toUpperCase()}_URL</p>;
  }
  if (!peer.embeddable) {
    return (
      <p className="pane__state mono">
        {peer.label.toUpperCase()} CANNOT BE FRAMED — NO PUBLIC URL, OR IT AUTHENTICATES ITS OWN END USERS
      </p>
    );
  }
  if (offline) {
    const url = offlineUrl(peer);
    if (!url) return <p className="pane__state mono">OFFLINE — {peer.label.toUpperCase()} NEEDS THE CONNECTION</p>;
    return <iframe className="pane__frame" src={url} title={peer.label} allow={FRAME_ALLOW} referrerPolicy="no-referrer" />;
  }
  if (problem) {
    return (
      <div className="pane__state mono">
        <p>{problem}</p>
        <button className="pane__retry mono" onClick={() => setAttempt((n) => n + 1)}>
          TRY AGAIN
        </button>
      </div>
    );
  }
  if (!src) return <p className="pane__state mono">OPENING {peer.label.toUpperCase()}…</p>;

  return (
    <iframe
      className="pane__frame"
      src={src}
      title={peer.label}
      // The module is a first-party component of this same stack, named in its
      // own SHELL_ORIGIN — not third-party content to be sandboxed away from
      // its own cookies. Its CSP frame-ancestors is what authorises this frame,
      // and that decision belongs to the module, not to this attribute.
      referrerPolicy="no-referrer"
      // The camera (a receipt's code, a barcode), the clipboard and full
      // screen are the module's to ask for — the frame only lets it ask.
      allow={FRAME_ALLOW}
    />
  );
}
