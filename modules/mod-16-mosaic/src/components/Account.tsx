import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  AccountError,
  accountApi,
  currentEndpoint,
  disablePush,
  enablePush,
  pushSupport,
  type AccountState,
  type Person,
  type Prefs,
} from '../account-api';
import { QrCode } from './QrCode';

/**
 * The person's account page — copy-in for both shells (server/account.ts is
 * the other half). Every change is decided by PS-01 or PS-03; this screen
 * only asks, and shows what they answered.
 */

/** The categories modules file their notifications under (docs/NOTIFICATIONS-PLAN.md). */
const CATEGORIES: { key: string; label: string }[] = [
  { key: 'approvals', label: 'Approvals waiting for me' },
  { key: 'assignments', label: 'Things assigned to me' },
  { key: 'replies', label: 'Replies from customers' },
  { key: 'outcomes', label: 'My requests approved, rejected or paid' },
  { key: 'deadlines', label: 'Deadlines and due dates' },
  { key: 'reminders', label: 'Reminders (timesheets, timers)' },
  { key: 'alerts', label: 'Thresholds and stock alerts' },
  { key: 'operations', label: 'Service outages and backups' },
];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function message(err: unknown): string {
  if (err instanceof AccountError) return err.details.length > 0 ? `${err.message}: ${err.details.map((d) => `${d.field} ${d.message}`).join(', ')}` : err.message;
  return err instanceof Error ? err.message : 'Something went wrong';
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="account__section">
      <h3 className="account__heading mono">{title}</h3>
      {children}
    </section>
  );
}

function Codes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <div className="account__codes">
      <p className="account__hint mono">RECOVERY CODES — EACH SIGNS YOU IN ONCE IF YOUR PHONE IS LOST. SHOWN ONLY NOW.</p>
      <ol className="login__codes mono">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ol>
      <div className="account__row">
        <button className="btn mono" onClick={() => window.print()}>
          PRINT
        </button>
        <button className="btn btn--primary mono" onClick={onDone}>
          I HAVE SAVED THEM
        </button>
      </div>
    </div>
  );
}

