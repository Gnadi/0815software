#!/usr/bin/env node
/**
 * Tell the stack's administrators something about the stack, from inside the
 * PS-03 container — what deploy/backup.sh calls when a nightly backup failed:
 *
 *   docker compose exec -T <ps-03> node scripts/ops-event.mjs <kind> <title> [detail]
 *
 * Posts to this container's own `/api/ops/events` with its SERVICE_TOKEN
 * (server/ops.ts). Exits non-zero when it could not, so the caller's log says so.
 */
const [kind, title, detail] = process.argv.slice(2);
if (!kind || !title) {
  console.error('usage: ops-event.mjs <kind> <title> [detail]');
  process.exit(2);
}
const port = process.env.PORT ?? '4003';
const res = await fetch(`http://127.0.0.1:${port}/api/ops/events`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Service-Token': process.env.SERVICE_TOKEN ?? '' },
  body: JSON.stringify({ kind, title, detail: detail ?? null, key: `${kind}:${new Date().toISOString().slice(0, 10)}` }),
}).catch((err) => {
  console.error(`[ops-event] not delivered: ${err.message}`);
  process.exit(1);
});
if (!res.ok) {
  console.error(`[ops-event] PS-03 answered ${res.status}`);
  process.exit(1);
}
console.log(`[ops-event] ${kind}: ${JSON.stringify(await res.json())}`);
