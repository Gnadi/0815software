/**
 * The country codes an e-invoice may carry, exactly as the EN 16931
 * validation artefacts list them.
 *
 * Source: the CEN schematron "EN16931 model bound to CII", version 1.3.16
 * (30 March 2026), rule BR-CL-14 — as shipped inside Mustang-CLI 2.26.0 and
 * applied by the KoSIT validator. It is ISO 3166-1 alpha-2 plus `1A` (Kosovo)
 * and `XI` (Northern Ireland), and still `AN`. A check on the shape alone
 * ("two capital letters") let `UK` through into files that fail BR-CL-14; a
 * check against plain ISO 3166 would refuse valid `XI` invoices.
 *
 * BR-CO-09 checks the first two characters of every VAT id against the same
 * list plus `EL`, which Greece uses in VAT ids instead of `GR`.
 */
export const EN16931_COUNTRY_CODES: ReadonlySet<string> = new Set(
  (
    '1A AD AE AF AG AI AL AM AN AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BL BJ BM BN BO BQ BR BS BT BV BW ' +
    'BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK ' +
    'FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS ' +
    'IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM ' +
    'MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS ' +
    'PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR ST SV SX SY SZ TC TD TF TG TH TJ TK TL ' +
    'TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XI YE YT ZA ZM ZW'
  ).split(' '),
);

/** A country code the EN 16931 artefacts accept (BR-CL-14). */
export function isCountryCode(code: string | null | undefined): boolean {
  return typeof code === 'string' && EN16931_COUNTRY_CODES.has(code);
}

/** Whether a VAT id starts with a country prefix, as BR-CO-09 checks it (spaces removed, as rendered). */
export function hasVatPrefix(vatId: string): boolean {
  const prefix = vatId.replace(/\s/g, '').toUpperCase().slice(0, 2);
  return prefix === 'EL' || EN16931_COUNTRY_CODES.has(prefix);
}
