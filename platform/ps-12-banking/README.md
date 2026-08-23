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
for accounts whose bank agreement needs a second person — and PS-12 can now
read and act on that queue.

### The distributed-signature queue

Six order types, all through the admin session and never a service token: a
module submitting a payment is one thing, a second human approving one is
exactly the step VEU exists to require.

```
GET  /api/connections/:key/veu[?details=1]   HVU, or HVZ with the payment summary
POST /api/connections/:key/veu/detail        HVD — one order's digest and display file
POST /api/connections/:key/veu/transactions  HVT — the payments inside it
POST /api/connections/:key/veu/sign          HVE — add our signature
POST /api/connections/:key/veu/cancel        HVS — withdraw the order
```

**A caller never supplies the digest that gets signed.** `sign` and `cancel`
fetch the order's `DataDigest` themselves, with `HVD`, immediately before using
it. Taking one from the request body would make this service a signing oracle:
hand it any 32 bytes and it returns our ES over them, which is a signature over
any document the caller cares to write — including a payment file. The extra
round trip is the price of not being that.

Nothing is stored. The queue lives at the bank; a copy here would be a second
source of truth that goes stale the moment another signatory acts.

Two things this turned up that are worth carrying forward. A co-signatory signs
a hash they did not compute — `OrderDataAvailable` is a flag in the HVD
response, so they may not have the order data at all — which is the exact shape
of the double-hash bug from the first review round. `signDigest` therefore
builds the PKCS#1 `DigestInfo` by hand and is pinned to an openssl vector; and
it uses `privateEncrypt`, not `crypto.sign(null, …)`, because the latter looks
like the raw primitive and is not. Over the same key and digest it produced
neither openssl's answer nor anything else recognisable — and all three
candidates return a signature-shaped 256 bytes, so only the vector noticed.

The second: **A006 cannot co-sign.** RSASSA-PSS needs the hash function during
encoding, not merely its output, and `node:crypto` exposes no way to supply
one. An A006 subscriber gets a clear refusal rather than a signature that is
quietly not one.

Like SPR, the HVE and HVS request shapes are forced by the schema but not
confirmed against a real bank: no published document here says HVE's order data
is exactly a `UserSignatureData`. The mock bank verifies the co-signature
against its own copy of the order data, so the cryptography is proven; the
envelope around it is not.

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

### Customer information messages

An Austrian bank sends notices — a service window, a format deadline — as
`CIM/AT`, and without help they land in `downloads` as `other`: kept, offered,
completely opaque. They are now `kind: 'info'`, and `GET /api/downloads/:id`
carries a `customer_info` object with the group header and each notice's id,
timestamp, headline and body, read against the published
`EBICS.CIM.Response.V.1.0.xsd` (vendored in `test/schema/`).

**This reader was written twice, and the first one was wrong.** It was built
without the schema, from the implementation guideline's prose, which mentions
`<CIMMsgType>` — a *type* name, not an element. The element is `CIM`. So the
reader matched nothing, fell back to treating the whole document as a single
notice, and returned one entry containing every scrap of text in the file, the
group header's message id included.

That is worth recording because the file went out of its way to avoid exactly
this. It used only names the guideline stated and took everything else
structurally, on the explicit grounds that guessing `<CIMText>` would repeat an
old mistake — and its tests asserted that ceiling. All of them passed, because
they were written against the same misreading. **A stated ceiling does not
protect you when the fallback turns "I cannot read this" into a plausible
answer**; only a document from outside can tell those apart. It is the same
lesson as the double-hashed signature, arrived at from the opposite direction.

`text` is HTML the bank wrote and is deliberately **not** sanitised here.
Anything rendering it must escape or sanitise it: the schema names the tags a
bank may use and says a client ignores the rest, which is a display rule, not a
safety guarantee.

The two Austrian documents also disagree on the message name — the mapping
table says `cimresp`, the guideline's worked example says `BRCResp`. Both are
recognised, and `bank-registry.ts` records the conflict.

### The two Austrian payment formats

PS-12 is payload-agnostic and stays that way — it does not know what an invoice
is and never rewrites a byte of what it signs. It makes one narrow exception,
for the same reason `payload.ts` reads a `MsgId`: a malformed Finanzamtszahlung
or Postbarzahlung is refused by the bank **after** an ES has authorised it, and
at signature class E that signature is the money.

