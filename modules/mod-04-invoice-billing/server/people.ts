import { IdentityClient, NotificationClient, type AccessLevel, type NotifyUrgency } from '@0815software/platform-clients';
import { MODULE_SLUG } from './access.js';

/**
 * Telling PEOPLE that something waits for them (copy-in) — the module half of
 * docs/NOTIFICATIONS-PLAN.md. A module reports what happened and to whom it
 * matters; PS-03 decides whether that person hears now, in the morning
 * briefing or the evening wrap-up, or not at all (their mutes, their quiet
 * hours), and on which device.
 *
 * Recipients are PS-01 emails, named directly (the assignee, the requester)
 * or as "everyone who holds this level here" (`holders: 'manage'` — the
 * people who may approve), which PS-01 answers (`/api/directory/holders`).
 *
 * Opt-in and best-effort like every platform call: with NOTIFICATION_URL
 * unset nothing leaves the module, and PS-01 or PS-03 being down never fails
 * the write that caused the event (CLAUDE.md rule 1). Never awaited by a
 * route, and the person who caused it is never told about their own action.
 */

export interface PeopleConfig {
  notificationUrl?: string;
  identityUrl?: string;
  identityOrg?: string;
  serviceToken?: string;
}

export interface PersonEvent {
  kind: string;
  /** approvals · assignments · replies · outcomes · deadlines · reminders · alerts · operations */
  category: string;
  urgency: NotifyUrgency;
  /** Named people (PS-01 emails); anything without an @ is skipped. */
  recipients?: (string | null | undefined)[];
  /** Also everyone holding at least this level on this module. */
  holders?: AccessLevel;
  /** Who caused it — never notified. */
  actor?: string | null;
  /** Safe on a lock screen: no names, amounts or customers. */
  title: string;
  /** The specifics, inside the app (or on the lock screen if the person chose that). */
  detail?: string | null;
  href?: string | null;
  /** Through quiet hours: someone must act tonight (an SLA, a shop order). */
  oncall?: boolean;
  /** Same key + same person = one notification, however often reported. */
  key: string;
}

export interface People {
  readonly enabled: boolean;
  notify(event: PersonEvent): void;
  /** Settles once every notification reported so far has been handed over (tests). */
  flush(): Promise<void>;
}

export const noopPeople: People = {
  enabled: false,
  notify() {},
  async flush() {},
};

const HOLDERS_TTL_MS = 60_000;

export function buildPeople(cfg: PeopleConfig, options: { fetch?: typeof fetch; now?: () => number } = {}): People {
  if (!cfg.notificationUrl || !cfg.serviceToken) return noopPeople;
  const fetchImpl = options.fetch as never;
  const now = options.now ?? Date.now;
  const notifier = new NotificationClient({ baseUrl: cfg.notificationUrl, serviceToken: cfg.serviceToken, fetch: fetchImpl });
  const identity =
    cfg.identityUrl && cfg.identityOrg
      ? new IdentityClient({ baseUrl: cfg.identityUrl, serviceToken: cfg.serviceToken, fetch: fetchImpl })
      : null;
  const cache = new Map<AccessLevel, { emails: string[]; until: number }>();
  let pending: Promise<unknown> = Promise.resolve();

  const holders = async (level: AccessLevel): Promise<string[]> => {
    if (!identity || !cfg.identityOrg) return [];
    const hit = cache.get(level);
    if (hit && hit.until > now()) return hit.emails;
    const { holders: emails } = await identity.holders(cfg.identityOrg, `module:${MODULE_SLUG}:${level}`);
    cache.set(level, { emails, until: now() + HOLDERS_TTL_MS });
    return emails;
  };

  return {
    enabled: true,
    notify(event) {
      const task = (async () => {
        const named = (event.recipients ?? []).filter((r): r is string => typeof r === 'string' && r.includes('@'));
        const byLevel = event.holders ? await holders(event.holders) : [];
        const actor = event.actor?.toLowerCase() ?? null;
        const recipients = [...new Set([...named, ...byLevel].map((r) => r.toLowerCase()))].filter((r) => r !== actor);
        if (recipients.length === 0) return;
        await notifier.event({
          module: MODULE_SLUG,
          kind: event.kind,
          category: event.category,
          urgency: event.urgency,
          recipients: recipients.slice(0, 100),
          actor,
          title: event.title,
          detail: event.detail ?? null,
          href: event.href ?? null,
          oncall: event.oncall === true,
          idempotency_key: `${MODULE_SLUG}:${event.key}`,
        });
      })().catch((err: unknown) => console.warn(`[${MODULE_SLUG}] notification failed:`, err));
      pending = Promise.all([pending, task]);
    },
    flush: () => pending.then(() => undefined),
  };
}
