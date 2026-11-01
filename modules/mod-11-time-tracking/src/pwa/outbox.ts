/**
 * What was captured without a connection, waiting to be sent — in IndexedDB,
 * on this device only.
 *
 * - **Sent once.** Every item carries the client id the server makes a
 *   capture idempotent on, so sending it again after a dropped answer finds
 *   the first row instead of making a second.
 * - **The person's.** Items are kept per login and only that login sees or
 *   sends them; signing out deletes the whole database, pictures included —
 *   a shared phone keeps nothing of the last person.
 * - **Kept until settled.** An item the server refuses (a typo, a receipt
 *   already claimed) stays with the reason, for the person to correct or
 *   discard; nothing is dropped silently.
 */

export type OutboxKind = 'trip' | 'mileage' | 'receipt';

export interface OutboxItem {
  /** The client id — also the server's idempotency key. */
  id: string;
  owner: string;
  kind: OutboxKind;
  body: Record<string, unknown>;
  /** A receipt's picture, already made small. */
  file: Blob | null;
  /** What the list shows: "Gasthaus Zur Post · 28,20 €". */
  label: string;
  created_at: string;
  /** The server's id once the item itself is in, while its picture is not yet. */
  posted_id: number | null;
  error: string | null;
}

const DB = 'mod-11-offline';
const STORE = 'outbox';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('owner', 'owner');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = run(t.objectStore(STORE));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

export function newClientId(): string {
  return crypto.randomUUID();
}

export async function enqueue(item: Omit<OutboxItem, 'created_at' | 'posted_id' | 'error'>): Promise<void> {
  await tx('readwrite', (s) => s.put({ ...item, created_at: new Date().toISOString(), posted_id: null, error: null }));
}

export async function listOutbox(owner: string): Promise<OutboxItem[]> {
  const all = ((await tx<OutboxItem[]>('readonly', (s) => s.index('owner').getAll(owner))) ?? []) as OutboxItem[];
  return all.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function updateOutbox(item: OutboxItem): Promise<void> {
  await tx('readwrite', (s) => s.put(item));
}

export async function removeFromOutbox(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
}

/** Everything this app keeps on the device about anyone: the outbox and the cached login. */
export async function wipeOffline(): Promise<void> {
  for (const key of Object.keys(localStorage)) if (key.startsWith('mod11.')) localStorage.removeItem(key);
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}