So when an uploaded `pain.001` marks a payment as Austrian, `austrian.ts`
checks its remittance against PSA's published format before anything is signed.
A file with no such mark is not touched, and silence never means "checked and
fine" — the caller's own validation still applies.

| | element | level |
| --- | --- | --- |
| TAXS | `Purp/Cd` | the individual `CdtTrfTxInf` |
| CPPP | `PmtTpInf/CtgyPurp/Prtry` | either |

A `CtgyPurp` of `TAXS` is itself a finding, not a synonym: the specification
allows that code nowhere but `Purp/Cd` on the transaction, and says batch-level
coding "ist nicht vorgesehen" even when every payment in the batch is one.
`CPPP` belongs in `Prtry` because it is not an ISO `ExternalCategoryPurpose`
code — a bank handed `<Cd>CPPP</Cd>` is handed a code that does not exist.

One translation note. **`[^\2]` is not a backreference in JavaScript**: inside
a character class it means "not U+0002". Used verbatim the published CPPP
expression would let an address line contain the delimiter and mis-split the
address, so it ships as a negative lookahead, `(?:(?!\2).)*?`. Two rules the
expression cannot carry are checked beside it: clauses 21–25 are mutually
exclusive, and the line is capped at 140 characters.

A Finanzamtszahlung's 9-digit Ordnungsbegriff in `EndToEndId` is check-digit
verified too. MOD-04 builds these files; this is the last gate before the key
that can pay is used.

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
                     BTD camt.053  →  store  →  ACK  →  read into bookings
                     BTD HAC       →  store  →  ACK  →  fold failures in
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
| **camt.053** account statement | **Read into bookings**, queryable by reference, amount and date. The bytes are kept as the record. Which invoice a booking settles is still the consuming module's business — see "Account statements are read into bookings". |
| **HAC** customer protocol | **Read.** The bank's own log of what it did with each order; failures are folded into the order they name. Also a `pain.002`, which is why the kind is decided by the bytes. |
| **CIM** customer information | **Read** far enough to show its text — a notice meant for a person. |

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

## Reconstructing one transfer, months later

A folded status answers "did it work". It answers nothing at all in the
conversation this service actually has to survive — the bank saying *we have no
record of that file*, or *your signature did not verify*, about money that has
already left. Three records exist for that, and they do different jobs.

**`order_events` — what happened, and to whom.** Append-only, folded into the
status at read time, never pruned. Every step carries its own timestamp (so a
twelve-segment upload shows where it stopped, not one instant), the EBICS code
that decided it, the bank's own `ReportText`, and the actor — an operator's
username, `service` for a module, `ticker` for the tick loop.

```
queued        actor=mod-04  sha256 of the file as submitted
initialised   actor=mod-04  transaction_id, ebics_order_id, segments, tx_count
segment_sent  actor=mod-04  segment 1 of 3
segment_sent  actor=mod-04  segment 2 of 3
segment_sent  actor=mod-04  segment 3 of 3
transferred   actor=mod-04
accepted      actor=mod-04  000000
settled       actor=ticker  from pain.002, source=dl_9f1c…   ← days later
```

The last line is the point of the tick loop: an order's history keeps growing
after the upload, from the bank's own answers. Each such event names the
download it was read out of, and that download's bytes are still on disk at
`GET /api/downloads/{id}/content`.

**`bank_exchanges` — what was actually said.** Every POST to a bank, whole: the
envelope as sent, the answer as received, the HTTP status, the wall-clock
window, and — for the conversation that never completed — why. `transport.ts`
is the only place a bank is spoken to, which is what makes "every" a claim
rather than a hope; the key exchange is in there alongside the payments.

```
GET /api/orders/{public_id}/exchanges   the round-trips behind one order
GET /api/exchanges?connection=main      everything said to one bank
GET /api/exchanges/{id}                 one conversation, with the bytes
```

Admin only, all three: the envelope carries the payment file. An envelope never
carries a private key — `keystore.ts` decrypts one into memory to sign and
nothing serialises it — so keeping the bytes adds no secret to the database
that was not already in it, and `test/traceability.test.ts` pins that.