function TwoFactor({ state, reload, say }: { state: AccountState; reload: () => void; say: (t: string, bad?: boolean) => void }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<{ secret: string; otpauth_uri: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const on = state.mfa?.totp_enabled === true;

  const run = (work: () => Promise<void>) => (e: FormEvent) => {
    e.preventDefault();
    work().catch((err) => say(message(err), true));
  };

  if (codes) {
    return (
      <Codes
        codes={codes}
        onDone={() => {
          setCodes(null);
          reload();
        }}
      />
    );
  }

  if (!on && setup) {
    return (
      <form className="account__form" onSubmit={run(async () => {
        const out = await accountApi.mfaConfirm(code);
        setSetup(null);
        setCode('');
        setCodes(out.recovery_codes);
        say('Two-factor sign-in is on. Every other session was signed out.');
      })}>
        <p className="account__hint mono">SCAN WITH AN AUTHENTICATOR APP (GOOGLE OR MICROSOFT AUTHENTICATOR, AEGIS, 1PASSWORD …).</p>
        <QrCode text={setup.otpauth_uri} label="QR code for your authenticator app" />
        <p className="account__hint mono">
          OR TYPE THIS KEY: <span className="login__secret">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</span>
        </p>
        <label className="field">
          <span className="field__label mono">THE CODE YOUR APP SHOWS</span>
          <input className="field__input" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" inputMode="numeric" />
        </label>
        <div className="account__row">
          <button className="btn mono" type="button" onClick={() => setSetup(null)}>
            CANCEL
          </button>
          <button className="btn btn--primary mono" type="submit">
            SWITCH ON
          </button>
        </div>
      </form>
    );
  }

  return (
    <>
      <p className="account__status mono">
        {on
          ? `ON SINCE ${state.mfa?.enabled_at?.slice(0, 10)} · ${state.mfa?.recovery_codes_left} RECOVERY CODES LEFT`
          : 'OFF — YOUR PASSWORD ALONE SIGNS YOU IN.'}
        {state.organization?.mfa_required ? ' · REQUIRED BY YOUR ORGANIZATION' : ''}
      </p>
      <form className="account__form" onSubmit={(e) => e.preventDefault()}>
        <label className="field">
          <span className="field__label mono">YOUR PASSWORD</span>
          <input className="field__input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </label>
        {on && (
          <label className="field">
            <span className="field__label mono">A CODE FROM YOUR APP (OR A RECOVERY CODE)</span>
            <input className="field__input" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" />
          </label>
        )}
        <div className="account__row">
          {!on && (
            <button className="btn btn--primary mono" onClick={run(async () => setSetup(await accountApi.mfaSetup(password)))}>
              SET UP TWO-FACTOR SIGN-IN
            </button>
          )}
          {on && (
            <button
              className="btn mono"
              onClick={run(async () => {
                setCodes((await accountApi.renewCodes(password, code)).recovery_codes);
                setCode('');
              })}
            >
              NEW RECOVERY CODES
            </button>
          )}
          {on && !state.organization?.mfa_required && (
            <button
              className="btn mono"
              onClick={run(async () => {
                await accountApi.mfaDisable(password, code);
                say('Two-factor sign-in is off.');
                reload();
              })}
            >
              TURN OFF
            </button>
          )}
        </div>
      </form>
    </>
  );
}

function Password({ say, onSignedOut }: { say: (t: string, bad?: boolean) => void; onSignedOut: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  return (
    <form
      className="account__form"
      onSubmit={(e) => {
        e.preventDefault();
        accountApi
          .changePassword(current, next)
          .then(() => {
            say('Password changed. Every other session was signed out.');
            setCurrent('');
            setNext('');
            onSignedOut();
          })
          .catch((err) => say(message(err), true));
      }}
    >
      <label className="field">
        <span className="field__label mono">CURRENT PASSWORD</span>
        <input className="field__input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
      </label>
      <label className="field">
        <span className="field__label mono">NEW PASSWORD (8 CHARACTERS OR MORE)</span>
        <input className="field__input" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
      </label>
      <button className="btn btn--primary mono" type="submit">
        CHANGE PASSWORD
      </button>
    </form>
  );
}

/** The digest and quiet-hours form, for a person — and, for an administrator, the defaults. */
function PrefsForm({ prefs, onSave, defaults = false }: { prefs: Prefs; onSave: (p: Partial<Prefs>) => Promise<void>; defaults?: boolean }) {
  const [p, setP] = useState(prefs);
  useEffect(() => setP(prefs), [prefs]);
  const toggleDay = (d: number) => setP({ ...p, workdays: p.workdays.includes(d) ? p.workdays.filter((x) => x !== d) : [...p.workdays, d].sort() });
  const toggleMute = (c: string) => setP({ ...p, muted: p.muted.includes(c) ? p.muted.filter((x) => x !== c) : [...p.muted, c] });
  return (
    <form
      className="account__form"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(p);
      }}
    >
      <div className="account__grid">
        <label className="field">
          <span className="field__label mono">
            <input type="checkbox" checked={p.briefing.enabled} onChange={(e) => setP({ ...p, briefing: { ...p.briefing, enabled: e.target.checked } })} />{' '}
            MORNING BRIEFING AT
          </span>
          <input className="field__input" type="time" value={p.briefing.at} onChange={(e) => setP({ ...p, briefing: { ...p.briefing, at: e.target.value } })} />
        </label>
        <label className="field">
          <span className="field__label mono">
            <input type="checkbox" checked={p.wrapup.enabled} onChange={(e) => setP({ ...p, wrapup: { ...p.wrapup, enabled: e.target.checked } })} />{' '}
            END-OF-DAY WRAP-UP AT
          </span>
          <input className="field__input" type="time" value={p.wrapup.at} onChange={(e) => setP({ ...p, wrapup: { ...p.wrapup, at: e.target.value } })} />
        </label>
        <label className="field">
          <span className="field__label mono">
            <input type="checkbox" checked={p.quiet !== null} onChange={(e) => setP({ ...p, quiet: e.target.checked ? { from: '19:00', to: '07:00' } : null })} />{' '}
            QUIET FROM
          </span>
          <input className="field__input" type="time" disabled={!p.quiet} value={p.quiet?.from ?? ''} onChange={(e) => p.quiet && setP({ ...p, quiet: { ...p.quiet, from: e.target.value } })} />
        </label>
        <label className="field">
          <span className="field__label mono">QUIET UNTIL</span>
          <input className="field__input" type="time" disabled={!p.quiet} value={p.quiet?.to ?? ''} onChange={(e) => p.quiet && setP({ ...p, quiet: { ...p.quiet, to: e.target.value } })} />
        </label>
        <label className="field">
          <span className="field__label mono">DIGESTS BY</span>
          <select className="field__input" value={p.digest_via} onChange={(e) => setP({ ...p, digest_via: e.target.value as Prefs['digest_via'] })}>
            <option value="push">Push</option>
            <option value="email">Email</option>
            <option value="both">Push and email</option>
          </select>
        </label>
        <label className="field">
          <span className="field__label mono">TIME ZONE</span>
          <input className="field__input" value={p.timezone} onChange={(e) => setP({ ...p, timezone: e.target.value })} />
        </label>
      </div>
      <fieldset className="account__days">
        <legend className="field__label mono">WORKING DAYS (DIGESTS)</legend>
        {DAYS.map((d, i) => (
          <label key={d} className="mono">
            <input type="checkbox" checked={p.workdays.includes(i + 1)} onChange={() => toggleDay(i + 1)} /> {d}
          </label>
        ))}
      </fieldset>
      <label className="account__check mono">
        <input type="checkbox" checked={p.lock_screen_details} onChange={(e) => setP({ ...p, lock_screen_details: e.target.checked })} /> SHOW DETAILS
        (NAMES, AMOUNTS) ON THE LOCK SCREEN
      </label>
      <fieldset className="account__mutes">
        <legend className="field__label mono">{defaults ? 'MUTED FOR EVERYONE BY DEFAULT' : 'NOTIFY ME ABOUT'}</legend>
        {CATEGORIES.map((c) => (
          <label key={c.key} className="mono">
            <input type="checkbox" checked={defaults ? p.muted.includes(c.key) : !p.muted.includes(c.key)} onChange={() => toggleMute(c.key)} /> {c.label}
          </label>
        ))}
        <span className="account__hint mono">SECURITY NOTICES ABOUT YOUR ACCOUNT ALWAYS COME, AT ANY HOUR.</span>
      </fieldset>
      <button className="btn btn--primary mono" type="submit">
        SAVE
      </button>
    </form>
  );
}

