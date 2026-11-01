import { api, ApiError } from '../api';
import { enqueue, listOutbox, newClientId, removeFromOutbox, updateOutbox, type OutboxItem, type OutboxKind } from './outbox';

/**
 * Capture now, send when there is a connection. A capture goes straight to
 * the server when it can; when the network is not there (offline, or the
 * request does not get through) it waits in the outbox and is sent later
 * with the same client id, so the server keeps it once.
 */

const isNetworkError = (err: unknown) => err instanceof TypeError || (err instanceof ApiError && [408, 502, 503, 504].includes(err.status));

async function create(kind: OutboxKind, body: Record<string, unknown>): Promise<{ id: number }> {
  if (kind === 'trip') return api.createTrip(body);
  if (kind === 'mileage') return api.createMileage(body);
  return api.createReceipt(body);
}

export interface Captured {
  /** Waiting on this device rather than on the server. */
  queued: boolean;
}

export async function capture(owner: string, kind: OutboxKind, body: Record<string, unknown>, label: string, file: Blob | null = null): Promise<Captured> {
  const id = newClientId();
  const withId = { ...body, client_id: id };
  if (!navigator.onLine) {
    await enqueue({ id, owner, kind, body: withId, file, label });
    return { queued: true };
  }
  let created: { id: number };
  try {
    created = await create(kind, withId);
  } catch (err) {
    if (!isNetworkError(err)) throw err;
    await enqueue({ id, owner, kind, body: withId, file, label });
    return { queued: true };
  }
  if (file) {
    try {
      await api.uploadReceiptFile(created.id, file);
    } catch (err) {
      if (!isNetworkError(err)) throw err;
      // The receipt is in; its picture follows.
      await enqueue({ id, owner, kind, body: withId, file, label });
      const [item] = (await listOutbox(owner)).filter((i) => i.id === id);
      if (item) await updateOutbox({ ...item, posted_id: created.id });
      return { queued: true };
    }
  }
  return { queued: false };
}

export interface FlushResult {
  sent: number;
  refused: number;
  /** Stopped because the connection or the session is gone. */
  stopped: 'offline' | 'signed-out' | null;
}

/** Send what waits, oldest first. A refusal stays with its reason; a lost connection stops the run. */
export async function flush(owner: string): Promise<FlushResult> {
  const result: FlushResult = { sent: 0, refused: 0, stopped: null };
  if (!navigator.onLine) return { ...result, stopped: 'offline' };
  for (const item of await listOutbox(owner)) {
    try {
      const id = item.posted_id ?? (await create(item.kind, item.body)).id;
      if (item.file) {
        if (item.posted_id === null) await updateOutbox({ ...item, posted_id: id });
        await api.uploadReceiptFile(id, item.file);
      }
      await removeFromOutbox(item.id);
      result.sent++;
    } catch (err) {
      if (isNetworkError(err)) return { ...result, stopped: 'offline' };
      if (err instanceof ApiError && err.status === 401) return { ...result, stopped: 'signed-out' };
      const message = err instanceof ApiError && err.details.length > 0 ? err.details.map((d) => d.message).join('; ') : err instanceof Error ? err.message : String(err);
      await updateOutbox({ ...(item as OutboxItem), error: message });
      result.refused++;
    }
  }
  return result;
}
