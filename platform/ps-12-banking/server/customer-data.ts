import { DomainError } from './errors.js';
import { collectDownload, openSession, type SessionContext } from './bank-session.js';
import { buildAdminDownload } from './ebics/envelopes.js';
import {
  parseAvailableOrderData,
  parseBankParameters,
  parseCustomerData,
  type BankParameters,
  type CustomerData,
} from './ebics/parse.js';
import type { BtfInput } from '../shared/types.js';

/**
 * `HTD` and `HKD` — asking the bank what this customer may actually do.
 *
 * ## Why this is the most useful read in the service
 *
 * Every BTF this service can name has, until now, come from a table
 * transcribed out of a PDF: which services exist, which scopes, which message
 * names. Those tables are national, they change, and a transcription error in
 * one shows up as a refused upload weeks later.
 *
 * `HTD` replaces the guess with an answer. The bank returns the order types
 * and BTFs **it has enabled for this contract**, the accounts they apply to,
 * the number of signatures each needs and — per subscriber — the signature
 * class held and any per-order ceiling. That is authoritative in a way no
 * published table can be, because it is specific to one customer at one bank
 * on the day it is asked.
 *
 * So the honest answer to "which BTFs do you support?" is: whichever ones the
 * bank lists here. `availableDownloads` turns that list into the BTFs a
 * download subscription can be created from, and `bank-registry.ts` stays what
 * it always was — a starting point for an operator who has not connected yet.
 *
 * ## HTD or HKD
 *
 * `HTD` describes the subscriber asking; `HKD` describes the whole customer,
 * every subscriber included. A bank may have enabled only one of the two, and
 * a customer with a single subscriber gets the same answer either way, so the
 * caller chooses and neither is a fallback for the other — quietly retrying
 * with the other order type would report a different subject under the same
 * name.
 */

export type CustomerDataScope = 'subscriber' | 'customer';

export async function fetchCustomerData(
  ctx: SessionContext,
  connectionKey: string,
  scope: CustomerDataScope = 'subscriber',
): Promise<CustomerData> {
  const session = openSession(ctx, connectionKey);
  const { subscriber, keys, bank, at } = session;
  const orderType = scope === 'customer' ? 'HKD' : 'HTD';

  const data = await collectDownload(
    ctx,
    session,
    buildAdminDownload({ subscriber, keys, bank, timestamp: at, orderType }),
  );
  // Unlike a statement, "nothing waiting" is not a sensible answer to this
  // question — the bank always knows what it has enabled. A bank that answers
  // 090005 here has not enabled the order type at all.
  if (data === null) {
    throw new DomainError(502, `the bank returned no data for ${orderType} — it may not have enabled that order type`);
  }
  return parseCustomerData(data.toString('utf8'));
}

/**
 * The downloadable BTFs in an `HTD`/`HKD` answer, deduplicated.
 *
 * `BTD` is the only order type here whose service parameters name a file to
 * fetch; an administrative order type carries no `Service` at all, and `BTU`
 * names something to send. Filtering to `BTD` is what makes this list safe to
 * hand straight to a download subscription.
 */
export function availableDownloads(data: CustomerData): BtfInput[] {
  const seen = new Map<string, BtfInput>();
  for (const order of data.orders) {
    if (order.adminOrderType !== 'BTD' || order.service === null) continue;
    const btf: BtfInput = {
      service_name: order.service.serviceName,
      msg_name: order.service.msgName,
      ...(order.service.scope === null ? {} : { scope: order.service.scope }),
      ...(order.service.option === null ? {} : { option: order.service.option }),
      ...(order.service.container === null ? {} : { container: order.service.container }),
    };
    seen.set(JSON.stringify(btf), btf);
  }
  return [...seen.values()];
}

/**
 * `HPD` — the bank's own access and protocol parameters.
 *
 * The cheapest possible compatibility check. This service speaks H005, X002,
 * E002 and A005/A006; a bank that lists none of those will refuse everything
 * afterwards with a return code that says far less than this does.
 */
export async function fetchBankParameters(ctx: SessionContext, connectionKey: string): Promise<BankParameters> {
  const data = await collect(ctx, connectionKey, 'HPD');
  if (data === null) {
    throw new DomainError(502, 'the bank returned no data for HPD — it may not have enabled that order type');
  }
  return parseBankParameters(data.toString('utf8'));
}

/**
 * `HAA` — the BTFs the bank has data waiting for right now.
 *
 * Not the same question as `HTD`'s order list, and the difference matters when
 * choosing what to poll: `HTD` says what this customer is permitted to fetch,
 * `HAA` says what is actually there.
 */
export async function fetchAvailableOrderData(ctx: SessionContext, connectionKey: string): Promise<BtfInput[]> {
  const data = await collect(ctx, connectionKey, 'HAA');
  // Unlike HTD, "nothing" is a perfectly ordinary answer here: it means the
  // bank has no files waiting, which is most of the time.
  if (data === null) return [];
  return parseAvailableOrderData(data.toString('utf8')).map((service) => ({
    service_name: service.serviceName,
    msg_name: service.msgName,
    ...(service.scope === null ? {} : { scope: service.scope }),
    ...(service.option === null ? {} : { option: service.option }),
    ...(service.container === null ? {} : { container: service.container }),
  }));
}

/** The three lines every administrative download shares. */
async function collect(
  ctx: SessionContext,
  connectionKey: string,
  orderType: 'HPD' | 'HAA',
): Promise<Buffer | null> {
  const session = openSession(ctx, connectionKey);
  const { subscriber, keys, bank, at } = session;
  return collectDownload(
    ctx,
    session,
    buildAdminDownload({ subscriber, keys, bank, timestamp: at, orderType }),
  );
}
