import { createApp } from './app.js';
import { assertProductionConfig } from './guard.js';
import { hardeningFromEnv } from './hardening.js';
import { configFromEnv } from './config.js';
import { openDb } from './db.js';
import { seed } from './seed.js';
import { assertKeyStoreReadable, loadKeySecret } from './keystore.js';
import { Transport, httpPost } from './transport.js';
import { tick } from './downloads.js';
import { nowIso } from './connections.js';
import { pruneExchanges, sqliteRecorder } from './exchanges.js';
import { chainHead, verifyChain } from './chain.js';

const config = configFromEnv();
assertProductionConfig([
  { name: 'SESSION_SECRET', value: config.auth.secret },
  { name: 'ADMIN_PASSWORD', value: config.auth.password },
  { name: 'SERVICE_TOKEN', value: config.auth.serviceToken },
  { name: 'EBICS_KEY_SECRET', value: config.keySecret },
]);

const db = openDb(config.databasePath);

/**
 * Prove the key store still opens before accepting a single request.
 *
 * `deploy/provision.mjs` mints a fresh random value for every declared secret
 * on every provision, so re-provisioning a live stack rotates
 * `EBICS_KEY_SECRET` — and a service that booted anyway would look healthy,
 * accept a payment run, and only discover at signing time that it cannot reach
 * its own key. Failing here, loudly, while a human is still watching the logs
 * is the only useful moment to find out.
 */
assertKeyStoreReadable(db, loadKeySecret(config.keySecret));

await seed(db);

/**
 * Every conversation with a bank is written down, whole.
 *
 * One recorder for both transports, so nothing reaches a bank without leaving
 * a copy of what was sent and what came back. See `server/exchanges.ts` for
 * why the bytes and not just the verdict.
 */
const record = sqliteRecorder(db);

const app = createApp({
  db,
  auth: config.auth,
  keySecret: config.keySecret,
  transport: new Transport({ post: httpPost, egress: config.egress, record }),
  hardening: hardeningFromEnv(),
  logRequests: true,
});

const transport = new Transport({ post: httpPost, egress: config.egress, record });

app.listen(config.port, () => {
  console.log(`[ps-12] banking API on http://localhost:${config.port}`);
  if (config.auth.secret === 'dev-secret-change-me' || config.auth.password === 'change-me') {
    console.warn('[ps-12] WARNING: using default credentials/secret — set real ones in production');
  }
  if (config.keySecret === '0'.repeat(64)) {
    console.warn(
      '[ps-12] WARNING: EBICS_KEY_SECRET is the shipped default, so the RSA keys that sign payments are ' +
        'encrypted under a value published in this repository. Set a real one (openssl rand -hex 32) — and ' +
        'back it up, because losing it means re-initialising with the bank on paper.',
    );
  }
  console.log('[ps-12] note: no part of this service has been tested against a real bank');

  /**
   * Print the chain head, and say so when it no longer holds.
   *
   * The head goes to stdout on purpose: a hash chain cannot prove the whole
   * database was not rewritten, but a head hash that already left the
   * container — into a log shipper, a screenshot, an operator's note — is a
   * value the rewrite would have to match and cannot. This one line is the
   * cheapest external anchor there is.
   */
  // The cheap pass: boot must not block for seconds re-hashing every stored
  // envelope. A link that no longer chains, or a chain that no longer reaches
  // its head, is the loud case and this catches it; the full check is
  // `GET /api/audit/chain`.
  const verdict = verifyChain(db, { content: false });
  console.log(`[ps-12] audit chain: ${verdict.count} links, head ${chainHead(db) ?? '(empty)'}`);
  if (!verdict.valid) {
    console.error(`[ps-12] WARNING: the audit chain does not hold — ${verdict.message ?? 'unknown break'}`);
  } else {
    console.log('[ps-12] note: that is the links-only check — GET /api/audit/chain re-derives the records too');
  }

  if (config.tickIntervalMs > 0) {
    // The internal ticker: poll the banks for statements and status reports on
    // a timer, so a single-service deployment needs no external cron. The
    // generated compose stack supplies its own ticker sidecar and leaves this
    // at 0; `POST /api/tick` works either way.
    //
    // `TICK_INTERVAL_MS` was parsed and documented for a while with nothing
    // reading it, so a deployment outside the compose stack polled the bank
    // exactly never and quietly stopped reconciling.
    const timer = setInterval(() => {
      void tick({ db, keySecret: loadKeySecret(config.keySecret), transport, actor: 'ticker', now: nowIso })
        .then((result) => {
          for (const problem of result.problems) {
            console.warn(`[ps-12] tick: ${problem.connection}: ${problem.message}`);
          }
          // Age out the conversation log on the same beat, so a long-running
          // deployment does not need a second scheduled job to stay small.
          const pruned = pruneExchanges(db, config.exchangeRetentionDays, nowIso);
          if (pruned > 0) console.log(`[ps-12] pruned ${pruned} bank exchanges past the retention window`);
        })
        .catch((err: unknown) => console.error('[ps-12] tick error', err));
    }, config.tickIntervalMs);
    timer.unref?.();
    console.log(`[ps-12] internal ticker every ${config.tickIntervalMs}ms`);
  } else {
    console.log('[ps-12] note: downloads only arrive while POST /api/tick is called (the stack ticker does this)');
  }
});
