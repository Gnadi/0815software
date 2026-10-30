/**
 * The identifier schemes an e-invoice may name, exactly as the EN 16931
 * validation artefacts list them.
 *
 * Source: the CEN schematron "EN16931 model bound to CII", version 1.3.16
 * (30 March 2026) — as shipped inside Mustang-CLI 2.26.0 and applied by the
 * KoSIT validator, like the country codes in shared/countries.ts.
 */

/**
 * BR-CL-25: the CEF Electronic Address Scheme (EAS) codes an electronic
 * address (BT-34-1, BT-49-1) may carry. `EM` is an email address, `0204` the
 * German Leitweg-ID, `0088` a GLN, `9930` a German VAT id — the codes in which
 * Peppol writes its participant identifiers (`0088:4000001000005`).
 */
export const EAS_CODES: ReadonlySet<string> = new Set(
  (
    '0002 0007 0009 0037 0060 0088 0096 0097 0106 0130 0135 0142 0147 0151 0154 0158 0170 0177 0183 0184 ' +
    '0188 0190 0191 0192 0193 0194 0195 0196 0198 0199 0200 0201 0202 0203 0204 0205 0208 0209 0210 0211 ' +
    '0212 0213 0215 0216 0217 0218 0219 0220 0221 0225 0230 0235 0240 0244 0242 0245 0246 0248 9910 9913 ' +
    '9914 9915 9918 9919 9920 9922 9923 9924 9925 9926 9927 9928 9929 9930 9931 9932 9933 9934 9935 9936 ' +
    '9937 9938 9939 9940 9941 9942 9943 9944 9945 9946 9947 9948 9949 9950 9951 9952 9953 9957 9959 AN ' +
    'AQ AS AU EM'
  ).split(' '),
);

/**
 * BR-CL-10 / BR-CL-11: the ISO 6523 ICD codes an identifier with a scheme may
 * carry — the seller identifier (BT-29-1) among them, e.g. `0088` GLN or
 * `0060` DUNS. The schematron lists 0002–0248 without 0092, 0103, 0181 and
 * 0182, which ISO 6523 has not assigned or has withdrawn.
 */
export const ICD_CODES: ReadonlySet<string> = new Set(
  Array.from({ length: 247 }, (_, i) => String(i + 2).padStart(4, '0')).filter(
    (code) => !['0092', '0103', '0181', '0182'].includes(code),
  ),
);
