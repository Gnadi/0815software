import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/http.js';
import {
  AiClient,
  AuditClient,
  FilesClient,
  IdentityClient,
  IntegrationClient,
  NotificationClient,
  NumberClient,
  PaymentsClient,
  SearchClient,
  ServiceError,
  WorkflowClient,
} from '../src/index.js';

interface Captured {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Build an injected fetch that records the call and returns a canned JSON body. */
function recorder(response: unknown, status = 200): { fetch: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method, headers: init?.headers, body: init?.body });
    const raw = JSON.stringify(response);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => raw,
    };
  };
  return { fetch, calls };
}

describe('BaseClient transport', () => {
  it('presents X-Service-Token and forwards an identity token', async () => {
    const { fetch, calls } = recorder({ accepted: true, started: 0 });
    const client = new WorkflowClient({
      baseUrl: 'http://wf:4002/',
      serviceToken: 'svc-secret',
      identityToken: 'ps01-session',
      fetch,
    });
    await client.emit({ type: 'ticket.created', payload: { ref: 'T-1' } });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://wf:4002/api/events'); // trailing slash trimmed
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers!['X-Service-Token']).toBe('svc-secret');
    expect(calls[0]!.headers!['Authorization']).toBe('Bearer ps01-session');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ type: 'ticket.created', payload: { ref: 'T-1' } });
  });

  it('omits auth headers when not configured', async () => {
    const { fetch, calls } = recorder({ valid: true });
    const client = new IdentityClient({ baseUrl: 'http://id:4001', fetch });
    await client.verify('tok');
    expect(calls[0]!.headers!['X-Service-Token']).toBeUndefined();
    expect(calls[0]!.headers!['Authorization']).toBeUndefined();
    expect(JSON.parse(calls[0]!.body!)).toEqual({ token: 'tok' });
  });

  it('raises ServiceError with the parsed error message on non-2xx', async () => {
    const { fetch } = recorder({ error: 'nope' }, 422);
    const client = new NotificationClient({ baseUrl: 'http://n', serviceToken: 's', fetch });
    await expect(client.send({ channel: 'email', to: 'a@b.c', body: 'x' })).rejects.toMatchObject({
      name: 'ServiceError',
      status: 422,
      message: 'nope',
    });
    expect(new ServiceError(500, 'm', {})).toBeInstanceOf(Error);
  });
});

