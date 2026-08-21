# PS-12 · Banking (EBICS 3.0)

Bank transport for the platform: subscriber key custody, the EBICS key
exchange, and signed ISO 20022 uploads over the customer's own bank
connection. Part of the [Platform Services catalog](../README.md). Backend
service, MIT-licensed, self-contained.

> **Status: feature-complete, and validated against the official EBICS 3.0
> schemas.** All six phases are built, and every message this service sends —
> envelopes *and* the deflated payloads inside them — is checked against the
> XSD set published by the EBICS Working Group. **Nothing here has talked to a
> real bank.** See [Honesty about what is proven](#honesty-about-what-is-proven).

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

Beside them, `server/zip.ts` opens the archives downloads arrive in — see
[The container](#the-container-and-why-there-is-a-zip-reader-in-here).

Every file here is **pure**: no database, no clock, no network. Timestamps and
transaction keys are passed in, which is what lets the tests assert exact bytes
and what lets a request be rebuilt identically when a transfer is resumed.

### Keys travel as X.509 certificates, and there is no alternative

EBICS 3.0 does not carry raw public keys. `PubKeyValue` — the
exponent-and-modulus element H004 used — **does not appear anywhere in the H005
schema set**: `PubKeyInfoType` requires `<ds:X509Data>` in both the EBICS and
the S002 namespace, and `H3KRequestOrderData` is built from three
`*CertificateInfo` elements. The German annotation in the schema still says
"exponent-modulus combination **or** X509 certificate", which is a leftover
from H004 that the schema itself no longer permits.

`node:crypto` parses certificates and cannot issue them, so `ebics/x509.ts`
issues them — an ASN.1/DER certificate builder, keeping the zero-dependency
invariant. They are **self-signed**, and that is not a weakness here: no CA
vouches for them and none needs to, because what binds a key to a customer in
EBICS is the same thing it always was — the INI letter, signed by hand and
posted. The certificate is a container the protocol requires, not the trust
anchor. A bank insisting on a CA-issued certificate needs an operator-supplied
one, which stays out of scope.

Every certificate this builds is read back with `node:crypto`'s own X.509
parser in the tests. DER fails silently — a length byte wrong by one yields a
structure that parses as something else — and it duly caught one: DER integers
must be *minimal*, so a serial beginning `0x00` produced a certificate OpenSSL
rejected outright. It failed about one run in three.

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

The canonicaliser is checked against an independent implementation — Python's
`xml.etree.ElementTree.canonicalize` — on 27 committed vectors, and agrees on
all of them.

That sentence used to read "agreed byte for byte on every case tried", which
was true and worth very little: the cases tried avoided the two things the
parser got wrong. It normalised neither **line endings** (XML 1.0 §2.11) nor
**attribute values** (§3.3.3), so a response from a bank that formats with
CRLF — many do — canonicalised to `&#xD;` where the signer saw a newline, and
every `AuthSignature` check failed. The vectors now lead with those cases, and
a third bug fell out while fixing them: a superfluous `xmlns=""` on any element
under an undeclared default namespace.

The AES-128-CBC + ANSI X9.23 pipeline is cross-checked against `openssl enc`,
and the A005 order-data signature against `openssl dgst -sha256 -sign`. Both
vectors are pinned in the test suite.

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
                                ↑                     ↑            ↓
                          clear-failure   (an operator confirms  suspended
                                ↑          the bank's digests)
                             failed
```

Every step but one is protocol. **`hpb_fetched` → `ready` is a person.** The
state is folded from an append-only event stream at read time, so there is no
status column that can disagree with what happened, and `requireReady` is the
single gate every order passes.

Three consequences worth stating, all covered by tests:

- **Re-fetching the bank's keys clears the confirmation.** A bank rotating its
  keys is normal; inheriting a human's tick for keys nobody looked at is how a
  substituted key would wear someone else's approval. A re-fetch moves the
  connection backwards, never forwards.
- **A digest mismatch is recorded, not shrugged off.** It is what an attacker
  in the middle looks like, so it is an event on the connection and the
  connection stays unusable.
- **A failure during setup can be cleared, and only backwards.** A bank
  refusing a setup message is often transient — a host that was down, a
  subscriber it had not activated yet — and `failed` used to be terminal, with
  a UNIQUE key and no delete route, so one bad afternoon meant editing the
  database by hand. `clear-failure` steps the connection back to the last step
  it actually completed, never forward: it can never become a way to reach
  `ready` without someone confirming the digests. A *timeout*, by contrast,
  records nothing at all — nothing happened, so there is nothing to recover
  from.

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
POST /api/connections/:key/suspend · /resume · /clear-failure
POST /api/orders            {connection, btf?, payload_base64, idempotency_key}
                            ?validate=1 → a dry run that signs nothing
GET  /api/orders[/:public_id]                      folded status + events
POST /api/connections/:key/fetch                   fetch one BTF now
GET  /api/downloads[/:public_id][/content]         what the bank sent
POST /api/tick                                     fetch + reconcile
```

`platform/clients` exports `BankingClient`, so a module that can produce an ISO
20022 file reaches the bank in three lines: add `BANKING_URL`, construct the
client, call `submitOrder`. MOD-04 Invoice & Billing is the first consumer and
the proof — "Send via EBICS" beside "Download XML" — not a special case.

### The BTF is optional, and usually omitted

A caller hands over bytes and an idempotency key; the **connection's own bank
profile** supplies the Business Transaction Format. That default is the point
of the profile registry. A module knows it has produced a `pain.001`; it should
not also have to know that this bank wants `SCT/AT/pain.001/XML` while the one
next door wants no scope at all. An operator picks the profile once, when they
set the connection up with the bank's documentation in front of them.

A caller-supplied BTF always wins, so a bank that needs a different one for a
particular message stays reachable without editing the registry.

### Bank profiles say where their values came from

`bank-registry.ts` ships BTF conventions — and no URLs, no host ids and no
named banks. Those come from the EBICS contract the bank sends the customer,
and a guessed one fails as a connection timeout rather than as "you have not
entered your bank's details".

The German profile is transcribed from the official **"Mappingtabelle
BTF-Struktur auf die Standard-Auftragsartenkennungen"** (`ebics.de`, 27
February 2026); the Austrian one from **"Mappingtabelle BTF-Struktur /
Standardauftragsarten AT"** (Stuzza, `ebics.psa.at`). Those two are marked
`confirmed`. `generic` is shaped by analogy and says so. That distinction is
not decoration: the previous version of this file invented values for four
countries, and the published table showed two of them to be wrong in ways that
would have been refused at the bank —

| | invented | published (DE) |
| --- | --- | --- |
| credit transfer | `SCT` / `AT` / pain.001 / **XML** | `SCT` / — / pain.001 / — |
| status report | **`PSR`** / `AT` / pain.002 / ZIP | **`REP`** / `DE` / **option `SCT`** / pain.002 / ZIP |
| statement | `EOP` / `AT` / camt.053 / ZIP | `EOP` / `DE` / camt.053 / ZIP ✓ |

`PSR` is a service name that appears nowhere in the table. And the scope and
container on the credit transfer were not merely redundant — with both present
the BTF names **CCC**, the variant for several files inside an XML container,
rather than **CCT**, a single pain.001. The table is explicit: *"Scope DE wegen
Verwendung eines Containers."*

The Austrian table then caught the correction's own overreach. Having learned
that Germany wants no scope on a plain credit transfer, `at-sepa` was reshaped
after the German entry and dropped its scope too — but Austria sets `Scope=AT`
on exactly that message. The two markets disagree, and copying either one onto
the other is wrong in one direction or the other:

| | Germany | Austria |
| --- | --- | --- |
| credit transfer | `SCT` / — / pain.001 | `SCT` / **`AT`** / pain.001 |
| statement | `EOP` / `DE` / camt.053 / ZIP | `EOP` / `AT` / camt.053 / ZIP |
| status report | `REP` / `DE` / `SCT` / pain.002 / ZIP | `REP` / `AT` / `SCT` / pain.002 / ZIP |
| bank fees | `REP` / `DE` / camt.086 / ZIP | `REP` / **`BIL`** / camt.086 / ZIP |

Austria also pins no message variant or version: the schema in force is read
from the file's own ISO namespace, so the `msg_variant`/`msg_version` the
German entry carries would have been an invention there. And the Austrian
table's legacy-order-type column is printed for German-market vendors
migrating; the document says outright that those codes have no meaning in
Austria and are not used there.

Each profile also carries the EBICS 2.5 order types it replaces. Nothing sends
them, but a bank on the telephone says "we've enabled CCT and C53 for you", and
somebody has to be able to translate — in Germany. In Austria that conversation
happens in BTF terms already.

### What the attached signature is for

Every upload carries a class-E bank-technical signature — that is the point of
the service. What says so on the wire is `BTUOrderParams/SignatureFlag`, the
element that replaced EBICS 2.5's order attribute (`OZHNN`/`DZHNN`). The H005
schema makes it optional and is unusually explicit about what leaving it out
means:

> If not present the order doesn't contain any ES and shall be authorised
> outside EBICS. If present the order shall be authorised within EBICS.

PS-12 sent no flag for a long time. Schema-valid — the element is optional —
and exactly backwards: the request attached a signature that authorises a
payment while telling the bank to look for authorisation somewhere else. A real
bank would have parked every payment for someone to release in online banking,
which is the manual step the service exists to remove. No schema check can
catch this, and the mock bank could not either, because it read the signature
it was given rather than the instruction about it. The mock bank now refuses an
upload that arrives without the flag.

Set `request_eds` on a connection and the flag carries `requestEDS="true"`
instead: the bank spools the order into its distributed-signature (VEU/EDS)
queue and waits for the missing signatories rather than rejecting it. That is
for accounts whose bank agreement needs a second person. **PS-12 cannot show
you that queue** — the management order types (`HVU`, `HVZ`, `HVD`, `HVT`,
`HVE`, `HVS`) are not implemented, so a spooled order is out of sight here
until a `pain.002` comes back for it.

### Stopping a key that can pay

At signature class E the ES private key moves money on its own. So "how do I
stop it right now" needs an answer that is not "telephone the bank and hope
somebody picks up". `POST /api/connections/:key/lock` sends **SPR**, the order
type that revokes the subscriber at the bank; Austrian institutes support it
explicitly.

It is deliberately not the same thing as `/suspend`:

| | `/suspend` | `/lock` (SPR) |
| --- | --- | --- |
| who stops it | this service | the bank |
| orders after | refused here | refused everywhere |
| undo | `/resume` | none — new keys, new INI letter |

`locked` is therefore a state nothing steps out of: `resume`, `clearFailure`
and `suspend` all refuse it, because the authority that ended the subscriber's
authorisation is not this service.

**The connection only moves to `locked` when the bank answered `EBICS_OK`.** A
refusal is recorded as `failed` with the bank's own code and the route answers
502 saying the subscriber is *not* locked. A green tick over nothing is the one
outcome that would be worse than having no lock button at all.

One caveat, stated plainly because the rest of this service is derived from
published documents and this byte is not: **the order data an SPR carries — a
single blank — is the one thing here not taken from the H005 schema.** The
schema forces the shape (an upload initialisation must carry `SignatureData`,
`DataDigest` and `NumSegments`, so SPR must sign *something*) but cannot say
what. Until a real bank has accepted one, treat it as unconfirmed — and note
that the failure mode is a refusal you can see, not a lock you only think
happened.

### Verification of Payee

Since 09.10.2025 the ServiceOption on a SEPA credit transfer says whether the
bank should check the payee's name against the IBAN: `VOO` opts out, `VOI` opts
in. Send neither and the market's own default applies — OPT-OUT for `SCT` and
`SCI` in both published tables.

A connection's `vop` is `default`, `opt_out` or `opt_in`. `default` sends no
option at all, which is what every connection did before this existed; the
other two say so on the wire. The point of the setting is that an installation
which cares can make the choice rather than inherit it.

The option slot is **shared**, and that is the trap. It also carries the
payment's own kind, and the tables combine the two into a single code: a salary
payment opting out is `CFDVOO`, not `CFD` plus `VOO`. Only some combinations
exist — the Austrian table has `CFDVOO` and `THMVOI` and no `URGVOO` — so PS-12
refuses to concatenate one and asks for the combined option on the order's BTF
instead. Three earlier BTF defects came from composing a plausible code; this
one declines to.

### Which client software is speaking

A connection may name a `Product`: the client software's own identification,
its ISO 639 language, and the id the bank issued for it. It is optional in
H005 and this service sent none for a long time — but the Austrian
specification's worked `ebicsRequest` example carries it, and a bank uses it to
tell one customer product from another when a support call comes in.

It goes in exactly one place, after `UserID`/`SystemID` and before
`OrderDetails`, and only in the initialisation phase — the transfer and receipt
phases carry nothing but a host id and a transaction id. A mock bank that reads
elements by name would accept it anywhere, so `schema.test.ts` validates every
message twice, once with the element and once without, and asserts which of
them carry it. Set no product fields and no element is emitted at all, which is
what every message looked like before.

## Downloads, and the one rule that matters

```
POST /api/tick  →  for each ready connection:
                     BTD pain.002  →  store  →  ACK  →  fold into the orders
                     BTD camt.053  →  store  →  ACK  →  hand over untouched
```

**The positive receipt goes out only after the bytes are committed.** A receipt
is how the bank learns we hold a file; it then stops offering it. Sending one
before the file is stored is how a bank statement disappears permanently — the
bank marks it collected, the process dies, and there is no second copy
anywhere.

So the order is: fetch every segment, reassemble, decrypt, `INSERT`, commit,
*then* acknowledge. Getting it wrong in the other direction costs a duplicate,
which `UNIQUE (connection, sha256)` absorbs. Getting it wrong this way is
unrecoverable, and the mock bank keeps a real queue so the mistake shows up in
a test rather than in production.

### The container, and why there is a ZIP reader in here

EBICS delivers both of those inside a **ZIP** — one download can carry several
days or several accounts, and the BTF's `Container` element says so. Node has
`zlib`, which does the compression a ZIP entry uses, but nothing that reads the
archive format around it, so `server/zip.ts` is ~100 lines rather than a
dependency: the `express` + `better-sqlite3` invariant that all twelve services
hold is worth more than the lines.

It reads sizes from the **central directory**, never from the local headers.
That is not style: a streaming writer sets general-purpose bit 3 and leaves the
local sizes at zero, and a reader that trusts them returns an empty file with
no error — for a bank statement. ZIP64, encryption and any compression method
beyond stored and deflate are refused by name rather than guessed at. The
container is also *sniffed* rather than taken from the BTF, because a bank that
publishes `Container=ZIP` may still send one bare document.

The archive is stored exactly as it arrived. Keeping the bytes the bank sent,
rather than only what we made of them, is what turns a parser bug into a re-run
instead of an unrecoverable loss — the file is offered once.

### What is read, and what is only kept

| File | Treatment |
| ---- | --------- |
| **pain.002** payment status report | **Read.** It is the answer to "did that payment file go through?", and nothing else in the stack can answer it. |
| **camt.053** account statement | **Stored whole, never parsed.** It is an account statement, and matching bookings to invoices belongs to the module that has the invoices. |

Status codes are passed through, not translated — the same reasoning as the
three EBICS codes in `codes.ts`. The one judgement made is conservative: **any**
rejection makes the whole order rejected, even alongside acceptances. A file
where three transfers went through and one bounced is not "accepted" to the
person who has to go and pay that fourth supplier.

### `accepted` is not final

An order accepted at upload can be rejected two days later by a status report,
so the fold lets a later decision overtake an earlier one — while still never
letting a stray progress event walk an order back out of a decision. The bank
taking a *file* and the bank having *paid* it are two different facts, and the
status ladder keeps them apart: `accepted` then `settled`.

MOD-04 is the consumer: a run whose order reaches `settled` settles its bills
on the bank's own word, with nobody coming back to press "mark executed".

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
| 4 | HTTP API, bank profiles, INI letter, catalogue wiring, client | **Done** |
| 5 | MOD-04 integration — "Send via EBICS" beside "Download XML" | **Done** |
| 6 | Downloads: camt.053 and pain.002, and reconciliation back into MOD-04 | **Done** |
| — | Review pass: ten findings, three of them bank-blockers | **Done** |
| — | Validation against the official H005 schemas: six more findings | **Done** — 397 tests |

What is left is not code: a first connection to a real bank, with that bank's
own example messages and file check in hand.

## Scripts

| Script          | What it does                                  |
| --------------- | --------------------------------------------- |
| `npm test`      | The protocol suites (Vitest, offline)         |
| `npm run build` | Type-check and compile to `dist/`             |

## Out of scope

- **EBICS 2.5 (H004).** The envelope layer is shaped so a second version can be
  added behind the same interface; it is not implemented.
- **CA-issued certificates.** Subscriber certificates are issued here and
  self-signed, which is what the protocol needs (see
  [Keys travel as X.509 certificates](#keys-travel-as-x509-certificates-and-there-is-no-alternative)).
  A bank that insists on one signed by a certificate authority needs an
  operator-supplied certificate and key; requesting one from a CA is not
  something this service does.
- **Distributed signature (VEU) management.** Signature class E means an upload
  is already authorised; managing multi-signature release queues is a different
  feature.
- **SEPA direct debit collection** (`pain.008`), which needs mandates that no
  module currently holds.
- **Parsing account statements.** A `camt.053` is downloaded, stored whole and
  handed over; turning bookings into matched receivables is the consuming
  module's job. Doing it here would be the cross-module read-model service this
  repository decided not to build
  ([`docs/PLATFORM-SERVICE-OPPORTUNITIES.md`](../../docs/PLATFORM-SERVICE-OPPORTUNITIES.md)).

## Honesty about what is proven

Everything here is tested against this repository's own understanding of the
specification, and — where an independent implementation existed offline —
cross-checked against it. **No part of it has spoken to a real bank.** The
first live connection should be treated as a debugging exercise, with the
bank's own example messages and file check in hand, not as a rollout.

### The schema is now the referee

Since the official H005 XSD set arrived, `test/schema.test.ts` validates every
message this service builds — envelopes **and** the deflated payloads inside
`OrderData`, which a check on the envelope alone never sees. That second part
mattered: three of the six errors it found were in there.

What it found, all of it green beforehand:

| | was | is |
| --- | --- | --- |
| `AuthSignature` | `ds:` (xmldsig) | `ebics:` — only its *type* is dsig |
| `UserSignatureData` | H005 ns, `OrderSignature` with ids as attributes | S002 ns, `OrderSignatureData` with ids as elements |
| `SignaturePubKeyOrderData` | H005 namespace | S002 namespace |
| subscriber keys | `PubKeyValue` (modulus + exponent) | `ds:X509Data` — the only form H005 defines |
| `Container` | never sent | `<Container containerType="ZIP"/>`, before `MsgName` |
| `SegmentNumber` | no `lastSegment` | `lastSegment` is required |

The `AuthSignature` one is worth dwelling on: it was wrong in *both*
directions. Outgoing messages put it where no bank would look, and
`verifyAuthSignature` looked where no bank would put it. The two errors
cancelled perfectly against our own mock.

### The mock bank cannot find a mistake it shares

A review after the sixth phase found that `signOrderData` hashed the order data
and handed the DIGEST to a signer that hashes what it is given — so the
signature authorising every payment was over SHA-256(SHA-256(orderData)). The
suite was green. It could not have been otherwise: the mock bank verifies
through `verifyOrderData`, the mirror of the broken function, so client and
counterparty agreed with each other and were wrong together. No number of
additional tests written the same way would have caught it.

That is the concrete form of the risk this file has claimed from the start, and
it changes what a test here is worth:

- **A vector from outside is worth more than a hundred round trips.** The A005
  signature, the AES pipeline and the canonicaliser are all now pinned against
  `openssl` or Python. Those cannot agree with our misreading.
- **Where no outside implementation exists** — the envelope shapes, the BTF
  values, the return codes — the mock proves only internal consistency, and
  should be read as documentation of our reading rather than as evidence.

The same review found five more defects that the tests could not see because
nothing exercised the path: a `queued` order that locked its own MsgId for
ever, a connection permanently bricked by one transient bank error, an
idempotency key that collided across connections, a `container: ZIP` nobody
could open, and a status report matched on the wrong id.

Then the published schemas found six more, and the German BTF mapping table
found two wrong service definitions. Then the Austrian mapping table found a
third — a scope dropped from `at-sepa` in the course of fixing the German one,
which is what copying a market's conventions sideways gets you. Then a question
about VEU found the missing `SignatureFlag`, which is the worst of the lot: not
a malformed message but a well-formed one that asked for the opposite of what
was intended. All are fixed and covered.

The pattern is the same every round and is the useful thing to carry forward:
**every defect was found by comparing against something outside this repository
— openssl, Python, the XSDs, the mapping tables, a question about a feature we
had not built — and none by adding another test of the kind already there.**
The `SignatureFlag` adds a second lesson to it: schema-valid is not the same as
correct, and an optional element's default can be a decision made by omission.

## License

MIT © 0815software — see [LICENSE](LICENSE).