Envelopes are large, so they age out on `EBICS_EXCHANGE_RETENTION_DAYS` (730 by
default, 0 to keep forever), pruned on the tick. **`order_events` is never
pruned**: what expires is the evidence, not the record of what happened.

**`connection_events`** does the same for the connection itself — who generated
the keys, who confirmed the bank's digests, who suspended it.

**The chain — would we know if somebody changed it.** The three tables above
plus `downloads` are append-only by convention, and a convention is not
evidence. So every appended record is linked into one hash chain, in the same
transaction as the insert. PS-07 Audit Log does this for the catalogue and
PS-12 deliberately does not call it: a platform service that needs a second
service running to answer for its own records is not independent, and "the
audit trail was unavailable" is not an answer anybody accepts about a payment.

```
GET /api/audit/chain     the verdict, and where it broke if it did
GET /api/audit/head      just the head hash
```

**Two passes, and the difference is not cosmetic.** Re-deriving each record's
digest reads and re-hashes every stored envelope, so it costs in proportion to
the bytes kept — measured at 2.5 s for 20 000 conversations, which a
tick-driven connection reaches in about two weeks. Walking the links alone
takes 0.2 s on the same data.

So `GET /api/audit/chain` runs the full pass, because asking is a deliberate
act; `?quick=1` runs the cheap one. `banking_chain_valid` on `/api/metrics`
and the line printed at boot run the **cheap** pass — a full check on a
scrape timer would block the event loop for seconds, once a minute, forever.
Every verdict carries `content_checked`, so a green answer never claims more
than it looked at.

| | links only | full |
| --- | --- | --- |
| A rewritten or reordered link | ✓ | ✓ |
| A truncated end | ✓ | ✓ |
| A record written past the log | ✓ | ✓ |
| A record edited in place | — | ✓ |
| A record deleted | — | ✓ |

| The edit | What names it |
| --- | --- |
| A field changed on a past record | its digest no longer matches |
| A record deleted | its link has no record, and was not marked pruned |
| A record inserted past the log | it has no link at all |
| Links reordered or rewritten | the hashes stop chaining |
| The end cut off, link and record together | the head marker is no longer reached |

Retention marks a pruned link rather than deleting it, so ageing envelopes out
stays valid while a hand-written `DELETE` does not.

**What it does not prove, said plainly.** Somebody who rewrites the *whole*
database — every record, every link, and the head marker — produces a
consistent chain. No in-process design prevents that. That is why the head is
published and logged: a head hash that has already left the container, into a
log shipper or a backup manifest or an operator's note, is a value the rewrite
would have to match and cannot. Write it down; the chain is worth what its
anchor is worth.

There is no backfill and no way to make a broken chain green again from
inside this service: a link is written in the same transaction as the record
it stands for, or it is never written. A repair tool that could re-link
records after the fact would attest to what the database says now, which is
exactly the claim the chain exists to refuse.

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
| — | Validation against the official H005 schemas: six more findings | **Done** |
| — | The Austrian market: BTF table, `Product`, CIM, payment formats | **Done** |
| — | `SignatureFlag`, Verification of Payee, `SPR` | **Done** |
| — | VEU: `HVU`, `HVZ`, `HVD`, `HVT`, `HVE`, `HVS` | **Done** |
| — | `HTD`/`HKD`, `HCA`/`HCS`, and per-connection download subscriptions | **Done** |
| — | `HAC`, the customer protocol, against the published examples | **Done** |
| — | `camt.053` read into queryable bookings, against the ISO schemas | **Done** |
| — | `camt.052`/`camt.054` too, on the Austrian schemas' evidence | **Done** |
| — | Validated against STUZZA's strict Austrian subset: two code fixes | **Done** — 684 tests |

## Which BTFs are supported

**All of them, on both sides — and the list of what to ask for comes from the
bank, not from this repository.**

That is worth stating precisely, because "which formats do you support?" is the
question a bank will ask and the one this service used to answer badly.

**Uploads** have always been format-agnostic. `POST /api/orders` takes a BTF and
a payload; `service_name` is free text and nothing here restricts it. A caller
that can produce a `pain.008`, a `camt.086` request, an `mt101` or a national
format nobody in this repository has heard of can send it today.

