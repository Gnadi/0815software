import type Database from 'better-sqlite3';
import { isCountryCode } from '../shared/countries.js';
import { isPhoneNumber, MISTYPED_LEITWEG, mistypedLeitweg, parseElectronicAddress, parseSchemeIdentifier } from '../shared/einvoice.js';
import { ibanProblem, isValidBic, normalizeBic, normalizeIban } from '../shared/sepa.js';
import type { SellerConfig } from './config.js';
import { DomainError, nowIso } from './invoices.js';
import type { SelfParty } from './seller.js';

/**
 * The seller — this installation's own company — as the people holding the
 * `manage` level maintain it (the PUT is reserved in server/access.ts).
 *
 * Name, address, VAT id and bank account used to come from `SELLER_*`
 * environment variables only, which made every correction a redeploy and put
 * the e-invoice fields XRechnung requires (contact, phone, register number …)
 * out of reach of the person who actually knows them. They are now edited on
 * the Settings screen and stored here; the environment is the starting value.
 *
 * Three sources, one effective seller, decided FIELD BY FIELD:
 *
 *   1. the Settings screen (this table)    — a filled field wins
 *   2. PS-11's `self` party, when wired    — for the fields it carries
 *   3. the `SELLER_*` environment          — the fallback, as before
 *
 * with one exception that keeps PS-11 the single authority it was introduced
 * as: while `CUSTOMERS_URL` is set, the fields PS-11 carries (name, address,
 * VAT id, IBAN, BIC) are MANAGED THERE and read-only here — two places to
 * edit the company name is how two modules end up printing different ones.
 * The e-invoice-only fields have no home in PS-11 and are always edited here.
 *
 * Clearing a field on the screen does not blank it: it falls back to the next
 * source. The live `SellerConfig` object is updated in place (createApp, the
 * PDF renderer and the payment screens all hold it), and issued invoices are
 * unaffected — they carry the seller frozen at the moment they were issued.
 */

/** The fields the Settings screen edits, in screen order. */
export const SELLER_KEYS = [
  'name',
  'addressLines',
  'street',
  'postcode',
  'city',
  'country',
  'vatId',
  'taxNumber',
  'registration',
  'identifier',
  'iban',
  'bic',
  'contactName',
  'phone',
  'email',
  'einvoiceAddress',
  'legalInformation',
] as const;
export type SellerKey = (typeof SELLER_KEYS)[number];

/** What PS-11's `self` party supplies — managed there while it is wired. */
export const PLATFORM_KEYS: readonly SellerKey[] = ['name', 'addressLines', 'vatId', 'iban', 'bic'];

/** The environment variable each field starts from. */
export const SELLER_ENV_NAMES: Record<SellerKey, string> = {
  name: 'SELLER_NAME',
  addressLines: 'SELLER_ADDRESS',
  street: 'SELLER_STREET',
  postcode: 'SELLER_POSTCODE',
  city: 'SELLER_CITY',
  country: 'SELLER_COUNTRY',
  vatId: 'SELLER_VAT_ID',
  taxNumber: 'SELLER_TAX_NUMBER',
  registration: 'SELLER_REGISTRATION',
  identifier: 'SELLER_IDENTIFIER',
  iban: 'SELLER_IBAN',
  bic: 'SELLER_BIC',
  contactName: 'SELLER_CONTACT_NAME',
  phone: 'SELLER_PHONE',
  email: 'SELLER_EMAIL',
  einvoiceAddress: 'SELLER_EINVOICE_ADDRESS',
  legalInformation: 'SELLER_LEGAL_INFORMATION',
};

export type SellerOverrides = Partial<Pick<SellerConfig, SellerKey>>;

export type FieldSource = 'settings' | 'platform' | 'env' | 'unset';

export interface SellerFieldState {
  key: SellerKey;
  env: string;
  /** The effective value; address lines joined with newlines. */
  value: string | null;
  /** What the Settings screen stored, when anything. */
  setting: string | null;
  source: FieldSource;
  /** True while PS-11 manages this field — the screen shows it read-only. */
  locked: boolean;
}

