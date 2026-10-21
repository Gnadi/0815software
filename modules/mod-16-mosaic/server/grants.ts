import { accessLevelFor, type AccessLevel } from '@0815software/platform-clients';

/**
 * What each signed-in person may do in each OTHER module (copy-in, shared by
 * the two shells, MOD-15 and MOD-16).
 *
 * A shell signs its user into the modules on the board (`handoff.ts` on the
 * module's side). Each module would otherwise have to take the shell's word
 * for how much that person may do there — and before this file the shell's
 * word was always `manage`, which is why a shell admitted platform
 * administrators only. Now the shell keeps the PS-01 permissions it saw at
 * login and tells every module the level PS-01 grants on THAT module:
 * `module:<slug>:<level>`, exactly as the module would have derived it from a
 * login of its own.
 *
 * Four properties, each one deliberate:
 *
 * - **Frozen at login, like every module session.** A module session carries
 *   the level it was minted with for its whole lifetime; this holds the
 *   permissions for the shell session's lifetime, so a board never knows more
 *   or less than the module would.
 * - **In memory only.** A restart forgets them and the board asks the person
 *   to sign in again — never a guessed level.
 * - **No grant, no pane.** A module PS-01 grants nothing on is refused here,
 *   rather than opened at some default.
 * - **Standalone is unchanged.** Without SSO the only person who can sign in
 *   is the local admin, who manages everywhere, exactly as before.
 */

/** A module's registry slug is its id without the `mod-NN-` prefix. */
export function slugOf(moduleId: string): string {
  return moduleId.replace(/^mod-\d{2}-/, '');
}

export type LevelVerdict = { ok: true; access: AccessLevel } | { ok: false; problem: string };

export interface Grants {
  /** Remember what PS-01 said this person holds, for as long as their shell session lasts. */
  remember(actor: string, permissions: readonly string[]): void;
  /** The level to hand `moduleId` for this person, or why there is none. */
  levelFor(actor: string, moduleId: string): LevelVerdict;
  /** Forget a person (logout). */
  forget(actor: string): void;
  /** Held entries, for tests and the prune assertions. */
  size(): number;
}

export function createGrants(options: { sso: boolean; ttlMs: number; now?: () => number }): Grants {
  const now = options.now ?? Date.now;
  const held = new Map<string, { permissions: readonly string[]; expiresAt: number }>();

  const prune = (at: number): void => {
    for (const [actor, entry] of held) if (entry.expiresAt <= at) held.delete(actor);
  };

  return {
    remember(actor, permissions) {
      const at = now();
      prune(at);
      held.set(actor, { permissions: [...permissions], expiresAt: at + options.ttlMs });
    },

    levelFor(actor, moduleId) {
      if (!options.sso) return { ok: true, access: 'manage' };
      const at = now();
      const entry = held.get(actor);
      if (!entry || entry.expiresAt <= at) {
        held.delete(actor);
        return { ok: false, problem: 'sign in again — this board no longer knows what you may do in other modules' };
      }
      const access = accessLevelFor(entry.permissions, slugOf(moduleId));
      return access === null ? { ok: false, problem: 'you have no access to this module' } : { ok: true, access };
    },

    forget(actor) {
      held.delete(actor);
    },

    size() {
      prune(now());
      return held.size;
    },
  };
}