**Downloads** were not, and that was a real gap. The tick fetched exactly two
BTFs per connection — the bank profile's payment status report and its account
statement — and everything else (`camt.052` intraday, `camt.054`
notifications, `camt.086` fees, `mt940`, PDF statements, the Austrian `CIM`
customer information) was reachable only by an operator pressing "fetch now".
Nothing in the protocol required that; it was a hard-coded pair.

It is now a per-connection **download subscription** list. One row says "fetch
this BTF on every tick", any BTF at all:

```
GET    /api/connections/:key/subscriptions
POST   /api/connections/:key/subscriptions      {btf, label?, lookback_days?}
POST   /api/connections/:key/subscriptions/:id/enable · /disable
DELETE /api/connections/:key/subscriptions/:id
```

A new connection is seeded with its profile's two, so nothing changes for an
existing installation. Everything beyond that is a decision an operator makes
once — and `HTD` is where the legitimate choices come from.

### Transporting a BTF and understanding one are different questions

Everything above is about **transport**, and there the answer is genuinely
"all of them": any BTF, in both directions, with no list to fall out of date.

What a file *means* is a separate matter, and there the coverage is small on
purpose. Five message types are read; everything else is stored as bytes and
handed over untouched:

| | read as | why |
| --- | --- | --- |
| `pain.001` | MsgId, transaction count, control sum — on the way OUT | the ceilings and the once-only rule need them |
| `pain.002` | payment statuses, folded into the order | the answer to "did that file go through?" |
| `pain.002` with `OrgnlMsgId=EBICS` | the `HAC` protocol | a different message wearing the same name; see below |
| `cimresp` / `BRCResp` | the Austrian customer information notices | a notice meant for a person to read |
| `camt.053` `camt.052` `camt.054` | **bookings**, queryable — see below | reading the bank's own format is what this service is for |

So `camt.086`, `mt940`, `mt942`, PDF statements and every national format land
as `kind: 'other'`: fetched on every tick if subscribed, stored,
digest-deduplicated, downloadable through the API — and not interpreted.

### Account statements are read into bookings

A `camt.053` used to be stored whole and handed over, on the argument that
matching bookings to invoices is the business of the module that has the
invoices. **That argument was about matching, and it was applied to parsing.**
The two are different, and the line is now drawn between them —
[`docs/PLATFORM-SERVICE-OPPORTUNITIES.md`](../../docs/PLATFORM-SERVICE-OPPORTUNITIES.md)
records the revision.

Reading a camt.053 is understanding the format the bank speaks, which is the
entire reason this service exists. A parser in every module that wants bank data
is the same duplication as an EBICS client in every module that wants a bank —
quieter, and harder to debug, because it fails silently (below). So the
statement is parsed here, and the bookings are a query:

```
GET /api/statements[?connection=&account=]          the statements collected
GET /api/statements/:public_id                      one, with its entries
GET /api/entries?connection=&account=&from=&to=
                &reference=&end_to_end_id=
                &amount_hundredths=&search=
                &credit=&status=&exclude_reversals=  the query a matcher needs
POST /api/statements/reparse                        re-read the stored bytes
```

`GET /api/entries` takes a service token, because bookings are what a module
consumes and reading them moves no money.

**What is deliberately absent: any notion of an entry being "matched".** Which
invoice a booking settles depends on the invoices, and those live in the module
that issued them. This answers *what did the bank book*; the module decides what
that means.

Two defaults exist to stop the expensive mistakes:

- **Only `BOOK` entries come back.** A `PDNG` entry is money the bank has seen
  and not booked. Treating it as a payment is how an invoice gets marked
  settled against a transaction that later vanishes.
- **`reversal` is on every entry.** A returned direct debit undoes an earlier
  booking, and a consumer summing income has to see that.

**Amounts.** The exact decimal string the bank wrote is always kept. Beside it
is `amount_hundredths` — the amount times one hundred — and deliberately **not**
a field called `amount_minor`. Minor units need the currency's exponent, which
is two for the euro, zero for the yen and three for the dinar; shipping that
table means transcribing ISO 4217 from memory, and this repository has been
bitten twice by exactly that kind of plausible transcription. A consumer working
in euros uses it as cents and is right. It is null when the bank sent more than
two decimal places, because rounding an amount silently is worse than declining.

### What the Austrian subset changed

STUZZA publishes a **Technical Validation Subset** of camt.052/053/054 — the
same target message, a stricter schema. Every fixture here is now validated
against it as well as against ISO (`test/schema/austrian/`), and it caught two
things the ISO schema never would:

