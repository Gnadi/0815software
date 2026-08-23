# The first connection to a real bank

A runbook for the day PS-12 stops talking to its mock and talks to a bank.

**Budget days, not hours, and treat it as a debugging exercise.** Everything in
this service is tested against published schemas and a counterparty this
repository wrote. The schemas prove the *documents* are right. They prove
nothing about the *conversation*: the bank's actual endpoint, the return codes
it really sends, whether its `HTD` lists what you expect, whether its
segmentation limit matches, and how its onboarding desk handles the paper. That
gap is not a defect to be fixed in advance — it is the part that can only be
closed by doing it.

This document is what to do, in order, and what to do when a step does not
work.

---

## Before you start: what the bank has to give you

Ask for these in one go. A missing one costs a day of waiting.

| | What it is | Where it goes |
| --- | --- | --- |
| **EBICS URL** | The HTTPS endpoint. Not the online-banking URL. | `url` |
| **Host ID** | The bank system's id, e.g. `EBIXHOST`. | `host_id` |
| **Partner ID** | Your customer id (*Kunden-ID*). | `partner_id` |
| **User ID** | Your subscriber id (*Teilnehmer-ID*). | `user_id` |
| **EBICS version** | Must be **H005** (EBICS 3.0). | fixed |
| **Signature class** | **E** for "this signature alone authorises", **T** for transport-only. | see below |
| **The bank's key digests** | On paper or in the contract. SHA-256 of its X002 and E002 keys. | verification step |
| **Which order types are enabled** | Ask for `BTU`, `BTD`, `HTD` at minimum. | — |

Two more worth asking, because they save a confused hour later:

- **A product id**, if the bank issues one (*Kundenprodukt*). Optional in H005;
  some banks want the one they issued. Goes in `product`.
- **Whether they expect a CA-issued certificate.** PS-12 issues its own
  self-signed ones, which is what the protocol requires. A bank insisting on a
  certificate from a public CA needs an operator-supplied one, and that is out
  of scope here — find out now, not at INI.

### Signature class E or T

`E` means the electronic signature PS-12 attaches *is* the authorisation: the
payment executes with no further human step at the bank. `T` means the upload
is transport-only and somebody still releases it in online banking.

**Start with T if you can.** Everything else in this runbook is identical, and
a mistake during the first week costs a release that did not happen rather than
a payment that did. Move to E once a real payment has gone through end to end.

---

## The setup, step by step

### 0. Check the secret first

`EBICS_KEY_SECRET` is the one value in this stack that is genuinely
unrecoverable. It encrypts the private keys; without it the connection is dead
and must be re-initialised with the bank on paper.

```
# It must be 64 hex characters, and it must be BACKED UP SOMEWHERE ELSE
# before you generate any keys.
echo -n "$EBICS_KEY_SECRET" | wc -c     # 64
```

`deploy/provision.mjs` mints a fresh random value for **every** declared secret
on **every** provision. Re-provisioning this stack without pinning this one
rotates it and orphans the keys. PS-12 refuses to boot when that has happened
and says so in one line — but the recovery is restoring the old value, so make
sure there is one to restore.

### 1. Create the connection

```
POST /api/connections
{ "key": "main", "display_name": "Hausbank",
  "bank_key": "at-sepa",              # or de-sepa, or generic
  "url": "https://ebics.bank.example/ebics",
  "host_id": "EBIXHOST", "partner_id": "CUST1234", "user_id": "USER0001",
  "es_version": "A005",               # A006 only if the bank asks for it
  "max_amount_minor": 5000000, "max_transfers": 200 }
```

**Set the ceilings low for the first weeks.** They are checked before anything
is signed, and they are the only thing standing between a compromised module
token and a real payment.

State is now `created`.

### 2. Check you can reach the bank at all

```
GET /api/connections/main/versions
```

This is `HEV`, the one unsigned request in the protocol. It asks the bank which
versions it speaks and needs no keys, so it isolates *network and URL* from
*everything else*.

- **Answers with H005 in the list** → the URL and the Host ID are right.
- **Times out or TLS fails** → firewall, proxy or wrong URL. Nothing to do with
  EBICS yet.
- **Answers without H005** → stop. This service speaks H005 only.

### 3. Generate the keys

```
POST /api/connections/main/keys
```

