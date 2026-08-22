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

## `pain.002.001.03-hac.xsd`

The customer acknowledgement — `HAC`, the *Kundenprotokoll*: the bank's own log
of what it did with every order. Published by the **EBICS Working Group** at
`ebics.de` as `pain.002.001.03commented-for-HAC.xsd`, annotations dated May
2018, alongside four worked examples now in `test/fixtures/hac/`.

It is the ISO 20022 `pain.002.001.03` schema with every element annotated for
this use: `NONE` where the element is not used in `HAC` at all, and a note
saying what it carries where it is. That annotation layer is the specification
— the element names alone would tell you nothing about what `FILE_UPLOAD` or
`ORDER_HAC_FINAL` mean.

**`HAC` is not in the H005 schema set**, which is why this file is separate and
why `HAC` was the one order type this service declined to read until these
arrived. It is documented in the national annexes instead; PSA publishes no
Austrian variant, so the German document is taken to apply in both markets.

The trap it exists to catch: **a `HAC` document and a payment status report are
both `pain.002.001.03`, in the same namespace, with the same root element.**
Told apart only by `OrgnlGrpInfAndSts/OrgnlMsgId`, which is the literal string
`EBICS` in a `HAC` and the original file's `MsgId` in a status report. Reading
one as the other is the mistake this schema and these fixtures make visible.
