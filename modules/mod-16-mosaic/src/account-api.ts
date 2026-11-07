/**
 * The shell's account, notification and inbox calls (server/account.ts) —
 * copy-in for MOD-15 and MOD-16, with its own tiny fetch so it does not
 * depend on either shell's api.ts.
 */

export interface FieldProblem {
  field: string;
  message: string;
}

export class AccountError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details: FieldProblem[] = [],
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? 'GET',
    credentials: 'same-origin',
    headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) throw new AccountError(res.status, String(json.error ?? `Request failed (${res.status})`), (json.details as FieldProblem[]) ?? []);
  return json as T;
}

export interface Prefs {
  timezone: string;
  workdays: number[];
  briefing: { enabled: boolean; at: string };
  wrapup: { enabled: boolean; at: string };
  quiet: { from: string; to: string } | null;
  digest_via: 'push' | 'email' | 'both';
  lock_screen_details: boolean;
  muted: string[];
}

export interface AccountState {
  sso: boolean;
  notifications: boolean;
  actor: string;
  signed_in_recently: boolean;
  user?: { id: number; email: string; name: string };
  organization?: { name: string; mfa_required: boolean };
  mfa?: { totp_enabled: boolean; enabled_at: string | null; recovery_codes_left: number };
  admin?: boolean;
}

export interface Person {
  id: number;
  email: string;
  name: string;
  status: string;
  mfa_enabled: boolean;
}

export interface InboxEntry {
  id: string;
  kind: string;
  title: string;
  detail: string | null;
  tone: 'neutral' | 'good' | 'warn' | 'bad';
  at: string | null;
  href: string | null;
  module: string;
  label: string;
}

export interface Inbox {
  count: number;
  items: InboxEntry[];
  unavailable: { module: string; problem: string }[];
}

export const accountApi = {
  account: () => call<AccountState>('/api/account'),
  mfaSetup: (current_password: string) =>
    call<{ secret: string; otpauth_uri: string }>('/api/account/mfa/setup', { method: 'POST', body: { current_password } }),
  mfaConfirm: (otp: string) => call<{ recovery_codes: string[] }>('/api/account/mfa/confirm', { method: 'POST', body: { otp } }),
  mfaDisable: (current_password: string, otp: string) =>
    call<unknown>('/api/account/mfa/disable', { method: 'POST', body: { current_password, otp } }),
  renewCodes: (current_password: string, otp: string) =>
    call<{ recovery_codes: string[] }>('/api/account/mfa/recovery-codes', { method: 'POST', body: { current_password, otp } }),
  changePassword: (current_password: string, new_password: string) =>
    call<unknown>('/api/account/password', { method: 'POST', body: { current_password, new_password } }),
  signOutEverywhere: (keep_endpoint: string | null) =>
    call<{ devices_removed: number }>('/api/account/sessions/revoke', { method: 'POST', body: keep_endpoint ? { keep_endpoint } : {} }),

  people: () => call<{ organization: { mfa_required: boolean }; users: Person[] }>('/api/admin/users'),
  resetFactor: (id: number) => call<unknown>(`/api/admin/users/${id}/mfa/reset`, { method: 'POST' }),
  signOutPerson: (id: number) => call<unknown>(`/api/admin/users/${id}/sessions/revoke`, { method: 'POST' }),
  setPolicy: (mfa_required: boolean) => call<unknown>('/api/admin/policy', { method: 'PUT', body: { mfa_required } }),
  defaults: () => call<{ defaults: Prefs; ops_recipients: string[] }>('/api/admin/notify-settings'),
  setDefaults: (defaults: Partial<Prefs>) => call<{ defaults: Prefs }>('/api/admin/notify-settings', { method: 'PUT', body: { defaults } }),
  /** Who hears about the stack itself — outages, a failed backup. */
  setOpsRecipients: (ops_recipients: string[]) =>
    call<{ ops_recipients: string[] }>('/api/admin/notify-settings', { method: 'PUT', body: { ops_recipients } }),

  notifyConfig: () => call<{ available: boolean; public_key: string | null }>('/api/notify/config'),
  prefs: () => call<{ prefs: Prefs }>('/api/notify/prefs'),
  setPrefs: (prefs: Partial<Prefs>) => call<{ prefs: Prefs }>('/api/notify/prefs', { method: 'PUT', body: { prefs } }),
  devices: () => call<{ devices: { id: number; device: string | null; created_at: string; last_sent_at: string | null }[] }>('/api/notify/devices'),
  addDevice: (subscription: PushSubscriptionJSON, device: string) =>
    call<unknown>('/api/notify/devices', { method: 'POST', body: { subscription, device } }),
  removeDevice: (which: { id?: number; endpoint?: string }) => call<unknown>('/api/notify/devices/remove', { method: 'POST', body: which }),

  inbox: () => call<Inbox>('/api/inbox'),
  inboxCount: () => call<{ count: number }>('/api/inbox/count'),
};

// ── Push on this device ────────────────────────────────────────────────

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** A name for this device in the list, from what the browser says it is. */
export function deviceName(): string {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'macOS' : 'Linux';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox/.test(ua) ? 'Firefox' : /Chrome|CriOS/.test(ua) ? 'Chrome' : 'Safari';
  return `${browser} on ${os}`;
}

export type PushSupport = 'ok' | 'unsupported' | 'install-first' | 'denied';

/**
 * Whether this device can receive pushes at all. An iPhone or iPad only can
 * from the app on the Home Screen, never from a Safari tab — said, rather than
 * a button that fails without a word.
 */
export function pushSupport(): PushSupport {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    const ios = /iPhone|iPad/.test(navigator.userAgent);
    const standalone = window.matchMedia('(display-mode: standalone)').matches;
    return ios && !standalone ? 'install-first' : 'unsupported';
  }
  if (Notification.permission === 'denied') return 'denied';
  return 'ok';
}

export async function currentEndpoint(): Promise<string | null> {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub?.endpoint ?? null;
}

/** Ask for permission (only ever after a tap) and register this device. */
export async function enablePush(publicKey: string): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new AccountError(403, 'Notifications were not allowed for this app');
  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  await accountApi.addDevice(sub.toJSON(), deviceName());
}

export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await accountApi.removeDevice({ endpoint: sub.endpoint }).catch(() => undefined);
  await sub.unsubscribe();
}

/** Show what waits on the app icon — a number the modules counted just now. */
export function setBadge(count: number): void {
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  if (!nav.setAppBadge) return;
  void (count > 0 ? nav.setAppBadge(count) : nav.clearAppBadge?.())?.catch(() => undefined);
}