Three RSA-2048 pairs — signature, authentication, encryption — with a
self-signed X.509 certificate each. **Once.** A second call is refused, because
new keys would orphan whatever the bank was already told.

State is now `keys_generated`.

### 4. INI and HIA

```
POST /api/connections/main/ini      # the signature key
POST /api/connections/main/hia      # authentication and encryption
```

Both are unsigned uploads — the bank has nothing of yours yet. Send INI first;
some banks reject HIA before INI.

State goes `ini_sent` → `hia_sent`.

**If either fails**, the connection records `failed` with the bank's code. Read
it, fix the cause, then `POST /api/connections/main/clear-failure` to step back
to the last completed step and try again. Clearing never moves a connection
*forward*.

### 5. The INI letter — the paper step

```
GET /api/connections/main/ini-letter.pdf
```

Print it, sign it by hand, send it the way the bank asks (post, or upload into
online banking — they differ). It carries the **digests** of your three public
keys, never the keys themselves.

**This is the security of the whole exchange.** The bank compares what is on
that paper with what arrived over the wire. A key substituted in transit fails
that comparison, and nothing else in the protocol would catch it.

Then wait. The bank activates the subscriber; this takes hours to days. There
is no request that hurries it.

### 6. Fetch the bank's keys

```
POST /api/connections/main/hpb
```

Works only once the bank has activated you. Before that it answers with a
refusal — usually a `091xxx` code meaning "subscriber unknown or not yet
activated", which is expected and not a fault.

State is now `hpb_fetched`. **The connection still cannot carry an order.**

### 7. Confirm the digests — the one human judgement

```
GET  /api/connections/main            # read auth/enc digestFormatted
POST /api/connections/main/verify-bank-keys
{ "auth_digest": "…", "enc_digest": "…" }
```

Compare the digests PS-12 shows against the ones **on the bank's letter or
contract** — not against anything the same channel delivered. HPB cannot prove
the keys came from the bank; this comparison is what rules out a substituted
key, and it is why `hpb_fetched` is not `ready`.

If they do not match: **stop and telephone the bank.** Do not confirm.

State is now `ready`.

### 8. Ask the bank what you may actually do

```
GET /api/connections/main/customer-data          # HTD
```

The cheapest useful live request there is: read-only, no money, and it answers
"does this bank agree about who I am and what I may send". Check:

- your accounts are listed, with the IBANs you expect;
- `BTU` and `BTD` appear in the order list;
- your signature class is what you agreed (`E` or `T`);
- `available_downloads` names the BTFs to subscribe to.

**Use this list rather than the transcribed tables.** `bank-registry.ts` is a
starting point for an operator who has not connected yet; this is the bank's
own answer for your contract.

If `HTD` is not enabled, `GET /api/connections/main/waiting` (`HAA`) and
`GET /api/connections/main/bank-parameters` (`HPD`) answer smaller versions of
the same question.

### 9. Subscribe to what you want fetched

A new connection starts with two subscriptions — the profile's payment status
report and its account statement. Add whatever `HTD` listed and you want
polled:

```
POST /api/connections/main/subscriptions
{ "btf": { "service_name": "STM", "scope": "AT",
           "msg_name": "camt.052", "container": "ZIP" },
  "label": "intraday" }
```

Then `POST /api/tick` and look at `GET /api/downloads`.

### 10. A dry run before any money

```
POST /api/orders?validate=1
{ "connection": "main", "payload_base64": "…" }
```

Builds and signs nothing, transmits nothing, and reports what it would send
plus any ceiling problem. Run it on a real payment run first.

### 11. The first real payment

Make it **one transfer, to your own account, for a small amount.** Not a
supplier, not a batch.

```
POST /api/orders
{ "connection": "main", "payload_base64": "…",
  "idempotency_key": "payment-run:<MsgId>" }
```

Then, over the next day:

1. `GET /api/orders/<id>` — the order's own status.
2. `POST /api/tick` — fetches the payment status report (`pain.002`) and folds
   it into the order.
3. `GET /api/statements` — the money leaving, on the account statement.
4. Check the bank's own log: `GET /api/downloads?kind=protocol` after
   subscribing to `HAC`, if the bank offers it.

**Only after that has worked end to end should a batch go out.**

---

## When something goes wrong

### Read the code, and read the range

