/**
 * Postal addresses as an e-invoice needs them: street, postcode, city and an
 * ISO 3166-1 alpha-2 country code as separate fields (EN 16931 BG-5 / BG-8).
 *
 * This module has always stored an address as free text — the lines printed
 * on the PDF. Asking every installation to retype every customer before its
 * first e-invoice would be the expensive way to get structure, so the
 * structured fields win when they are filled in and, when they are not, the
 * printed lines are read the way a person reads them:
 *
 *   Beispielgasse 8/15        ← street: the line above the postcode line
 *   1010 Wien                 ← "postcode city", in the country's own format
 *   Austria                   ← an optional country line
 *
 * Anything this cannot read with confidence is reported as missing rather
 * than guessed: a wrong postcode on an invoice the recipient's software routes
 * by is worse than a refusal that says which field to fill in.
 */

export interface PostalAddress {
  street: string | null;
  postcode: string | null;
  city: string | null;
  /** ISO 3166-1 alpha-2, upper case. */
  country: string | null;
}

/** Country names as people write them on an address line → ISO code. */
const COUNTRY_NAMES: Record<string, string> = {
  austria: 'AT',
  österreich: 'AT',
  oesterreich: 'AT',
  germany: 'DE',
  deutschland: 'DE',
  switzerland: 'CH',
  schweiz: 'CH',
  suisse: 'CH',
  liechtenstein: 'LI',
  italy: 'IT',
  italien: 'IT',
  italia: 'IT',
  france: 'FR',
  frankreich: 'FR',
  netherlands: 'NL',
  niederlande: 'NL',
  belgium: 'BE',
  belgien: 'BE',
  luxembourg: 'LU',
  luxemburg: 'LU',
  'czech republic': 'CZ',
  czechia: 'CZ',
  tschechien: 'CZ',
  slovakia: 'SK',
  slowakei: 'SK',
  hungary: 'HU',
  ungarn: 'HU',
  slovenia: 'SI',
  slowenien: 'SI',
  poland: 'PL',
  polen: 'PL',
  denmark: 'DK',
  dänemark: 'DK',
  spain: 'ES',
  spanien: 'ES',
};

export const COUNTRY_RE = /^[A-Z]{2}$/;

/** The country a VAT id belongs to ("ATU12345678" → AT, "DE123456789" → DE). */
export function countryOfVatId(vatId: string | null | undefined): string | null {
  const prefix = vatId?.trim().slice(0, 2).toUpperCase() ?? '';
  if (!COUNTRY_RE.test(prefix)) return null;
  // Greece uses EL in VAT ids and GR in addresses.
  return prefix === 'EL' ? 'GR' : prefix;
}

/**
 * The postcode of each country this reads a "postcode city" line in. Read
 * by length alone, "1012 LG Amsterdam" became postcode 1012 in the city
 * "LG Amsterdam" (review N3), so a line is only read in the format of the
 * address's own country. A country not listed here, or an address whose
 * country is not known, leaves postcode and city to the explicit fields.
 */
const POSTCODE_FORMATS: Record<string, string> = {
  AT: '\\d{4}', BE: '\\d{4}', CH: '\\d{4}', DK: '\\d{4}', HU: '\\d{4}', LI: '\\d{4}', LU: '\\d{4}', NO: '\\d{4}', SI: '\\d{4}',
  DE: '\\d{5}', EE: '\\d{5}', ES: '\\d{5}', FI: '\\d{5}', FR: '\\d{5}', HR: '\\d{5}', IT: '\\d{5}',
  CZ: '\\d{3} ?\\d{2}', GR: '\\d{3} ?\\d{2}', SE: '\\d{3} ?\\d{2}', SK: '\\d{3} ?\\d{2}',
  NL: '\\d{4} ?[A-Z]{2}',
  PL: '\\d{2}-\\d{3}',
  PT: '\\d{4}-\\d{3}',
};

/** Where a missing postcode or city comes from — for the messages that ask for one. */
export const ADDRESS_HINT = 'its own field, or an address line "PLZ Ort" in the format of the address\'s country';

/** The country letters some still put before a postcode: "D-80331 München", "A-1010 Wien". */
const LETTER_PREFIX: Record<string, string> = { A: 'AT', D: 'DE', CH: 'CH', FL: 'LI', I: 'IT', F: 'FR', L: 'LU' };
const PREFIXED = /^([A-Z]{1,2})\s*-\s*\d{4,5}\s/;

/**
 * Read street / postcode / city / country out of printed address lines.
 * The country is the one the caller knows (`knownCountry`, the customer's own
 * field), else a country line, else a letter prefix, else `fallbackCountry`
 * (typically from the VAT id); its format decides how the postcode is read.
 */
export function parseAddressLines(lines: string[], fallbackCountry: string | null = null, knownCountry: string | null = null): PostalAddress {
  const clean = lines.map((l) => l.trim()).filter((l) => l !== '');
  let named: string | null = null;

  const last = clean[clean.length - 1];
  if (last !== undefined) {
    named = COUNTRY_NAMES[last.toLowerCase()] ?? (COUNTRY_RE.test(last) ? last : null);
    if (named) clean.pop();
  }
  // From the bottom up, as the postcode line is searched for.
  const prefix = [...clean].reverse().map((l) => PREFIXED.exec(l)?.[1]).find((p) => p !== undefined);
  const country = knownCountry ?? named ?? (prefix ? LETTER_PREFIX[prefix] : undefined) ?? fallbackCountry;

  const format = country ? POSTCODE_FORMATS[country] : undefined;
  const line = format ? new RegExp(`^(?:[A-Z]{1,2}\\s*-\\s*)?(${format})\\s+(.+)$`) : null;
  for (let i = clean.length - 1; line !== null && i >= 0; i--) {
    const match = line.exec(clean[i]!);
    if (!match) continue;
    // The street is the line above; a single-line address has none.
    return { street: i > 0 ? clean[i - 1]! : null, postcode: match[1]!, city: match[2]!.trim(), country };
  }
  return { street: null, postcode: null, city: null, country };
}

const pickCountry = (value: string | null | undefined): string | null =>
  value && value.trim() !== '' ? value.trim().toUpperCase() : null;

/** Explicit fields first, the printed lines for whatever they leave empty. */
export function resolveAddress(
  explicit: Partial<PostalAddress>,
  printedLines: string[],
  fallbackCountry: string | null,
): PostalAddress {
  const parsed = parseAddressLines(printedLines, fallbackCountry, pickCountry(explicit.country));
  const pick = (value: string | null | undefined, other: string | null): string | null =>
    value && value.trim() !== '' ? value.trim() : other;
  return {
    street: pick(explicit.street, parsed.street),
    postcode: pick(explicit.postcode, parsed.postcode),
    city: pick(explicit.city, parsed.city),
    country: pick(explicit.country?.toUpperCase(), parsed.country),
  };
}
