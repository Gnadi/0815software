import type Database from 'better-sqlite3';
import { nowIso } from './tracking.js';

/**
 * The statutory rates this module ships with — what an Austrian office would
 * otherwise type in from the law before the first trip could be claimed.
 *
 * They are written into `expense_rates` on boot, each once (its `preset` key
 * is unique), stamped `preset` and with where the number comes from. From
 * then on they are rows like the office's own: a correction is a new row
 * from a date, and the newest row for a date wins (server/expenses.ts). A
 * later release that knows a new statutory rate adds it with its own date and
 * key, so an office that already superseded a preset keeps its own value
 * from its own date.
 *
 * Domestic, from the text of the law:
 *   § 26 Z 4 lit. b EStG 1988 — Tagesgeld bis zu 30 € pro Tag
 *   § 26 Z 4 lit. c EStG 1988 — Nächtigungsgeld bis zu 17 € (Frühstück inklusive)
 *     (in this wording since 1 January 2025)
 *   § 10 Abs. 3–5 RGV 1955 — Kilometergeld 0,50 € (Pkw), 0,25 € (Motorrad,
 *     Moped), 0,25 € (Fahrrad), Mitfahrerzuschlag 0,15 € (in force since 1 July 2025)
 * and one from the Lohnsteuerrichtlinien as secondary sources state it: a
 * paid lunch or dinner reduces a domestic day's Tagesgeld by 15 €.
 *
 * Abroad, § 26 Z 4 lit. d EStG points at the Auslandsreisesätze of federal
 * employees — for the tax exemption the ones of BGBl. 483/1993 in the version
 * of BGBl. II 434/2001 (Gebührenstufe 3): the WKO's table of them, "Stand:
 * 01.01.2026", every row, as day and night rate. Places with their own rate
 * (Brüssel, Grenzorte, …) are their own row. A collective agreement may grant
 * more; that is the office's to enter.
 */

export const PRESET_ACTOR = 'preset';

const DOMESTIC: readonly { kind: string; valid_from: string; amount_cents: number; basis: string }[] = [
  { kind: 'per_diem_domestic', valid_from: '2025-01-01', amount_cents: 3000, basis: '§ 26 Z 4 lit. b EStG 1988' },
  { kind: 'night_domestic', valid_from: '2025-01-01', amount_cents: 1700, basis: '§ 26 Z 4 lit. c EStG 1988' },
  { kind: 'meal_reduction_domestic', valid_from: '2025-01-01', amount_cents: 1500, basis: 'LStR 2002 (Kürzung bei Arbeitsessen)' },
  { kind: 'mileage_car', valid_from: '2025-07-01', amount_cents: 50, basis: '§ 10 Abs. 3 Z 2 RGV 1955' },
  { kind: 'mileage_motorbike', valid_from: '2025-07-01', amount_cents: 25, basis: '§ 10 Abs. 3 Z 1 RGV 1955' },
  { kind: 'mileage_bicycle', valid_from: '2025-07-01', amount_cents: 25, basis: '§ 10 Abs. 5 RGV 1955' },
  { kind: 'mileage_passenger', valid_from: '2025-07-01', amount_cents: 15, basis: '§ 10 Abs. 4 RGV 1955' },
];

const FOREIGN_BASIS = 'Auslandsreisesätze, BGBl. 483/1993 idF BGBl. II 434/2001 (WKO-Tabelle, Stand 01.01.2026)';
const FOREIGN_FROM = '2025-01-01';

