/**
 * What a shell grants the modules it frames, and how it lets go of them.
 *
 * - **The frame's permissions.** A module in a frame may use the camera (a
 *   receipt's code, a barcode), the clipboard and full screen only when the
 *   frame says so — the module still asks the person, as it would on its own.
 * - **Offline.** The last catalogue and arrangement are kept on this device,
 *   so the installed app opens without a connection and can show the modules
 *   that keep themselves in the browser (`installable`). Nothing about a
 *   person's work is kept here — that stays in the modules.
 * - **Signing out of everything.** The shell asks every module it can frame to
 *   end its own session and drop what it kept in this browser (each module's
 *   `GET /session/logout`), then ends its own.
 */

export const FRAME_ALLOW = 'camera; clipboard-read; clipboard-write; fullscreen';

/** What the shell knows of a module, as far as framing and signing out go. */
export interface FramedModule {
  embeddable: boolean;
  installable: boolean;
  publicUrl: string | null;
}

/** An installable module opened from the browser's copy, without a ticket. */
export function offlineUrl(peer: FramedModule, path = '/'): string | null {
  return peer.installable && peer.publicUrl ? `${peer.publicUrl.replace(/\/+$/, '')}${path}` : null;
}

export function keepOffline<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode or full: the app still works online */
  }
}

export function readOffline<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function forgetOffline(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* nothing kept */
  }
}

/** A failed fetch that never reached a server — no connection, not a refusal. */
export const isOffline = (err: unknown): boolean => err instanceof TypeError || !navigator.onLine;

/**
 * Load every framable module's sign-out in a hidden frame and wait for them —
 * a few seconds at most: a module that does not answer ends its session at its
 * own expiry, and signing out of the shell must not hang on it.
 */
export async function signOutOfModules(modules: readonly FramedModule[], timeoutMs = 4000): Promise<void> {
  const targets = modules.filter((m) => m.embeddable && m.publicUrl);
  await Promise.all(
    targets.map(
      (m) =>
        new Promise<void>((resolve) => {
          const frame = document.createElement('iframe');
          frame.style.display = 'none';
          frame.setAttribute('aria-hidden', 'true');
          frame.referrerPolicy = 'no-referrer';
          const done = () => {
            window.clearTimeout(timer);
            frame.remove();
            resolve();
          };
          const timer = window.setTimeout(done, timeoutMs);
          frame.addEventListener('load', done, { once: true });
          frame.src = `${m.publicUrl!.replace(/\/+$/, '')}/session/logout`;
          document.body.append(frame);
        }),
    ),
  );
}