**The bank's own transaction code was being thrown away.** The reader took
`BkTxCd/Domn` and fell back to `BkTxCd/Prtry`. Austria makes **both**
mandatory, so the fallback never fires there and the proprietary code — the one
an Austrian bank actually keys on — was lost on every single booking. They are
now read side by side (`bank_transaction_code` and
`proprietary_transaction_code`).

**A pending entry cannot appear on an Austrian camt.053 at all.** The status
enumeration is `{BOOK}` for a statement and `{BOOK, PDNG}` for a report or
notification. So a pending item reaches us on a camt.052 — which is precisely
why a query spanning both counts money that has not moved, and why
`GET /api/entries` defaults to statements alone. The fixture's pending entry
moved to the report, where the schema says it belongs.

Four more constraints the subset imposes, all invisible in ISO and none of
which would throw: `GrpHdr/MsgRcpt`, `Stmt/LglSeqNb`, `Ntry/BookgDt` and
`Ntry/AcctSvcrRef` are required; `Refs` allows only five of its ten fields (no
`MsgId`, no `PmtInfId`, no `InstrId`); `TxDtls/AmtDtls` is required; and
`RmtInf/Ustrd` is a **single** line where ISO permits many. The reader handles
both, since a German bank sends the ISO shape.

### camt.052 and camt.054 read through the same reader

An intraday report (`camt.052`) and a debit/credit notification (`camt.054`)
are read by the same code as a statement. That was refused for a while, and the
refusal was right at the time: the three obviously share ISO components, which
is a plausible assumption and was worth nothing without a schema to check.

The STUZZA schemas settle it. `ReportEntry2` and `EntryTransaction2` are
defined in all three files and are **identical element for element**. What
differs is two names — the envelope (`BkToCstmrStmt` / `BkToCstmrAcctRpt` /
`BkToCstmrDbtCdtNtfctn`) and its container (`Stmt` / `Rpt` / `Ntfctn`) — plus
one omission: a notification has no `Bal`, there being no balance to report on
a list of individual items. That is read off the normative text, not inferred.

**They share a structure and not a meaning, and the difference costs money.** A
`camt.052` booking is provisional and appears *again* on the day's `camt.053`;
a `camt.054` notification does the same. Summing across all three counts the
same money two or three times, and nothing about the rows would give it away —
same bank, same day, same amount, same reference.

So every statement records which message it came from, and `GET /api/entries`
**defaults to `source=statement`**: the definitive end-of-day record only. All
three are stored, because an intraday report is real information; a caller that
wants to see money arriving before end of day passes `source=report` or
`source=any` and does so knowingly. The reasoning is the same as for `PDNG`
entries.

**Why both camt.053 schema versions are vendored.** `camt.053.001.02` and `.08` are both
in use in the German and Austrian markets, and they differ in three places that
are invisible in a sample file and **silent** when got wrong:

| | `.02` | `.08` |
| --- | --- | --- |
| `Ntry/Sts` | a plain code | a `Cd`/`Prtry` choice |
| a counterparty's name | `Dbtr/Nm` | `Dbtr/Pty/Nm` |
| the transaction amount | only under `AmtDtls/TxAmt` | also a direct `Amt` |

The second is the one that matters: a reader written for `.02` returns **no
counterparty at all** on a `.08` statement, for every booking, with no error —
which reads as "the bank did not send a name". Both schemas are in
`test/schema/`, both fixtures are validated against them before anything parses
them, and there is a test per difference.

Storing bookings is the one place the "nothing derivable is stored" rule is
bent, and knowingly: *"was invoice 42 paid?"* is a search across every statement
ever collected, and answering it by re-parsing each stored blob is a full scan
dressed as a read model. The bytes remain the record — `POST
/api/statements/reparse` drops the derived rows and reads them again, so a fix
to the parser improves every statement already collected rather than only the
next one.

### Why the catalogue question is the wrong question

The obvious way to "support every BTF in the standard" is to transcribe the
national mapping tables — roughly ninety rows between the German and Austrian
ones — into a registry. This service deliberately does not, and the reason is
recorded in `server/bank-registry.ts`: an earlier version of that file shipped
invented values for four countries, including a service name that does not
exist, and they were plausible enough that only the published tables caught
them. A wrong catalogue is worse than none, because it is quoted with
confidence.

