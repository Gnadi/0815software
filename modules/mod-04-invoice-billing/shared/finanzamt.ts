/**
 * The Austrian tax offices, and their collection accounts.
 *
 * Transcribed from the annex to *Finanzamtszahlung in EBICS* (PSA, v1.0.01,
 * 20.10.2022). Every IBAN here is check-digit verified by `finanzamt.test.ts`,
 * because a transcription slip in this file would send a tax payment to an
 * account that does not exist — or worse, to one that does.
 *
 * ## Why this is a hint and not a rule
 *
 * The specification says only listed IBANs may be used for a Finanzamtszahlung
 * — and marks the annex **"NICHT NORMATIV"**, warns that the list changes, and
 * asks implementers to keep it easy to maintain. A hard check against a list
 * that goes stale would block a legitimate payment to a new office, which is
 * the worse failure: the bank will refuse an unknown one anyway, and refusing
 * it here as well buys nothing.
 *
 * So `finanzamtFor` answers "is this a tax office, and which one" — enough to
 * offer a Finanzamtszahlung when an operator types one of these IBANs, and to
 * name the office on screen. Nothing refuses a payment on its say-so.
 *
 * There is deliberately no mapping from the tax account's office number to an
 * IBAN. The specification is explicit that after the 2020 mergers a tax number
 * outlives the office that issued it, so "etwaige Prüfungen der
 * Übereinstimmung zwischen Steuernummer und IBAN sind daher auszubauen".
 */

export interface Finanzamt {
  /** The office number as the annex lists it. Not related to the IBAN. */
  office: number;
  name: string;
  /** Normalised: no spaces, upper case. */
  iban: string;
}

/** The only BIC a Finanzamtszahlung may carry, when it carries one at all. */
export const FINANZAMT_BIC = 'BUNDATWW';

export const FINANZAEMTER: readonly Finanzamt[] = [
  { office: 3, name: 'Wien 3/6/7/11/15 Schwechat Gerasdorf', iban: 'AT870100000005504037' },
  { office: 6, name: 'Wien 8/16/17', iban: 'AT260100000005504068' },
  { office: 7, name: 'Wien 4/5/9/10/18/19 Klosterneuburg', iban: 'AT310100000005504075' },
  { office: 8, name: 'Wien 12/13/14 Purkersdorf', iban: 'AT360100000005504082' },
  { office: 9, name: 'Wien 1/23', iban: 'AT620100000005504099' },
  { office: 10, name: 'Sonderzuständigkeiten', iban: 'AT830100000005504109' },
  { office: 11, name: 'Finanzamt für Großbetriebe', iban: 'AT880100000005504116' },
  { office: 12, name: 'Wien 2/20/21/22', iban: 'AT930100000005504123' },
  { office: 15, name: 'Amstetten Melk Scheibbs', iban: 'AT320100000005504154' },
  { office: 16, name: 'Baden Mödling', iban: 'AT370100000005504161' },
  { office: 22, name: 'Weinviertel', iban: 'AT280100000005504226' },
  { office: 23, name: 'Waldviertel', iban: 'AT330100000005504233' },
  { office: 29, name: 'Niederösterreich Mitte', iban: 'AT080100000005504295' },
  { office: 37, name: 'Amt für Betrugsbekämpfung', iban: 'AT090100000005504374' },
  { office: 38, name: 'Bruck Eisenstadt Oberwart', iban: 'AT140100000005504381' },
  { office: 41, name: 'Braunau Ried Schärding', iban: 'AT540100000005524419' },
  { office: 46, name: 'Linz', iban: 'AT030100000005524464' },
  { office: 51, name: 'Kirchdorf Perg Steyr', iban: 'AT650100000005524512' },
  { office: 52, name: 'Freistadt Rohrbach Urfahr', iban: 'AT910100000005524529' },
  { office: 53, name: 'Gmunden Vöcklabruck', iban: 'AT960100000005524536' },
  { office: 54, name: 'Grieskirchen Wels', iban: 'AT040100000005524543' },
  { office: 57, name: 'Klagenfurt St. Veit Wolfsberg', iban: 'AT920100000005564572' },
  { office: 61, name: 'Spittal Villach', iban: 'AT520100000005564613' },
  { office: 67, name: 'Oststeiermark', iban: 'AT070100000005534674' },
  { office: 68, name: 'Graz-Stadt', iban: 'AT120100000005534681' },
  { office: 69, name: 'Steiermark Mitte', iban: 'AT380100000005534698' },
  { office: 71, name: 'Judenburg Liezen', iban: 'AT640100000005534715' },
  { office: 72, name: 'Deutschlandsberg Leibnitz Voitsberg', iban: 'AT690100000005534722' },
  { office: 81, name: 'Innsbruck', iban: 'AT310100000005544815' },
  { office: 83, name: 'Tirol Ost', iban: 'AT620100000005544839' },
  { office: 84, name: 'Landeck Reutte', iban: 'AT670100000005544846' },
  { office: 90, name: 'St. Johann Tamsweg Zell am See', iban: 'AT900100000005554908' },
  { office: 91, name: 'Salzburg-Stadt', iban: 'AT950100000005554915' },
  { office: 93, name: 'Salzburg-Land', iban: 'AT290100000005554939' },
  { office: 98, name: 'Vorarlberg', iban: 'AT630100000005574988' },
] as const;

const BY_IBAN = new Map(FINANZAEMTER.map((office) => [office.iban, office]));

/**
 * The tax office that collects on this IBAN, or null.
 *
 * Tolerant of spacing and case, because an operator pastes an IBAN the way the
 * office prints it.
 */
export function finanzamtFor(iban: string): Finanzamt | null {
  return BY_IBAN.get(iban.replace(/\s+/g, '').toUpperCase()) ?? null;
}
