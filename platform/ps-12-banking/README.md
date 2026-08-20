# PS-12 · Banking (EBICS 3.0)

Bank transport for the platform: subscriber key custody, the EBICS key
exchange, and signed ISO 20022 uploads over the customer's own bank
connection. Part of the [Platform Services catalog](../README.md). Backend
service, MIT-licensed, self-contained.

> **Status: phase 4 of 6 — wired into the catalogue.** The protocol core, the
> encrypted key store, the connection lifecycle, signed BTU uploads and the
> HTTP API are implemented and tested against a mock bank that verifies what it
> is sent. Remaining: the MOD-04 button (phase 5) and downloads (phase 6). See
> [Build order](#build-order). Nothing here has talked to a real bank.

## What this service is for

MOD-04 Invoice & Billing already produces a valid `pain.001` SEPA credit
transfer per payment run. Today a human downloads that file and uploads it in
online banking. EBICS is the protocol that removes the manual step.

It is a Platform Service rather than a module feature for one reason above the
others: **an EBICS subscriber holds RSA private keys that are sufficient to
move money.** Those keys belong in exactly one place, guarded once, and reached
over an API — not copied into every module that ever needs a bank.

## Stack

| Layer   | Choice                                      |
| ------- | ------------------------------------------- |
| API     | Node 20+ · Express 5 · TypeScript (strict)  |
| Storage | better-sqlite3 (single file, zero services) |
| Crypto  | **Node built-ins only** — `node:crypto`, `node:zlib` |
| Tests   | Vitest (offline, deterministic)             |

Runtime dependencies: `express`, `better-sqlite3`. That's all — the same
invariant every other service in the catalogue holds. EBICS needs XML
signatures and exclusive canonicalisation, which Node has no built-in for, so
this package implements them (see below) rather than taking on a dependency.

## The protocol core (phase 1)

```
server/ebics/
  xml.ts         canonical XML writer + parser + exclusive C14N
  crypto.ts      A005/A006, X002, E002, AES-128-CBC, X9.23, the key digest
  dsig.ts        the AuthSignature — build and verify
  envelopes.ts   H005 messages: HEV, INI, HIA, HPB, BTU init/transfer/receipt
  parse.ts       responses, HPB key extraction, DER key reconstruction
  codes.ts       return codes: technical vs business, and what to do about each
```

Every file here is **pure**: no database, no clock, no network. Timestamps and
transaction keys are passed in, which is what lets the tests assert exact bytes
and what lets a request be rebuilt identically when a transfer is resumed.

### The three key pairs, and why they are not interchangeable

| Version | Purpose | What it does |
| ------- | ------- | ------------ |
| **A005 / A006** | electronic signature (ES) | Signs the **order data**. At signature class E this authorises the payment. |
| **X002** | identification & authentication | Signs the **request**. Proves who is talking; authorises nothing. |
| **E002** | encryption | Wraps the per-transaction AES key. Never signs. |

Confusing them is the classic implementation bug, so they are distinct types
and distinct functions rather than three uses of one "key".

### Canonicalisation, and why writing is the easy direction

EBICS signs the *exclusive canonical form* of XML, not the bytes on the wire.
`xml.ts` solves that by making the writer emit canonical form directly — so
when signing our own document there is nothing to canonicalise, and the digest
is over bytes we already wrote. A bug in the parser therefore cannot produce a
bad **outgoing** signature. Parsing exists only to verify what the bank sends.

The canonicaliser's output was cross-checked against an independent
implementation (Python's `xml.etree.ElementTree.canonicalize`) and agreed byte
for byte on every case tried, including the `xmlns=""` undeclaration. The
AES-128-CBC + ANSI X9.23 pipeline was cross-checked against `openssl enc`, and
one of those vectors is pinned in the test suite.

### Order data goes deflate → encrypt → base64

In that order. The AES key is fresh for every single transaction, which is the
only reason the scheme's fixed all-zero IV is safe — `newTransactionKey` must
stay a generator and never become a cached value.

Padding is **ANSI X9.23** (zero fill, last byte carries the count), not PKCS#7.
Node's automatic padding is PKCS#7, so it is switched off and the padding is
done by hand; using the wrong one produces a file the bank decrypts into
garbage with no useful error.

### The key store

Private keys are AES-256-GCM ciphertext at rest under `EBICS_KEY_SECRET`, are
never returned by any endpoint, and are reached through one function that takes
a *purpose* rather than a key id — so an order cannot accidentally be signed
with the authentication key.

**`EBICS_KEY_SECRET` is the one secret to back up.** `deploy/provision.mjs`
generates a fresh random value for every declared secret on every provision, so
re-provisioning a live stack rotates it. The service therefore decrypts one
stored key at boot and refuses to start if it cannot, naming the recovery:
restore the previous secret, or re-initialise with the bank on paper — which
takes days.

### The signature, as an attacker would test it

`verifyAuthSignature` recomputes everything from the received document. It
checks the algorithms (an attacker who picks the algorithm picks a weak one),
insists on exactly one `Reference` whose URI is the EBICS xpointer (a valid
signature over a *different* fragment is the signature-wrapping attack), and
only then verifies the RSA signature. The test suite includes each of those as
a failing case.

## The lifecycle, and the one step that is a human

```
created → keys_generated → ini_sent → hia_sent → hpb_fetched → ready
                                                      ↑            ↓
                                          (an operator confirms  suspended
                                           the bank's digests)
```

Every step but one is protocol. **`hpb_fetched` → `ready` is a person.** The
state is folded from an append-only event stream at read time, so there is no
status column that can disagree with what happened, and `requireReady` is the
single gate every order passes.

Two consequences worth stating, both covered by tests:

- **Re-fetching the bank's keys clears the confirmation.** A bank rotating its
  keys is normal; inheriting a human's tick for keys nobody looked at is how a
  substituted key would wear someone else's approval. A re-fetch moves the
  connection backwards, never forwards.
- **A digest mismatch is recorded, not shrugged off.** It is what an attacker
  in the middle looks like, so it is an event on the connection and the
  connection stays unusable.

## Submitting a payment file

```
requireReady → replay check → ceilings → sign → initialisation → segments → accepted
```

The order matters more than any single step. At signature class E the signature
**is** the payment, so every refusal gets its chance before the ES key is
touched; a ceiling enforced after signing would be no ceiling at all. The test
for this asserts the bank received nothing, not merely that an error was
thrown.

### Sent at most once, twice over

| Layer | Catches |
| ----- | ------- |
| the caller's `idempotency_key` | a retried request, a double-clicked button |
| `UNIQUE (connection_id, msg_id)` | the same file with no key, or under a new one |

MOD-04's payment run is byte-stable and stores its `MsgId`, so both layers
converge on the same answer. Uniqueness is **per connection**: two banks are
two duplicate checks. And when the earlier attempt was refused, resubmitting is
not silently deduplicated — the error names the fix, because the bank keys its
own duplicate check on the `MsgId` and a corrected file needs a new one.

### `rejected` and `failed` are not the same thing

A rejection is a decision the bank made and told us about. A failure is a
conversation that broke, and whether the bank has the file is **unknown**. Only
one of the two is safe to resubmit, so they are kept apart all the way to the
API — and a technical code in the retryable range is recorded as `failed`, not
`rejected`, for the same reason.

Rejections are filed under the code that actually *decided* them. A business
rejection travels with technical code `000000`; storing the technical code
would file a refused payment under one that reads as success.

### Reading inside the file, as little as possible

The service is payload-agnostic — a caller hands over bytes, a BTF and a key.
But "at most once" needs the file's identity and "ceilings hold" needs its
amount, and both live inside it. So when the BTF says `pain.001`, exactly four
things are read: `MsgId`, `NbOfTxs`, `CtrlSum`, currency. Everything else stays
opaque and falls back to the SHA-256 of the bytes, which is a perfectly good
answer to "have I sent this before?". Nothing is ever rewritten: the bytes that
get signed are the bytes the caller supplied.

A payload that cannot be read is **refused** when ceilings are set. "I could
not tell how much this is" is not a reason to send it.

## The API, and the line drawn through it

| Caller | Credential | May |
| ------ | ---------- | --- |
| an operator | admin session | everything — connections, keys, INI/HIA/HPB, confirming the bank's digests, suspending |
| a module | `X-Service-Token` | submit an order, read an order, list bank profiles. Nothing else. |

A service token presented to an operator route gets **403, not 401**: the
caller is authenticated, with the wrong credential for a human's job. Saying so
is what stops someone "fixing" it by giving a module the admin password.

That line is the bound on a leaked module token. It cannot bring a connection
into existence, cannot move one to `ready`, and cannot lift a ceiling — so the
worst it can do is send a file within limits a human set, on a connection a
human activated.

```
GET  /api/banks                                    BTF conventions; no URLs
POST /api/connections · GET /api/connections[/:key]
POST /api/connections/:key/keys                    the three pairs, once
POST /api/connections/:key/ini · /hia · /hpb
GET  /api/connections/:key/ini-letter.pdf          digests to sign and post
POST /api/connections/:key/verify-bank-keys        → ready
POST /api/connections/:key/suspend · /resume
POST /api/orders            {connection, btf, payload_base64, idempotency_key}
                            ?validate=1 → a dry run that signs nothing
GET  /api/orders[/:public_id]                      folded status + events
```

`platform/clients` exports `BankingClient`, so a module that can produce an ISO
20022 file reaches the bank in three lines: add `BANKING_URL`, construct the
client, call `submitOrder`.

### Bank profiles carry no URLs

`bank-registry.ts` ships BTF conventions per scheme and country — and no URLs,
no host ids and no named banks. Those come from the EBICS contract the bank
sends the customer, and a guessed one fails as a connection timeout rather than
as "you have not entered your bank's details". Every profile is marked
`confirmed: false`, because nothing in this repository can check a BTF against
a bank's own documentation. `?validate=1` is how an operator checks one without
money moving.

## Trust, and where it actually comes from

INI and HIA are **unsecured messages** — they cannot be otherwise, because the
bank has no key of ours to verify against yet. What binds those keys to a
customer is out of band: the **INI letter**, printed with the key digests,
signed by hand and posted.

The same is true in reverse. HPB downloads the bank's keys, and the response
cannot prove it came from the bank. So the digests are shown to an operator to
compare against the bank's own published letter, and a connection does not go
live until someone confirms them. That comparison is the security control; the
protocol around it is plumbing.

The digest is computed exactly as EBICS defines it — SHA-256 over the ASCII
string `"<exponent hex> <modulus hex>"`, lower case and leading-zero-trimmed,
**not** over the DER or the PEM. An implementation that hashes the wrong thing
produces a plausible value that never matches the bank's letter.

## Build order

| Phase | Deliverable | Status |
| ----- | ----------- | ------ |
| 1 | Protocol core: canonical XML, crypto, dsig, envelopes, codes | **Done** |
| 2 | Key custody, the connection lifecycle, the mock bank | **Done** |
| 3 | Orders: BTU upload, segmentation, receipts, idempotency, ceilings | **Done** |
| 4 | HTTP API, bank profiles, INI letter, catalogue wiring, client | **Done** — 281 tests |
| 5 | MOD-04 integration — "Send via EBICS" beside "Download XML" | Next |
| 6 | Downloads: camt.053 and pain.002, and reconciliation back into MOD-04 | |

## Scripts

| Script          | What it does                                  |
| --------------- | --------------------------------------------- |
| `npm test`      | The protocol suites (Vitest, offline)         |
| `npm run build` | Type-check and compile to `dist/`             |

## Out of scope

- **EBICS 2.5 (H004).** The envelope layer is shaped so a second version can be
  added behind the same interface; it is not implemented.
- **X.509 certificate issuance.** `node:crypto` parses certificates but cannot
  issue them. Banks that require a certificate instead of a raw
  `PubKeyValue/RSAKeyValue` will need an operator-supplied PEM.
- **Distributed signature (VEU) management.** Signature class E means an upload
  is already authorised; managing multi-signature release queues is a different
  feature.
- **SEPA direct debit collection** (`pain.008`), which needs mandates that no
  module currently holds.

## Honesty about what is proven

Everything here is tested against this repository's own understanding of the
specification, and — where an independent implementation existed offline —
cross-checked against it. **No part of it has spoken to a real bank.** The
first live connection should be treated as a debugging exercise, with the
bank's own example messages and file check in hand, not as a rollout.

## License

MIT © 0815software — see [LICENSE](LICENSE).
