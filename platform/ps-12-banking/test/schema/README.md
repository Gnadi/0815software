# The official EBICS 3.0 (H005) schemas

These ten XSDs are the schema set published by the **EBICS Working Group**
(`ebics.org`), final version of 7 August 2017, plus the W3C XML Signature
core schema they import. They are here for one purpose: `schema.test.ts`
validates every message this service builds against them.

## Why they are vendored

The suite is offline and deterministic by design, like every other package in
this catalogue — a test that downloads a schema is a test that fails on a train.

They carry no licence notice of their own (`xmldsig-core-schema.xsd` is the
exception, and is under the permissive W3C Software License). If vendoring them
is not wanted, **delete this directory**: `schema.test.ts` skips itself with a
message saying where to put them back, and nothing else in the suite depends on
them. Nothing here is shipped or imported by `server/`.

## Why it matters that they are here at all

Before these arrived, everything in this service was tested against a mock bank
built from the same reading of the specification as the client — so client and
counterparty agreed with each other and were wrong together. That is how a
double-hashed payment signature stayed green through 300 tests.

Validating against the published schema is the one check the mock cannot fake.
It found, among other things, that `AuthSignature` was in the wrong namespace,
that `UserSignatureData` had the wrong shape entirely, and that H005 does not
define `PubKeyValue` at all — the subscriber's keys must be X.509 certificates.

## `EBICS.CIM.Response.V.1.0.xsd`

The Austrian Customer Information Message, published by PSA at
`zv.psa.at/de/download/ebics.html`. Target namespace
`http://www.psa.at/EBICS/CIMResp`, schema version dated 08.08.2022.

`cim.test.ts` validates its fixtures against this before parsing them. It was
added late, and it immediately showed the first reader to be wrong: that one
was written from the implementation guideline's prose, which mentions
`<CIMMsgType>` — a **type** name, not an element. The element is `CIM`.
