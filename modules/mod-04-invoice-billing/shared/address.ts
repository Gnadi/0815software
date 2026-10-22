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
 *   1010 Wien                 ← "postcode city", 4 or 5 digits (AT, DE, CH …)
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

/** "D-80331 München", "A-1010 Wien", "1010 Wien", "80331 München". */
const POSTCODE_LINE = /^(?:([A-Z]{1,2})\s*-\s*)?(\d{4,5})\s+(.+)$/;

const LETTER_PREFIX: Record<string, string> = { A: 'AT', D: 'DE', CH: 'CH', FL: 'LI', I: 'IT', F: 'FR', L: 'LU' };

/**
 * Read street / postcode / city / country out of printed address lines.
 * `fallbackCountry` (typically from the VAT id) is used when no line names one.
 */
export function parseAddressLines(lines: string[], fallbackCountry: string | null = null): PostalAddress {
  const clean = lines.map((l) => l.trim()).filter((l) => l !== '');
  let country: string | null = null;

  const last = clean[clean.length - 1];
  if (last !== undefined) {
    const named = COUNTRY_NAMES[last.toLowerCase()] ?? (COUNTRY_RE.test(last) ? last : undefined);
    if (named) {
      country = named;
      clean.pop();
    }
  }

  let postcode: string | null = null;
  let city: string | null = null;
  let street: string | null = null;
  for (let i = clean.length - 1; i >= 0; i--) {
    const match = POSTCODE_LINE.exec(clean[i]!);
    if (!match) continue;
    postcode = match[2]!;
    city = match[3]!.trim();
    if (match[1] && !country) country = LETTER_PREFIX[match[1]] ?? null;
    // The street is the line above; a single-line address has none.
    street = i > 0 ? clean[i - 1]! : null;
    break;
  }

  return { street, postcode, city, country: country ?? fallbackCountry };
}

/** Explicit fields first, the printed lines for whatever they leave empty. */
export function resolveAddress(
  explicit: Partial<PostalAddress>,
  printedLines: string[],
  fallbackCountry: string | null,
): PostalAddress {
  const parsed = parseAddressLines(printedLines, fallbackCountry);
  const pick = (value: string | null | undefined, other: string | null): string | null =>
    value && value.trim() !== '' ? value.trim() : other;
  return {
    street: pick(explicit.street, parsed.street),
    postcode: pick(explicit.postcode, parsed.postcode),
    city: pick(explicit.city, parsed.city),
    country: pick(explicit.country?.toUpperCase(), parsed.country),
  };
}
