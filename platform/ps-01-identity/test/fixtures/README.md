# Test fixtures

`idp-key.pem` / `idp-cert.pem` are a throwaway keypair and self-signed
certificate for the **test SAML IdP** in `test/saml.test.ts`. They sign the
assertions those cases feed to the service, so the signature checks are
exercised against real signatures rather than mocked out.

They are committed on purpose: generating them per run would need `openssl` on
every machine that runs the suite, and the suite is meant to be offline and
deterministic. **They are not a secret and must never be used anywhere but this
test** — the private key is in the repository, so anything trusting this
certificate trusts the whole internet.

Regenerate with:

```sh
openssl req -x509 -newkey rsa:2048 -keyout idp-key.pem -out idp-cert.pem \
  -days 36500 -nodes -subj "/CN=ps01-test-idp/O=0815software test fixtures"
```
