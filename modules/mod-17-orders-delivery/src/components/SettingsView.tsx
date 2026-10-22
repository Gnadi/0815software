import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { FieldError, SellerSource, SettingsResponse } from '../../shared/types';
import { useCan } from '../access';
import { api, ApiError } from '../api';

/**
 * SETTINGS — what the admin configures here instead of in the environment:
 * the letterhead on order confirmations and delivery notes (an empty field
 * falls back to PS-11's `self` party, then SELLER_*), and whether delivery notes book stock in MOD-03,
 * from which warehouse. Read-only below `manage`.
 */
export function SettingsView({ onAuthLost }: { onAuthLost: () => void }) {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [vatId, setVatId] = useState('');
  const [booking, setBooking] = useState(false);
  const [reserving, setReserving] = useState(false);
  const [warehouse, setWarehouse] = useState('');
  const [error, setError] = useState('');
  const [details, setDetails] = useState<FieldError[]>([]);
  const [saved, setSaved] = useState('');
  const editable = useCan('manage');

  const fill = (res: SettingsResponse) => {
    setData(res);
    setName(res.settings.seller_name ?? '');
    setAddress((res.settings.seller_address ?? []).join('\n'));
    setVatId(res.settings.seller_vat_id ?? '');
    setBooking(res.settings.stock_booking);
    setReserving(res.settings.stock_reservation);
    setWarehouse(res.settings.stock_warehouse ?? '');
  };

  const handle = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else {
        setError(err instanceof Error ? err.message : 'Request failed');
        setDetails(err instanceof ApiError ? err.details : []);
      }
    },
    [onAuthLost],
  );

  useEffect(() => {
    api.settings().then(fill, handle);
  }, [handle]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setError('');
    setDetails([]);
    setSaved('');
    try {
      const res = await api.saveSettings({
        seller_name: name || null,
        seller_address: address.split('\n').map((l) => l.trim()).filter((l) => l !== ''),
        seller_vat_id: vatId || null,
        stock_booking: booking,
        stock_reservation: reserving,
        stock_warehouse: warehouse || null,
      });
      fill(res);
      setSaved(`Saved by ${res.updated_by ?? '—'}`);
    } catch (err) {
      handle(err);
    }
  }

  if (!data) return error ? <div className="resource__error mono">{error}</div> : <div className="boot mono">LOADING…</div>;
  const from = (source: SellerSource) =>
    source === 'settings' ? 'SET HERE' : source === 'ps-11' ? 'FROM PS-11 CUSTOMERS' : 'FROM ENVIRONMENT';

  return (
    <div>
      <div className="resource__head">
        <div>
          <div className="resource__eyebrow mono">§ ORD.02 · ADMIN</div>
          <h1 className="resource__title">Settings</h1>
          <p className="resource__desc">
            The letterhead and stock booking. An empty field falls back to the stack&apos;s seller in PS-11 Customers, or
            to what the installation was set up with. Changing
            them is the admin&apos;s; {data.updated_by ? `last saved by ${data.updated_by} on ${data.updated_at?.slice(0, 10)}` : 'nothing saved here yet'}.
          </p>
        </div>
      </div>
      {error && (
        <div className="resource__error mono">
          {error}
          {details.map((d) => (
            <div key={d.field}>
              {d.field}: {d.message}
            </div>
          ))}
        </div>
      )}
      <form onSubmit={(e) => void save(e)}>
        <div className="section-title mono">LETTERHEAD</div>
        <div className="modal__fields">
          <label className="field">
            <span className="field__label mono">COMPANY · {from(data.seller_source.name)}</span>
            <input className="field__input" disabled={!editable} value={name} placeholder={data.seller.name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span className="field__label mono">ADDRESS, ONE LINE PER ROW · {from(data.seller_source.address_lines)}</span>
            <textarea className="field__input" rows={3} disabled={!editable} value={address} placeholder={data.seller.address_lines.join('\n')} onChange={(e) => setAddress(e.target.value)} />
          </label>
          <label className="field">
            <span className="field__label mono">VAT ID · {from(data.seller_source.vat_id)}</span>
            <input className="field__input" disabled={!editable} value={vatId} placeholder={data.seller.vat_id} onChange={(e) => setVatId(e.target.value)} />
          </label>
        </div>

        <div className="section-title mono">STOCK (MOD-03 INVENTORY)</div>
        {!data.inventory.configured ? (
          <p className="resource__desc">
            No inventory is connected to this installation (INVENTORY_URL). Delivery notes book no stock until it is.
          </p>
        ) : (
          <div className="modal__fields">
            <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" disabled={!editable} checked={booking} onChange={(e) => setBooking(e.target.checked)} />
              <span className="mono">BOOK A GOODS ISSUE FOR EVERY DELIVERY NOTE WITH ARTICLE NUMBERS</span>
            </label>
            <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" disabled={!editable} checked={reserving} onChange={(e) => setReserving(e.target.checked)} />
              <span className="mono">RESERVE THE ARTICLES AS SOON AS AN ORDER IS CONFIRMED</span>
            </label>
            <label className="field">
              <span className="field__label mono">ISSUE FROM WAREHOUSE</span>
              {data.inventory.warehouses ? (
                <select className="field__input" disabled={!editable} value={warehouse} onChange={(e) => setWarehouse(e.target.value)}>
                  <option value="">— choose —</option>
                  {data.inventory.warehouses.map((w) => (
                    <option key={w.code} value={w.code}>
                      {w.code} · {w.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="resource__error mono">MOD-03 did not answer: {data.inventory.error}</span>
              )}
            </label>
          </div>
        )}

        {editable && (
          <div className="modal__actions">
            {saved && <span className="mono table__id">{saved}</span>}
            <button className="btn btn--primary" type="submit">
              SAVE SETTINGS →
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