`HTD` removes the need for one. It asks the bank which order types and BTFs it
has enabled **for this contract**, which accounts they apply to, how many
signatures each needs, and — per subscriber — the signature class held and any
ceiling the bank itself enforces. That is authoritative in a way no published
table can be: specific to one customer, at one bank, on the day it is asked.

```
GET /api/connections/:key/customer-data          HTD — this subscriber
GET /api/connections/:key/customer-data?scope=customer   HKD — the whole customer
```

The response includes `available_downloads`: the `BTD` entries from the bank's
own list, in exactly the shape `POST .../subscriptions` takes. So the workflow
is ask, then subscribe — never transcribe.

`bank-registry.ts` remains what it always was: a starting point for an operator
who has not connected yet, transcribed from published tables and marked with
where each value came from.

## What is not implemented

Twenty order types are built: `HEV`, `INI`, `HIA`, `HPB`, `SPR`, `BTU`, `BTD`,
the six VEU ones (`HVU`, `HVZ`, `HVD`, `HVT`, `HVE`, `HVS`), the five
administrative downloads (`HTD`, `HKD`, `HPD`, `HAA`, `HAC`) and the two key
changes (`HCA`, `HCS`).

**Exactly one order type the H005 schema set defines is missing: `H3K`** — the
one-step initialisation that sends all three certificates together instead of
`INI` + `HIA` and then fetching the bank's keys with `HPB`. It is an
alternative to that sequence, not a capability beyond it: everything it does
can be done today, in three requests instead of one. Worth adding for a bank
that mandates it; nothing is unreachable without it.

`PUB` — replacing the ES key on its own — is **not part of H005** and so is not
a gap. It survives only as a passing mention in a comment in the S002 signature
schema; EBICS 3.0 has no `PUBRequestOrderData`, and `HCS` is how an ES key is
replaced. An earlier version of this section listed it as missing, which
overstated by one.

### `HAC` — the customer protocol

The *Kundenprotokoll*: the bank's own log of what it did with every order. The
file arrived, the signature verified (or did not), it went into the
distributed-signature queue, a second subscriber signed it, it finished. The
place to look when a payment file goes quiet.

It was the last thing missing, and for a stated reason: **`HAC` is not in the
H005 schema set.** The EBICS Working Group's `EBICS_3.0_schema_H005` archive
contains ten files and none of them defines its order data. It is specified in
the national annexes instead, and this service does not write readers from
prose — the last one written that way (the Austrian `CIM` message) matched
nothing, fell back to the whole document, and returned a confident wrong
answer.

That is now resolved. The EBICS Working Group publishes
`pain.002.001.03commented-for-HAC.xsd` — the ISO schema annotated element by
element for this use — together with four worked examples. Both are vendored
(`test/schema/`, `test/fixtures/hac/`), the examples are validated against the
schema before anything parses them, and `server/hac.ts` is written against
that rather than against a description. PSA publishes no Austrian variant, so
the German document is taken to apply in both markets.

**The trap it hides, which is worth stating plainly.** A `HAC` document and a
payment status report are **both `pain.002.001.03`** — same namespace, same
root element, same `CstmrPmtStsRpt`. Nothing about the shape says which it is.
Classifying a download by its BTF alone would file the bank's activity log as a
set of payment verdicts and hand it to the code that settles and rejects
orders.

So `downloads.ts` now classifies on the **bytes**, not only on the BTF, and
checks for a customer acknowledgement first. The one element that separates
them is `OrgnlGrpInfAndSts/OrgnlMsgId`: the literal string `EBICS` in a `HAC`,
the original file's `MsgId` in a status report. As it happens the current `HAC`
profile omits the three status elements `reports.ts` reads, so today the
mistake would have produced nothing rather than something wrong — that is luck,
not design, and a bank adding a `GrpSts` would have attached a verdict carrying
the msgId `"EBICS"` to whatever order happened to be filed under that name.

**What it is worth, once read.** A `pain.002` answers "did the payment settle?".
The protocol answers an earlier question: *"did the bank accept the file, and
did my signature hold?"* An order refused at the signature step never reaches a
status report at all, so without this it sits at `accepted` forever while
nothing moves. `POST /api/tick` now folds those failures into the order they
name.