function Notifications({ say }: { say: (t: string, bad?: boolean) => void }) {
  const [config, setConfig] = useState<{ available: boolean; public_key: string | null } | null>(null);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [devices, setDevices] = useState<{ id: number; device: string | null; created_at: string }[]>([]);
  const [here, setHere] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const cfg = await accountApi.notifyConfig();
      setConfig(cfg);
      if (!cfg.available) return;
      const [p, d, endpoint] = await Promise.all([accountApi.prefs(), accountApi.devices(), currentEndpoint()]);
      setPrefs(p.prefs);
      setDevices(d.devices);
      setHere(endpoint);
    } catch (err) {
      say(message(err), true);
    }
  }, [say]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!config) return <p className="account__hint mono">LOADING…</p>;
  if (!config.available) return <p className="account__hint mono">NOTIFICATIONS ARE NOT SET UP ON THIS STACK (PS-03).</p>;
  const support = pushSupport();

  return (
    <>
      <div className="account__row">
        {!config.public_key ? (
          <span className="account__hint mono">PUSH IS NOT CONFIGURED (VAPID KEY) — DIGESTS AND NOTICES COME BY EMAIL.</span>
        ) : support === 'install-first' ? (
          <span className="account__hint mono">ON AN IPHONE OR IPAD: SHARE → ADD TO HOME SCREEN, OPEN THE APP FROM THERE, THEN SWITCH THIS ON.</span>
        ) : support === 'unsupported' ? (
          <span className="account__hint mono">THIS BROWSER CANNOT RECEIVE PUSH NOTIFICATIONS.</span>
        ) : support === 'denied' ? (
          <span className="account__hint mono">NOTIFICATIONS ARE BLOCKED FOR THIS APP IN THE BROWSER’S SETTINGS.</span>
        ) : here ? (
          <button className="btn mono" onClick={() => void disablePush().then(load).catch((e) => say(message(e), true))}>
            STOP NOTIFICATIONS ON THIS DEVICE
          </button>
        ) : (
          <button
            className="btn btn--primary mono"
            onClick={() =>
              void enablePush(config.public_key!)
                .then(() => {
                  say('This device now receives notifications.');
                  return load();
                })
                .catch((e) => say(message(e), true))
            }
          >
            NOTIFY ME ON THIS DEVICE
          </button>
        )}
      </div>
      {devices.length > 0 && (
        <ul className="account__devices mono">
          {devices.map((d) => (
            <li key={d.id}>
              {d.device ?? 'A device'} · SINCE {d.created_at.slice(0, 10)}
              <button className="btn mono" onClick={() => void accountApi.removeDevice({ id: d.id }).then(load).catch((e) => say(message(e), true))}>
                REMOVE
              </button>
            </li>
          ))}
        </ul>
      )}
      {prefs && (
        <PrefsForm
          prefs={prefs}
          onSave={async (p) => {
            try {
              setPrefs((await accountApi.setPrefs(p)).prefs);
              say('Saved.');
            } catch (err) {
              say(message(err), true);
            }
          }}
        />
      )}
    </>
  );
}