const filled = (value: unknown): boolean =>
  Array.isArray(value) ? value.some((v) => String(v).trim() !== '') : typeof value === 'string' && value.trim() !== '';

const asText = (value: unknown): string | null =>
  !filled(value) ? null : Array.isArray(value) ? value.join('\n') : String(value);

/**
 * Holds the three sources and writes their combination into the live config.
 * Every change to a source recomputes the whole seller, so the order in which
 * the platform refresh and a save on the Settings screen happen cannot matter.
 */
export class SellerSource {
  private readonly env: SellerConfig;
  private platform: SellerOverrides = {};
  private settings: SellerOverrides = {};

  constructor(
    private readonly target: SellerConfig,
    /** True when CUSTOMERS_URL is set: PS-11 manages PLATFORM_KEYS. */
    readonly platformManaged = false,
  ) {
    this.env = { ...target, addressLines: [...(target.addressLines ?? [])] };
  }

  /** PS-11's `self` party, or null when there is none (the env then stands). */
  setPlatform(self: SelfParty | null): void {
    // Trimmed like everything typed on the Settings screen: a padded name would
    // otherwise reach the letterhead, the frozen snapshot and the XRechnung.
    const text = (value: string | null | undefined): string | undefined => {
      const trimmed = value?.trim();
      return trimmed ? trimmed : undefined;
    };
    this.platform = self
      ? {
          name: text(self.name),
          addressLines: (self.address_lines ?? []).map((l) => l.trim()).filter((l) => l !== ''),
          vatId: text(self.vat_id),
          iban: text(self.iban),
          bic: text(self.bic),
        }
      : {};
    this.recompute();
  }

  setSettings(overrides: SellerOverrides): void {
    this.settings = overrides;
    this.recompute();
  }

  private locked(key: SellerKey): boolean {
    return this.platformManaged && PLATFORM_KEYS.includes(key);
  }

  private sourceOf(key: SellerKey): FieldSource {
    if (!this.locked(key) && filled(this.settings[key])) return 'settings';
    if (filled(this.platform[key])) return 'platform';
    if (filled(this.env[key])) return 'env';
    return 'unset';
  }

  private recompute(): void {
    for (const key of SELLER_KEYS) {
      const source = this.sourceOf(key);
      const value =
        source === 'settings' ? this.settings[key] : source === 'platform' ? this.platform[key] : this.env[key];
      if (key === 'addressLines') {
        this.target.addressLines = [...((value as string[] | undefined) ?? [])];
      } else {
        // The required string fields keep '' rather than undefined; the
        // e-invoice fields are optional and simply absent when unset.
        const required = key === 'name' || key === 'vatId' || key === 'iban' || key === 'bic';
        (this.target as unknown as Record<string, string | undefined>)[key] =
          (value as string | undefined) ?? (required ? '' : undefined);
      }
    }
  }

  /** Every field with its effective value and where it comes from — for the screen. */
  describe(): SellerFieldState[] {
    return SELLER_KEYS.map((key) => ({
      key,
      env: SELLER_ENV_NAMES[key],
      value: asText(this.target[key]),
      setting: asText(this.settings[key]),
      source: this.sourceOf(key),
      locked: this.locked(key),
    }));
  }
}

// ── Storage ────────────────────────────────────────────────────────────

export interface StoredSellerSettings {
  overrides: SellerOverrides;
  updated_at: string | null;
  updated_by: string | null;
}

export function readSellerSettings(db: Database.Database): StoredSellerSettings {
  const row = db.prepare('SELECT settings, updated_at, updated_by FROM seller_settings WHERE id = 1').get() as
    | { settings: string; updated_at: string; updated_by: string | null }
    | undefined;
  if (!row) return { overrides: {}, updated_at: null, updated_by: null };
  return { overrides: JSON.parse(row.settings) as SellerOverrides, updated_at: row.updated_at, updated_by: row.updated_by };
}

const LIMITS: Record<Exclude<SellerKey, 'addressLines'>, number> = {
  name: 160,
  street: 120,
  postcode: 16,
  city: 80,
  country: 2,
  vatId: 20,
  taxNumber: 32,
  registration: 80,
  identifier: 80,
  iban: 42,
  bic: 16,
  contactName: 120,
  phone: 40,
  email: 160,
  einvoiceAddress: 200,
  legalInformation: 300,
};

