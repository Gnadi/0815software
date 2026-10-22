import { createContext, useContext, type ReactNode } from 'react';

/**
 * What the signed-in person may do here, for the screens (copy-in).
 *
 * The server decides — `server/access.ts`, enforced in `server/auth.ts` — and a
 * hidden button is no protection. This only keeps the UI honest: nobody is
 * offered an action that would answer 403. The level comes from `GET /api/me`
 * and is provided once, at the top of the app.
 */
export type AccessLevel = 'view' | 'edit' | 'manage';

const RANK: Record<AccessLevel, number> = { view: 0, edit: 1, manage: 2 };

/** Without a provider everything shows: the server still says no where it must. */
const AccessContext = createContext<AccessLevel>('manage');

export function AccessProvider({ level, children }: { level: AccessLevel; children: ReactNode }) {
  return <AccessContext.Provider value={level}>{children}</AccessContext.Provider>;
}

/** The level the current screen runs at. */
export function useAccess(): AccessLevel {
  return useContext(AccessContext);
}

/** May the person do what needs `level`? */
export function useCan(level: AccessLevel = 'edit'): boolean {
  return RANK[useAccess()] >= RANK[level];
}

/** Render `children` only for someone who holds `level` (default `edit`). */
export function Can({ level = 'edit', children }: { level?: AccessLevel; children: ReactNode }) {
  return useCan(level) ? <>{children}</> : null;
}