function Administration({ say, notifications }: { say: (t: string, bad?: boolean) => void; notifications: boolean }) {
  const [people, setPeople] = useState<Person[]>([]);
  const [required, setRequired] = useState(false);
  const [defaults, setDefaults] = useState<Prefs | null>(null);
  const [ops, setOps] = useState('');

  const load = useCallback(async () => {
    try {
      const list = await accountApi.people();
      setPeople(list.users);
      setRequired(list.organization.mfa_required);
      if (notifications) {
        const settings = await accountApi.defaults();
        setDefaults(settings.defaults);
        setOps(settings.ops_recipients.join(', '));
      }
    } catch (err) {
      say(message(err), true);
    }
  }, [say, notifications]);

  useEffect(() => {
    void load();
  }, [load]);

  const without = people.filter((p) => p.status === 'active' && !p.mfa_enabled).length;
  return (
    <>
      <label className="account__check mono">
        <input
          type="checkbox"
          checked={required}
          onChange={(e) => {
            const next = e.target.checked;
            if (next && !window.confirm('Everyone without a second factor sets one up at their next sign-in, and their open sessions end. Continue?')) return;
            void accountApi.setPolicy(next).then(load).catch((err) => say(message(err), true));
          }}
        />{' '}
        REQUIRE TWO-FACTOR SIGN-IN FOR EVERYONE {without > 0 ? `· ${without} WITHOUT ONE YET` : ''}
      </label>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Person</th>
              <th>Two-factor</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.id}>
                <td data-label="Person">
                  {p.name}
                  <br />
                  <span className="mono">{p.email}</span>
                </td>
                <td data-label="Two-factor" className="mono">{p.mfa_enabled ? 'ON' : 'OFF'}</td>
                <td data-label="Status" className="mono">{p.status.toUpperCase()}</td>
                <td data-label="">
                  <div className="account__row">
                    {p.mfa_enabled && (
                      <button
                        className="btn mono"
                        onClick={() => {
                          if (!window.confirm(`Reset ${p.name}'s second factor (lost phone)? They will set it up again.`)) return;
                          void accountApi.resetFactor(p.id).then(load).catch((err) => say(message(err), true));
                        }}
                      >
                        RESET FACTOR
                      </button>
                    )}
                    <button
                      className="btn mono"
                      onClick={() => void accountApi.signOutPerson(p.id).then(() => say(`${p.name} was signed out everywhere.`)).catch((err) => say(message(err), true))}
                    >
                      SIGN OUT EVERYWHERE
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {defaults && (
        <form
          className="account__form"
          onSubmit={(e) => {
            e.preventDefault();
            const list = ops.split(/[\s,;]+/).filter(Boolean);
            void accountApi
              .setOpsRecipients(list)
              .then(() => say('Saved. Outages and failed backups go to them, at any hour.'))
              .catch((err) => say(message(err), true));
          }}
        >
          <label className="field">
            <span className="field__label mono">STACK ALERTS (A SERVICE DOWN, A FAILED BACKUP) GO TO</span>
            <input className="field__input" value={ops} onChange={(e) => setOps(e.target.value)} placeholder="it@company.example, boss@company.example" />
          </label>
          <button className="btn mono" type="submit">
            SAVE
          </button>
        </form>
      )}
      {defaults && (
        <>
          <h4 className="account__heading mono">NOTIFICATION DEFAULTS FOR EVERYONE</h4>
          <PrefsForm
            defaults
            prefs={defaults}
            onSave={async (p) => {
              try {
                setDefaults((await accountApi.setDefaults(p)).defaults);
                say('Defaults saved. People who changed a setting themselves keep theirs.');
              } catch (err) {
                say(message(err), true);
              }
            }}
          />
        </>
      )}
    </>
  );
}

