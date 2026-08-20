# PS-12 · Banking (EBICS 3.0)

Bank transport for the platform: subscriber key custody, the EBICS key
exchange, and signed ISO 20022 uploads over the customer's own bank
connection. Part of the [Platform Services catalog](../README.md). Backend
service, MIT-licensed, self-contained.

> **Status: phase 1 of 6 — the protocol core.** The XML, crypto, signature and
> envelope layers are implemented and tested. There is no HTTP API, no database
> and no bank connection yet; those are phases 2–5. See
> [Build order](#build-order) for what lands when. Nothing here is ready to
> talk to a real bank.

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

### The signature, as an attacker would test it

`verifyAuthSignature` recomputes everything from the received document. It
checks the algorithms (an attacker who picks the algorithm picks a weak one),
insists on exactly one `Reference` whose URI is the EBICS xpointer (a valid
signature over a *different* fragment is the signature-wrapping attack), and
only then verifies the RSA signature. The test suite includes each of those as
a failing case.

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
| 1 | Protocol core: canonical XML, crypto, dsig, envelopes, codes | **Done** — 103 tests |
| 2 | Service skeleton, key custody, the key-exchange lifecycle, the INI letter | Next |
| 3 | Orders: BTU upload, segmentation, receipts, idempotency, ceilings | |
| 4 | Catalogue wiring: registry, provisioning, site copy, client, OpenAPI | |
| 5 | MOD-04 integration — "Send via EBICS" beside "Download XML" | |
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