PS-12 deliberately maps only three EBICS codes by name and classifies the rest
by range, passing the bank's own `ReportText` through. A confidently-worded
wrong meaning next to a payment is worse than no meaning.

| Range | What it means | What to do |
| --- | --- | --- |
| `000000` | OK | — |
| `00xxxx` | Success variant | — |
| `01xxxx` | Still in progress | Wait; `POST /api/tick` again later |
| `06xxxx` | **Technical** — about the conversation, not the payment | Retryable. The order was **not** accepted; the idempotency key stops a retry becoming two payments |
| `09xxxx` | **The bank refused the order** | Do not retry blindly. Read `ReportText` |

### The failures you should expect on a first connection

| Symptom | Almost always |
| --- | --- |
| `HEV` times out | Firewall or proxy, or the online-banking URL was used |
| `INI`/`HIA` refused | Host ID, Partner ID or User ID wrong — check character by character |
| `HPB` says subscriber unknown | The paper letter has not been processed yet. Wait. |
| Digests do not match | Usually the wrong letter or the wrong connection. If it really does not match, **telephone the bank** |
| Upload refused `09xxxx` | Wrong BTF. Compare against `GET /api/connections/main/customer-data` |
| Upload refused, ES invalid | Signature class mismatch — the bank has you as `T` and expects a second release, or as `E` and got no ES |
| Segments rejected | The bank publishes a smaller segment limit than 1 MB. Set `segmentLimit` on the profile |
| A download is `kind: 'other'` | The BTF is right but nothing here parses that format. The bytes are stored and downloadable |

### When the bank asks about a specific file

This is the reason the conversation log exists, and it is the one thing you
cannot reconstruct after the fact if it was not kept.

```
GET /api/orders/{public_id}                 the history: every step, its own
                                            timestamp, the code, who caused it
GET /api/orders/{public_id}/exchanges       the round-trips it caused
GET /api/exchanges/{id}                     one of them, with the bytes
```

Read them in that order. The history tells you where it stopped; the exchange
for that step is what you send the bank when they ask what you transmitted.
A step that shows `error` with no response is the ambiguous case — the request
left, nothing came back, and whether the bank has the file is genuinely
unknown. Do **not** resubmit on a hunch: ask the bank, or fetch `HAC`
(`POST /api/connections/main/fetch` with the customer-protocol BTF), which is
the bank's own log of what it did with your orders.

`transaction_id` and `ebics_order_id` on the order are the two references a
bank will ask for. The second is the one their customer protocol keys on.

### Recovering

- **A failed setup step** → `POST /api/connections/main/clear-failure`. Steps
  backwards only.
- **Stop this service sending anything** → `POST /api/connections/main/suspend`
  (undone with `/resume`). Local only; the bank is not told.
- **A key may be compromised** → `POST /api/connections/main/lock` (`SPR`).
  This ends the subscriber's authorisation **at the bank** and cannot be undone
  from here. The way back is new keys and a fresh INI letter.
- **A key needs replacing without an incident** → `POST
  /api/connections/main/key-change` (`HCA`, or `HCS` with
  `include_signature`). Signed with the keys the bank already holds, so no
  second letter. If it fails ambiguously, the new keys stay pending — establish
  with the bank whether it took, then `/key-change/complete` or `DELETE`.

---

## Write down the chain head

Do this once the connection is live, and then whenever an auditor asks.

```
GET /api/audit/head    ->  { "head": "9f2c…" }
```

PS-12 keeps its own history in a hash chain, so an edited, deleted or
back-inserted record is detectable — `GET /api/audit/chain` gives the verdict,
and `banking_chain_valid` carries it to a monitor. What a chain cannot prove is
that the whole database was not rewritten, head marker included.

A head hash that has already left the container closes that. The service prints
one at every boot, so a log shipper collects them for free; copy one into the
connection's own notes as well. It costs nothing and it is the difference
between "our records say" and something an outsider can check.

---

## What to write down afterwards

The first connection is the only chance to capture things nobody documents:

- the exact BTFs the bank accepted, and what it called them on the phone;
- its segment limit, if it is not 1 MB;
- how long activation actually took;
- which codes it sends for the ordinary refusals;
- whether its `HTD` matched the contract.

Put them in the connection's `display_name` context, an internal note, or a PR
against `server/bank-registry.ts` if the values belong to that bank's profile
generally. The next connection at the same bank should be an afternoon.