It folds **failures only**. A `HAC` verdict of `processed` means the bank
finished handling the order at the EBICS level; it does not mean the payment
executed, which only a `pain.002` can say. Recording a settlement from it would
be a settlement this service invented.

Two things this required that were missing:

- **The bank's own order number.** `HAC` logs every action under the `OrderID`
  the bank assigns to an upload — which arrives in the response's *mutable*
  header, and which `parseResponse` never read. Without it a log entry saying
  "signature refused, order A445" is readable but not actionable. Orders now
  record it as `ebics_order_id`.
- **Case-insensitive key lookup.** A `HAC` entry's details are name/value pairs
  where `SchmeNm/Prtry` is the name — unordered, the examples say so explicitly.
  And the EBICS Working Group's own example file spells the key `OrderID`
  twenty-one times and `OrderId` twice, *in the same document*. A
  case-sensitive reader loses the order number on exactly those two entries, in
  the file published to demonstrate the format.

The BTF to fetch it under is a national matter and is deliberately not guessed
here — ask the bank, or read it off `GET /api/connections/:key/customer-data`.
Detection does not depend on getting it right.

### Key renewal, which is now available### Key renewal, which is now available

`HCA` replaces the authentication and encryption keys; `HCS` replaces those and
the ES key — the one that authorises payments, and therefore the one that
matters after a compromise. Both are signed with the keys the bank already
holds, and that signature is the authorisation: no second paper letter.

```
GET    /api/connections/:key/key-change            what is pending
POST   /api/connections/:key/key-change            {include_signature?: bool}
POST   /api/connections/:key/key-change/complete   the recovery, below
DELETE /api/connections/:key/key-change            discard a refused change
```

The ordering is the design, and it is deliberate:

1. Generate the replacements and **commit them as pending**.
2. Send the request, signed with the current keys.
3. Only on the bank's acceptance, retire the old and promote the pending.

Step 1 before step 2 is not an optimisation. The unrecoverable failure is the
bank moving to a key this service does not hold — from that point nothing we
can send is valid and the fix is re-initialising on paper. A pending set nobody
activates is a row to delete.

That leaves exactly one gap: the bank accepts and this service dies before step
3. The keys are on disk, so nothing is lost, but the two sides disagree about
which key is live. `POST .../key-change/complete` is the door out, and it is
deliberately explicit rather than inferred — an operator has to have
established with the bank that the change went through.

## Going live with a real bank

[`FIRST-CONNECTION.md`](FIRST-CONNECTION.md) is the runbook: what to ask the
bank for before you start, the eleven steps in order, what each failure
usually means, and how to recover from each one.

Two things from it worth repeating here, because they are the ones that cost
days rather than minutes:

- **`EBICS_KEY_SECRET` must be backed up before any key is generated.** It
  encrypts the private keys and nothing can reconstruct it. `provision.mjs`
  mints a fresh value for every secret on every provision, so re-provisioning
  without pinning this one orphans the keys and means re-initialising with the
  bank on paper.
- **Start at signature class T if the bank allows it.** Everything else is
  identical, and a first-week mistake then costs a release that did not happen
  rather than a payment that did.

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
- **A VEU screen in a module.** The distributed-signature queue is fully
  implemented in this service (`HVU`, `HVZ`, `HVD`, `HVT`, `HVE`, `HVS`), and
  reached through the admin session. Putting a "co-sign these bills" list into
  MOD-04 is a module feature that has not been built.
- **SEPA direct debit collection** (`pain.008`), which needs mandates that no
  module currently holds.
- **Matching bookings to invoices.** A `camt.053` IS parsed here now, and the
  bookings are queryable (see above) — that changed, and
  [`docs/PLATFORM-SERVICE-OPPORTUNITIES.md`](../../docs/PLATFORM-SERVICE-OPPORTUNITIES.md)
  records why. What did not change is the other half: deciding *which invoice a
  payment settles* depends on the invoices, so it stays with the module that
  issued them. This service holds no notion of an entry being matched.
- **SEPA direct debit collection** (`pain.008`) still needs mandates that no
  module holds. The Austrian schema for it is now vendored
  (`test/schema/austrian/`), so what is missing is the mandate model, not the
  format.

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