/** [country as the table names it, day rate, night rate] in cents. */
export const FOREIGN_RATES: readonly (readonly [string, number, number])[] = [
  ["Albanien", 2790, 2090],
  ["Belarus", 3680, 3100],
  ["Belgien", 3530, 2270],
  ["Belgien: Brüssel", 4140, 3200],
  ["Bosnien und Herzegowina", 3100, 2330],
  ["Bulgarien", 3100, 2270],
  ["Dänemark", 4140, 4140],
  ["Deutschland", 3530, 2790],
  ["Deutschland: Grenzort", 3070, 1810],
  ["Estland", 3680, 3100],
  ["Finnland", 4140, 4140],
  ["Frankreich", 3270, 2400],
  ["Frankreich: Paris/Straßburg", 3580, 3270],
  ["Griechenland", 2860, 2330],
  ["Großbritannien und Nordirland", 3680, 3640],
  ["Großbritannien: London", 4140, 4140],
  ["Irland", 3680, 3310],
  ["Island", 3790, 3140],
  ["Italien", 3580, 2790],
  ["Italien: Rom/Mailand", 4060, 3640],
  ["Italien: Grenzorte", 3070, 1810],
  // The ordinance still uses this name (the WKO table notes as much).
  ["Jugoslawien", 3100, 2330],
  ["Kroatien", 3100, 2330],
  ["Lettland", 3680, 3100],
  ["Liechtenstein", 3070, 1810],
  ["Litauen", 3680, 3100],
  ["Luxemburg", 3530, 2270],
  ["Malta", 3010, 3010],
  ["Moldau", 3680, 3100],
  ["Niederlande", 3530, 2790],
  ["Norwegen", 4290, 4140],
  ["Polen", 3270, 2510],
  ["Portugal", 2790, 2270],
  ["Rumänien", 3680, 2730],
  ["Russische Föderation", 3680, 3100],
  ["Russ. Föderation: Moskau", 4060, 3100],
  ["Schweden", 4290, 4140],
  ["Schweiz", 3680, 3270],
  ["Schweiz: Grenzorte", 3070, 1810],
  ["Slowakei", 2790, 1590],
  ["Slowakei: Bratislava", 3100, 2440],
  ["Slowenien", 3100, 2330],
  ["Slowenien: Grenzorte", 2790, 1590],
  ["Spanien", 3420, 3050],
  ["Tschechien", 3100, 2440],
  ["Tschechien: Grenzorte", 2790, 1590],
  ["Türkei", 3100, 3640],
  ["Ukraine", 3680, 3100],
  ["Ungarn", 2660, 2660],
  ["Ungarn: Budapest", 3100, 2660],
  ["Ungarn: Grenzorte", 2660, 1810],
  ["Zypern", 2860, 3050],
  ["Ägypten", 3790, 4140],
  ["Algerien", 4140, 2700],
  ["Angola", 4360, 4140],
  ["Äthiopien", 3790, 4140],
  ["Benin", 3620, 2660],
  ["Burkina Faso", 3920, 2110],
  ["Burundi", 3790, 3790],
  ["Côte d'Ivoire", 3920, 3200],
  ["Demokratische Rep. Kongo", 4730, 3310],
  ["Dschibuti", 4580, 4730],
  ["Gabun", 4580, 3990],
  ["Gambia", 4360, 3010],
  ["Ghana", 4360, 3010],
  ["Guinea", 4360, 3010],
  ["Kamerun", 4580, 2530],
  ["Kap Verde", 2790, 1960],
  ["Kenia", 3490, 3200],
  ["Liberia", 3920, 4140],
  ["Libyen", 4360, 3640],
  ["Madagaskar", 3640, 3640],
  ["Malawi", 3270, 3270],
  ["Mali", 3920, 3120],
  ["Marokko", 3270, 2180],
  ["Mauretanien", 3380, 3120],
  ["Mauritius", 3640, 3640],
  ["Mosambik", 4360, 4140],
  ["Namibia", 3490, 3400],
  ["Niger", 3920, 2110],
  ["Nigeria", 3920, 3420],
  ["Republik Kongo", 3920, 2680],
  ["Ruanda", 3790, 3790],
  ["Sambia", 3710, 3400],
  ["Senegal", 4930, 3120],
  ["Seychellen", 3640, 3640],
  ["Sierra Leone", 4360, 3420],
  ["Simbabwe", 3710, 3400],
  ["Somalia", 3270, 2900],
  ["Südafrika", 3490, 3400],
  ["Sudan", 4360, 4140],
  ["Tansania", 4360, 3200],
  ["Togo", 3620, 2660],
  ["Tschad", 3620, 2660],
  ["Tunesien", 3620, 2920],
  ["Uganda", 4140, 3200],
  ["Zentralafrik. Republik", 3920, 2900],
  ["Argentinien", 3310, 4730],
  ["Bahamas", 4800, 3050],
  ["Barbados", 5100, 4360],
  ["Bolivien", 2660, 2510],
  ["Brasilien", 3310, 3640],
  ["Chile", 3750, 3640],
  ["Costa Rica", 3180, 3180],
  ["Dominikanische Republik", 3920, 4360],
  ["Ecuador", 2660, 2160],
  ["El Salvador", 3180, 2620],
  ["Guatemala", 3180, 3180],
  ["Guyana", 3920, 3420],
  ["Haiti", 3920, 2770],
  ["Honduras", 3180, 2700],
  ["Jamaika", 4710, 4710],
  ["Kanada", 4100, 3420],
  ["Kolumbien", 3310, 3510],
  ["Kuba", 5410, 2770],
  ["Mexiko", 4100, 3640],
  ["Nicaragua", 3180, 3640],
  ["Niederländische Antillen", 4360, 2770],
  ["Panama", 4360, 3640],
  ["Paraguay", 3310, 2510],
  ["Peru", 3310, 2510],
  ["Suriname", 3920, 2510],
  ["Trinidad, Tobago", 5100, 4360],
  ["Uruguay", 3310, 2510],
  ["USA", 5230, 4290],
  ["USA: New York/Washington", 6540, 5100],
  ["Venezuela", 3920, 3510],
  ["Afghanistan", 3180, 2770],
  ["Armenien", 3680, 3100],
  ["Aserbaidschan", 3680, 3100],
  ["Bahrein", 5410, 3750],
  ["Bangladesch", 3180, 3420],
  ["Brunei", 3310, 4210],
  ["China", 3510, 3050],
  ["Georgien", 3680, 3100],
  ["Hongkong", 4640, 3790],
  ["Indien", 3180, 3990],
  ["Indonesien", 3920, 3200],
  ["Irak", 5410, 3640],
  ["Iran", 3710, 2900],
  ["Israel", 3710, 3250],
  ["Japan", 6560, 4290],
  ["Jemen", 5410, 3750],
  ["Jordanien", 3710, 3250],
  ["Kambodscha", 3140, 3140],
  ["Kasachstan", 3680, 3100],
  ["Katar", 5410, 3750],
  ["Kirgisistan", 3680, 3100],
  ["Korea, Dem. Volksrepublik", 3250, 3250],
  ["Korea, Republik", 4530, 3250],
  ["Kuwait", 5410, 3750],
  ["Laos", 3140, 3140],
  ["Libanon", 3180, 3510],
  ["Malaysia", 4360, 4510],
  ["Mongolei", 2940, 2940],
  ["Myanmar", 2940, 2940],
  ["Nepal", 3180, 3420],
  ["Oman", 5410, 3750],
  ["Pakistan", 2770, 2510],
  ["Philippinen", 3250, 3250],
  ["Saudi-Arabien", 5410, 3750],
  ["Singapur", 4360, 4470],
  ["Sri Lanka", 3180, 3270],
  ["Syrien", 3270, 2900],
  ["Tadschikistan", 3680, 3100],
  ["Taiwan", 3920, 3750],
  ["Thailand", 3920, 4210],
  ["Turkmenistan", 3680, 3100],
  ["Usbekistan", 3680, 3100],
  ["Ver. Arabische Emirate", 5410, 3750],
  ["Vietnam", 3140, 3140],
  ["Australien", 4730, 3990],
  ["Neuseeland", 3250, 3640],
];

export function installExpensePresets(db: Database.Database): void {
  const insert = db.prepare(
    `INSERT INTO expense_rates (kind, country, valid_from, amount_cents, basis, preset, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (preset) DO NOTHING`,
  );
  const at = nowIso();
  db.transaction(() => {
    for (const r of DOMESTIC) insert.run(r.kind, null, r.valid_from, r.amount_cents, r.basis, `${r.kind}@${r.valid_from}`, PRESET_ACTOR, at);
    for (const [country, day, night] of FOREIGN_RATES) {
      insert.run('per_diem_abroad', country, FOREIGN_FROM, day, FOREIGN_BASIS, `per_diem_abroad:${country}@${FOREIGN_FROM}`, PRESET_ACTOR, at);
      insert.run('night_abroad', country, FOREIGN_FROM, night, FOREIGN_BASIS, `night_abroad:${country}@${FOREIGN_FROM}`, PRESET_ACTOR, at);
    }
  })();
}
