import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { FieldError, OrderRow, OrderStatus } from '../../shared/types';
import { Can } from '../access';
import { api, ApiError, fmtEur, parseEurToCents } from '../api';

/**
 * ORDERS — every order, and where its delivery stands.
 *
 * The status column is derived by the server from the delivery notes on every
 * load; nothing here is a stored "delivered" flag. New orders come from an
 * accepted offer (MOD-13) or are entered by hand.
 */

export const STATUS_LABEL: Record<OrderStatus, string> = {
  open: 'OPEN',
  partially_delivered: 'PARTLY DELIVERED',
  delivered: 'DELIVERED',
  cancelled: 'CANCELLED',
};

/** The badge colours the shared stylesheet has: ordered → received. */
export const STATUS_BADGE: Record<OrderStatus, string> = {
  open: 'badge--ordered',
  partially_delivered: 'badge--partially_received',
  delivered: 'badge--received',
  cancelled: 'badge--draft',
};

interface Props {
  onOpen: (id: number) => void;
  onAuthLost: () => void;
}

export function OrdersView({ onOpen, onAuthLost }: Props) {
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<OrderStatus | ''>('');
  const [offerNumber, setOfferNumber] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const handle = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof Error ? err.message : 'Request failed');
    },
    [onAuthLost],
  );

  const load = useCallback(async () => {
    try {
      setOrders((await api.orders({ status: status || undefined, search: search || undefined })).orders);
    } catch (err) {
      handle(err);
    }
  }, [handle, search, status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function importOffer(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      const order = await api.importOffer(offerNumber.trim());
      setOfferNumber('');
      onOpen(order.id);
    } catch (err) {
      handle(err);
    }
  }

  if (creating) {
    return (
      <NewOrderForm
        onDone={(id) => {
          setCreating(false);
          if (id !== null) onOpen(id);
          else void load();
        }}
        onAuthLost={onAuthLost}
      />
    );
  }

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ ORD.01 · SALES</div>
          <h1 className="resource__title">Orders</h1>
          <p className="resource__desc">
            Confirmed orders and their deliveries. An order is delivered in as many delivery notes as it takes — never
            more than was ordered — and each delivery note is billed on its own.
          </p>
        </div>
        <Can>
          <div className="resource__actions">
            <form className="toolbar" onSubmit={(e) => void importOffer(e)}>
              <input
                className="field__input"
                placeholder="Accepted offer no."
                value={offerNumber}
                onChange={(e) => setOfferNumber(e.target.value)}
              />
              <button className="btn btn--ghost" type="submit" disabled={offerNumber.trim() === ''}>
                CONFIRM OFFER →
              </button>
            </form>
            <button className="btn btn--primary" onClick={() => setCreating(true)}>
              + NEW ORDER
            </button>
          </div>
        </Can>
      </div>

      {error && <div className="resource__error mono">{error}</div>}

      <div className="toolbar">
        <input className="toolbar__search field__input" placeholder="Search number or customer" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="field__input" value={status} onChange={(e) => setStatus(e.target.value as OrderStatus | '')}>
          <option value="">All</option>
          {(Object.keys(STATUS_LABEL) as OrderStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <span className="toolbar__count mono">{orders?.length ?? '…'} ORDERS</span>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Order</th>
              <th>Date</th>
              <th>Customer</th>
              <th>Status</th>
              <th className="table__num">Delivery notes</th>
              <th className="table__num">Gross</th>
            </tr>
          </thead>
          <tbody>
            {orders?.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={6}>
                  NO ORDERS
                </td>
              </tr>
            )}
            {orders?.map((o) => (
              <tr key={o.id}>
                <td>
                  <button className="linklike mono" onClick={() => onOpen(o.id)}>
                    {o.number}
                  </button>
                </td>
                <td className="mono table__id">{o.order_date}</td>
                <td>
                  {o.customer_name}
                  {o.customer_reference && <span className="table__id mono"> · {o.customer_reference}</span>}
                </td>
                <td>
                  <span className={`badge mono ${STATUS_BADGE[o.status]}`}>{STATUS_LABEL[o.status]}</span>
                </td>
                <td className="table__num mono">{o.delivery_note_count}</td>
                <td className="table__num mono">{fmtEur(o.totals.gross_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface EditableLine {
  description: string;
  quantity: string;
  unitPrice: string;
  discount: string;
  vatRate: string;
}

const EMPTY: EditableLine = { description: '', quantity: '1', unitPrice: '', discount: '0', vatRate: '20' };

/** An order entered by hand — confirmed and numbered on save, its lines fixed after. */
function NewOrderForm({ onDone, onAuthLost }: { onDone: (id: number | null) => void; onAuthLost: () => void }) {
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [email, setEmail] = useState('');
  const [vatId, setVatId] = useState('');
  const [address, setAddress] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<EditableLine[]>([{ ...EMPTY }]);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
  const [busy, setBusy] = useState(false);

  const setLine = (i: number, patch: Partial<EditableLine>) => setLines((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setFieldErrors([]);
    try {
      const order = await api.createOrder({
        customer: { name, contact_person: contact, email, vat_id: vatId, address },
        customer_reference: reference,
        note,
        lines: lines.map((l) => ({
          description: l.description,
          quantity: Number(l.quantity.replace(',', '.')),
          unit_price_cents: parseEurToCents(l.unitPrice) ?? -1,
          discount_percent: Number(l.discount.replace(',', '.')) || 0,
          vat_rate: Number(l.vatRate),
        })),
      });
      onDone(order.id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onAuthLost();
        return;
      }
      setError(err instanceof Error ? err.message : 'Request failed');
      setFieldErrors(err instanceof ApiError ? err.details : []);
    } finally {
      setBusy(false);
    }
  }

  const field = (label: string, value: string, set: (v: string) => void, required = false) => (
    <label className="field">
      <span className="field__label mono">
        {label} {required && <span className="field__req">*</span>}
      </span>
      <input className="field__input" value={value} onChange={(e) => set(e.target.value)} />
    </label>
  );

  return (
    <div>
      <button className="backlink mono" onClick={() => onDone(null)}>
        ← ORDERS
      </button>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ ORD.01 · SALES</div>
          <h1 className="resource__title">New order</h1>
          <p className="resource__desc">Saving confirms it: the order gets its number, and its lines are what the customer ordered from then on.</p>
        </div>
      </div>
      {error && <div className="resource__error mono">{error}</div>}
      {fieldErrors.length > 0 && <div className="resource__error mono">{fieldErrors.map((e) => `${e.field}: ${e.message}`).join(' · ')}</div>}
      <form onSubmit={(e) => void submit(e)}>
        <div className="modal__fields">
          {field('CUSTOMER', name, setName, true)}
          {field('CONTACT', contact, setContact)}
          {field('EMAIL', email, setEmail)}
          {field('VAT ID', vatId, setVatId)}
          <label className="field">
            <span className="field__label mono">ADDRESS (ONE LINE PER ROW)</span>
            <textarea className="field__input" rows={3} value={address} onChange={(e) => setAddress(e.target.value)} />
          </label>
          {field('THEIR ORDER NO', reference, setReference)}
          {field('NOTE', note, setNote)}
        </div>
        <div className="section-title mono">LINES</div>
        {lines.map((line, i) => (
          <div key={i} className="po-line">
            <label className="field">
              <span className="field__label mono">
                {i + 1} · DESCRIPTION <span className="field__req">*</span>
              </span>
              <input className="field__input" value={line.description} onChange={(e) => setLine(i, { description: e.target.value })} />
            </label>
            <label className="field">
              <span className="field__label mono">QTY</span>
              <input className="field__input" value={line.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} />
            </label>
            <label className="field">
              <span className="field__label mono">UNIT €</span>
              <input className="field__input" placeholder="0,00" value={line.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} />
            </label>
            <label className="field">
              <span className="field__label mono">DISC %</span>
              <input className="field__input" value={line.discount} onChange={(e) => setLine(i, { discount: e.target.value })} />
            </label>
            <label className="field">
              <span className="field__label mono">VAT</span>
              <select className="field__input" value={line.vatRate} onChange={(e) => setLine(i, { vatRate: e.target.value })}>
                {[20, 13, 10, 19, 7, 0].map((r) => (
                  <option key={r} value={r}>
                    {r}%
                  </option>
                ))}
              </select>
            </label>
            <button className="rowbtn rowbtn--danger mono po-line__remove" type="button" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
        ))}
        <button className="toolbar__clear mono" type="button" onClick={() => setLines([...lines, { ...EMPTY }])}>
          + ADD LINE
        </button>
        <div className="modal__actions">
          <button className="btn btn--ghost" type="button" onClick={() => onDone(null)}>
            CANCEL
          </button>
          <button className="btn btn--primary" type="submit" disabled={busy}>
            {busy ? 'SAVING…' : 'CONFIRM ORDER →'}
          </button>
        </div>
      </form>
    </div>
  );
}