/**
 * Validate what the screen sent and store it. An empty field is simply not
 * stored (it falls back to PS-11 or the env). A field PS-11 manages may not be
 * set here while PS-11 is wired. Returns the stored overrides and the names
 * of the fields whose stored value changed — for the audit trail.
 */
export function writeSellerSettings(
  db: Database.Database,
  raw: unknown,
  options: { platformManaged: boolean; actor: string },
): { overrides: SellerOverrides; changed: SellerKey[] } {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const problems: { field: string; message: string }[] = [];
  const overrides: SellerOverrides = {};

  for (const key of SELLER_KEYS) {
    const rawValue = input[key];
    if (rawValue === undefined || rawValue === null || rawValue === '') continue;
    if (options.platformManaged && PLATFORM_KEYS.includes(key)) {
      problems.push({ field: key, message: 'Managed in PS-11 Customers (the self party) while CUSTOMERS_URL is set' });
      continue;
    }
    if (key === 'addressLines') {
      const lines = (Array.isArray(rawValue) ? rawValue : String(rawValue).split('\n')).map((l) => String(l).trim()).filter(Boolean);
      if (lines.length > 6 || lines.some((l) => l.length > 120)) {
        problems.push({ field: key, message: 'At most 6 address lines of 120 characters' });
      } else if (lines.length > 0) overrides.addressLines = lines;
      continue;
    }
    if (typeof rawValue !== 'string') {
      problems.push({ field: key, message: 'must be text' });
      continue;
    }
    let value = rawValue.trim();
    if (value === '') continue;
    if (value.length > LIMITS[key]) {
      problems.push({ field: key, message: `at most ${LIMITS[key]} characters` });
      continue;
    }
    if (key === 'country') {
      value = value.toUpperCase();
      if (!isCountryCode(value)) problems.push({ field: key, message: 'ISO 3166 code such as DE or AT' });
    }
    if (key === 'vatId') {
      value = value.replace(/\s/g, '').toUpperCase();
      if (!/^[A-Z]{2}[A-Z0-9+*]{2,13}$/.test(value)) problems.push({ field: key, message: 'country prefix + number, e.g. DE123456789' });
    }
    if (key === 'iban') {
      const problem = ibanProblem(value);
      if (problem) problems.push({ field: key, message: problem });
      value = normalizeIban(value);
    }
    if (key === 'bic') {
      value = normalizeBic(value);
      if (!isValidBic(value)) problems.push({ field: key, message: 'BIC has 8 or 11 characters, e.g. BYLADEMMXXX' });
    }
    if (key === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      problems.push({ field: key, message: 'not an email address' });
    }
    if (key === 'phone' && !isPhoneNumber(value)) {
      problems.push({ field: key, message: 'a phone number with at least three digits, e.g. +49 89 123456' });
    }
    if (key === 'einvoiceAddress') {
      const address = parseElectronicAddress(value);
      if (address === null) {
        problems.push({ field: key, message: 'an email address, a Leitweg-ID or a Peppol ID written scheme:identifier, e.g. 0088:4000001000005' });
      } else if (address.scheme === '0204' && mistypedLeitweg(address.value)) {
        problems.push({ field: key, message: `Leitweg-ID ${MISTYPED_LEITWEG}` });
      }
    }
    if (key === 'identifier' && parseSchemeIdentifier(value) === null) {
      problems.push({ field: key, message: 'scheme:identifier with an ISO 6523 scheme, e.g. 0088:4000001000005 for a GLN' });
    }
    overrides[key] = value;
  }
  if (problems.length > 0) throw new DomainError(422, 'Validation failed', problems);

  const before = readSellerSettings(db).overrides;
  const changed = SELLER_KEYS.filter((k) => asText(before[k]) !== asText(overrides[k]));
  db.prepare(
    `INSERT INTO seller_settings (id, settings, updated_at, updated_by) VALUES (1, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
  ).run(JSON.stringify(overrides), nowIso(), options.actor);
  return { overrides, changed };
}