export function Account({ onClose, onSignInAgain }: { onClose: () => void; onSignInAgain: () => void }) {
  const [state, setState] = useState<AccountState | null>(null);
  const [toast, setToast] = useState<{ text: string; bad: boolean } | null>(null);
  const say = useCallback((text: string, bad = false) => {
    setToast({ text, bad });
    window.setTimeout(() => setToast(null), 5000);
  }, []);

  const reload = useCallback(() => {
    accountApi
      .account()
      .then(setState)
      .catch((err) => say(message(err), true));
  }, [say]);

  useEffect(reload, [reload]);

  return (
    <div className="sheet" role="dialog" aria-label="Your account">
      <div className="sheet__head">
        <h2 className="sheet__title mono">YOUR ACCOUNT{state?.user ? ` · ${state.user.email}` : ''}</h2>
        <button className="btn mono" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      {!state && <p className="account__hint mono">LOADING…</p>}
      {state && !state.sso && <p className="account__hint mono">THIS STACK SIGNS IN LOCALLY — ACCOUNTS ARE MANAGED BY PS-01 IDENTITY, WHICH IS NOT CONFIGURED.</p>}
      {state && state.sso && !state.signed_in_recently && (
        <div className="account__section">
          <p className="account__hint mono">FOR CHANGES TO YOUR ACCOUNT, SIGN IN AGAIN — IT HAS BEEN A WHILE.</p>
          <button className="btn btn--primary mono" onClick={onSignInAgain}>
            SIGN IN AGAIN
          </button>
        </div>
      )}
      {state?.signed_in_recently && (
        <>
          <Section title="TWO-FACTOR SIGN-IN">
            <TwoFactor state={state} reload={reload} say={say} />
          </Section>
          <Section title="PASSWORD">
            <Password say={say} onSignedOut={reload} />
          </Section>
          <Section title="SIGN OUT EVERYWHERE ELSE">
            <p className="account__hint mono">LOST A PHONE OR LAPTOP? THIS ENDS EVERY OTHER SESSION AND STOPS NOTIFICATIONS ON EVERY OTHER DEVICE.</p>
            <button
              className="btn mono"
              onClick={() =>
                void currentEndpoint()
                  .then((keep) => accountApi.signOutEverywhere(keep))
                  .then((out) => say(`Signed out everywhere else · ${out.devices_removed} device(s) removed.`))
                  .catch((err) => say(message(err), true))
              }
            >
              SIGN OUT EVERYWHERE ELSE
            </button>
          </Section>
        </>
      )}
      {state?.sso && state.notifications && state.actor.includes('@') && (
        <Section title="NOTIFICATIONS">
          <Notifications say={say} />
        </Section>
      )}
      {state?.admin && (
        <Section title="ADMINISTRATION">
          <Administration say={say} notifications={state.notifications} />
        </Section>
      )}
      {toast && <div className={`toast mono${toast.bad ? ' toast--bad' : ''}`}>{toast.text}</div>}
    </div>
  );
}