describe('per-service client shapes', () => {
  it('AiClient.runAgent posts to /api/agents/run', async () => {
    const { fetch, calls } = recorder({ id: 'a1', output: 'done', steps: 2 });
    const client = new AiClient({ baseUrl: 'http://ai', serviceToken: 's', fetch });
    const out = await client.runAgent({ goal: 'summarize' });
    expect(calls[0]!.url).toBe('http://ai/api/agents/run');
    expect(out.output).toBe('done');
  });

  it('FilesClient.put base64-encodes bytes and PUTs to the object path', async () => {
    const { fetch, calls } = recorder({ bucket: 'b', key: 'k', size: 3 });
    const client = new FilesClient({ baseUrl: 'http://files', serviceToken: 's', fetch });
    await client.put('b', 'k', new Uint8Array([1, 2, 3]), { content_type: 'application/pdf' });
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.url).toBe('http://files/api/objects/b/k');
    const body = JSON.parse(calls[0]!.body!);
    expect(body.content_base64).toBe(Buffer.from([1, 2, 3]).toString('base64'));
    expect(body.content_type).toBe('application/pdf');
  });

  it('AuditClient.list builds a query string from the filter', async () => {
    const { fetch, calls } = recorder({ events: [] });
    const client = new AuditClient({ baseUrl: 'http://audit', serviceToken: 's', fetch });
    await client.list({ actor: 'u1', limit: 10 });
    expect(calls[0]!.url).toBe('http://audit/api/events?actor=u1&limit=10');
  });

  it('IntegrationClient.proxy targets the connection proxy route', async () => {
    const { fetch, calls } = recorder({ status: 200, body: {} });
    const client = new IntegrationClient({ baseUrl: 'http://int', serviceToken: 's', fetch });
    await client.proxy(7, { path: '/v1/charges' });
    expect(calls[0]!.url).toBe('http://int/api/connections/7/proxy');
  });

  it('PaymentsClient.createIntent posts the intent; refund sends a partial amount', async () => {
    const { fetch, calls } = recorder({ id: 1, status: 'requires_payment' });
    const client = new PaymentsClient({ baseUrl: 'http://pay', serviceToken: 's', fetch });
    await client.createIntent({ reference: 'invoice:1', amount_minor: 500, confirm: true });
    expect(calls[0]!.url).toBe('http://pay/api/intents');
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ reference: 'invoice:1', amount_minor: 500, confirm: true });

    await client.refund(1, 200);
    expect(calls[1]!.url).toBe('http://pay/api/intents/1/refund');
    expect(JSON.parse(calls[1]!.body!)).toEqual({ amount_minor: 200 });
  });

  it('SearchClient.search encodes facet filters as facet.<key> params', async () => {
    const { fetch, calls } = recorder({ total: 0, hits: [], facets: [] });
    const client = new SearchClient({ baseUrl: 'http://s', serviceToken: 's', fetch });
    await client.search({ collection: 'products', q: 'blue', filters: { color: 'blue' }, limit: 5 });
    expect(calls[0]!.url).toBe('http://s/api/search?collection=products&q=blue&facet.color=blue&limit=5');
  });

  it('NumberClient.next posts the scope to /api/next', async () => {
    const { fetch, calls } = recorder({ scope: 'invoice', value: 1, period_key: '2026', formatted: 'INV-2026-0001' });
    const client = new NumberClient({ baseUrl: 'http://n', serviceToken: 's', fetch });
    const out = await client.next('invoice');
    expect(calls[0]!.url).toBe('http://n/api/next');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ scope: 'invoice' });
    expect(out.formatted).toBe('INV-2026-0001');
  });
});

describe('timeouts and retries', () => {
  /** A fetch that fails the first `failures` calls, then answers. */
  function flaky(failures: number, mode: 'throw' | 'status'): { fetch: FetchLike; count: () => number } {
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls += 1;
      if (calls <= failures) {
        if (mode === 'throw') throw new Error('connect ECONNREFUSED');
        return { ok: false, status: 503, text: async () => '{"error":"unavailable"}' };
      }
      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    };
    return { fetch, count: () => calls };
  }

  it('passes an abort signal so a stalled service cannot hang the caller', async () => {
    let seenSignal: AbortSignal | undefined;
    const fetch: FetchLike = async (_url, init) => {
      seenSignal = init?.signal;
      return { ok: true, status: 200, text: async () => '{}' };
    };
    await new NumberClient({ baseUrl: 'http://n', fetch }).get('invoice');
    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  it('retries a GET that fails in transport', async () => {
    const { fetch, count } = flaky(1, 'throw');
    const client = new NumberClient({ baseUrl: 'http://n', fetch, retryDelayMs: 0 });
    await expect(client.get('invoice')).resolves.toBeTruthy();
    expect(count()).toBe(2);
  });

  it('retries a GET that gets a 503', async () => {
    const { fetch, count } = flaky(1, 'status');
    const client = new NumberClient({ baseUrl: 'http://n', fetch, retryDelayMs: 0 });
    await expect(client.get('invoice')).resolves.toBeTruthy();
    expect(count()).toBe(2);
  });

  it('gives up after the configured attempts and surfaces the failure', async () => {
    const { fetch, count } = flaky(99, 'throw');
    const client = new NumberClient({ baseUrl: 'http://n', fetch, retries: 2, retryDelayMs: 0 });
    await expect(client.get('invoice')).rejects.toThrow(/ECONNREFUSED/);
    expect(count()).toBe(3);
  });

  it('never replays a write — the client cannot know if it landed', async () => {
    const { fetch, count } = flaky(1, 'status');
    const client = new NumberClient({ baseUrl: 'http://n', fetch, retryDelayMs: 0 });
    await expect(client.next('invoice')).rejects.toBeInstanceOf(ServiceError);
    expect(count()).toBe(1);
  });
});
