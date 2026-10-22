import type Database from 'better-sqlite3';
import type { FieldError, Settings } from '../shared/types.js';
import type { SellerConfig } from './config.js';
import { DomainError } from './orders.js';
import type { SelfParty } from './seller.js';

/**
 * What the admin configures on the Settings screen, instead of only the
 * environment: the letterhead on order confirmations and delivery notes, and
 * whether (and from which warehouse) delivery notes book stock in MOD-03.
 *
 * Precedence is per field and one way (server/seller.ts): a value set here
 * wins; an empty one falls back to PS-11's `self` party when the stack has
 * one, then to the `SELLER_*` environment — so clearing a field restores the
 * stack's seller rather than blanking a letterhead.
 * Connection URLs stay in the environment: they are deployment wiring that
 * comes with the machine token, not something to retype on a screen.
 */

export const EMPTY_SETTINGS: Settings = {
  seller_name: null,
  seller_address: null,
  seller_vat_id: null,
  stock_booking: false,
  stock_warehouse: null,
};

export function readSettings(db: Database.Database): Settings {
  const row = db.prepare('SELECT settings FROM settings WHERE id = 1').get() as { settings: string } | undefined;
  return row ? { ...EMPTY_SETTINGS, ...(JSON.parse(row.settings) as Partial<Settings>) } : { ...EMPTY_SETTINGS };
}

export function settingsStamp(db: Database.Database): { updated_at: string | null; updated_by: string | null } {
  const row = db.prepare('SELECT updated_at, updated_by FROM settings WHERE id = 1').get() as
    | { updated_at: string; updated_by: string }
    | undefined;
  return { updated_at: row?.updated_at ?? null, updated_by: row?.updated_by ?? null };
}

type Source = 'settings' | 'ps-11' | 'env';

/** The letterhead as printed: each field from Settings, else PS-11, else the environment. */
export function effectiveSeller(db: Database.Database, env: SellerConfig, self: SelfParty | null = null) {
  const s = readSettings(db);
  // A blank field in PS-11 does not blank the letterhead: it falls through.
  const ps11 = {
    name: self && self.name.trim() !== '' ? self.name.trim() : null,
    addressLines: self && self.address_lines.length > 0 ? self.address_lines : null,
    vatId: self?.vat_id ? self.vat_id : null,
  };
  const pick = <T>(settings: T | null, platform: T | null, fallback: T): [T, Source] =>
    settings !== null ? [settings, 'settings'] : platform !== null ? [platform, 'ps-11'] : [fallback, 'env'];
  const [name, nameSource] = pick(s.seller_name, ps11.name, env.name);
  const [addressLines, addressSource] = pick(s.seller_address, ps11.addressLines, env.addressLines);
  const [vatId, vatSource] = pick(s.seller_vat_id, ps11.vatId, env.vatId);
  return {
    seller: { name, addressLines, vatId } satisfies SellerConfig,
    source: { name: nameSource, address_lines: addressSource, vat_id: vatSource },
  };
}

const VAT_ID = /^[A-Z]{2}[A-Z0-9]{2,13}$/;

/** Validate a PUT body into settings — every error at once. Empty strings mean "fall back". */
export function validateSettings(input: Record<string, unknown>): Settings {
  const errors: FieldError[] = [];
  const text = (field: keyof Settings, max: number): string | null => {
    const v = input[field];
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || v.length > max) {
      errors.push({ field, message: `${field} must be text of at most ${max} characters` });
      return null;
    }
    return v.trim() === '' ? null : v.trim();
  };
  const name = text('seller_name', 200);
  let address: string[] | null = null;
  const rawAddress = input.seller_address;
  if (rawAddress !== undefined && rawAddress !== null) {
    const lines = Array.isArray(rawAddress) && rawAddress.every((l) => typeof l === 'string')
      ? (rawAddress as string[]).map((l) => l.trim()).filter((l) => l !== '')
      : null;
    if (lines === null || lines.length > 6 || lines.some((l) => l.length > 120)) {
      errors.push({ field: 'seller_address', message: 'The address is up to six lines of text, 120 characters each' });
    } else if (lines.length > 0) address = lines;
  }
  const vatId = text('seller_vat_id', 20)?.replace(/\s+/g, '').toUpperCase() ?? null;
  if (vatId !== null && !VAT_ID.test(vatId)) errors.push({ field: 'seller_vat_id', message: 'A VAT id starts with the country code, e.g. ATU12345678' });
  if (input.stock_booking !== undefined && typeof input.stock_booking !== 'boolean') {
    errors.push({ field: 'stock_booking', message: 'stock_booking is true or false' });
  }
  const stockBooking = input.stock_booking === true;
  const warehouse = text('stock_warehouse', 30);
  if (stockBooking && warehouse === null) {
    errors.push({ field: 'stock_warehouse', message: 'Booking stock needs the warehouse goods are issued from' });
  }
  if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);
  return { seller_name: name, seller_address: address, seller_vat_id: vatId, stock_booking: stockBooking, stock_warehouse: warehouse };
}

/** Save, and say which fields actually changed (for the audit trail). */
export function writeSettings(db: Database.Database, settings: Settings, actor: string): string[] {
  const before = readSettings(db);
  const changed = (Object.keys(settings) as (keyof Settings)[]).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(settings[k]));
  db.prepare(
    `INSERT INTO settings (id, settings, updated_at, updated_by) VALUES (1, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(JSON.stringify(settings), new Date().toISOString(), actor);
  return changed;
}
