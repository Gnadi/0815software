/**
 * The subject-access fan-out.
 *
 * The property that matters is not that it collects — it is that it never
 * hides what it did not collect. An assembled report that looks complete while
 * a module's records were never touched is worse than no tool: the controller
 * signs off on an answer that is wrong. So these check the gaps as carefully
 * as the sources.
 */
import { describe, expect, it } from 'vitest';
import { collect } from '../export-subject.mjs';
import { planStack, renderManifest } from '../provision.mjs';

const manifest = JSON.parse(
  renderManifest(
    planStack({
      customer: 'demo',
      org: 'demo',
      domain: 'demo.example.com',
      moduleIds: ['mod-04-invoice-billing', 'mod-13-offers'],
      allServices: true,
    }),
  ),
);

/** A fetch double that answers for the services that can export. */
function fakeFetch(answers: Record<string, unknown>, failing: string[] = []) {
  const asked: string[] = [];
  const impl = async (url: string) => {
    asked.push(url);
    const service = Object.keys(answers).find((prefix) => url.includes(prefix));
    if (failing.some((f) => url.includes(f))) return { ok: false, status: 503, json: async () => ({}) };
    if (!service) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => answers[service] };
  };
  return { impl, asked };
}

const ANSWERS = {
  '/identity': { service: 'ps-01-identity', records: { user: [{ email: 'ada@acme.test' }] } },
  '/notify': { service: 'ps-03-notification-hub', records: { messages: [{ id: 1 }] } },
  '/audit': { service: 'ps-07-audit-log', records: {} },
  '/customers': { service: 'ps-11-customers', records: { parties: [{ id: 4 }] } },
};

describe('collecting a subject across the stack', () => {
  it('asks exactly the services that can answer', async () => {
    const { impl, asked } = fakeFetch(ANSWERS);
    const { sources } = await collect(manifest, {
      subject: 'ada@acme.test',
      token: 't',
      base: 'http://localhost',
      fetchImpl: impl,
    });

    expect(sources.map((s: { source: string }) => s.source).sort()).toEqual([
      'ps-01-identity',
      'ps-03-notification-hub',
      'ps-07-audit-log',
      'ps-11-customers',
    ]);
    // The subject is passed through encoded, not interpolated raw.
    expect(asked.every((url) => url.includes('subject=ada%40acme.test'))).toBe(true);
  });

  it('lists every module as a gap, because none of them can export yet', async () => {
    const { impl } = fakeFetch(ANSWERS);
    const { gaps } = await collect(manifest, {
      subject: 'ada@acme.test',
      token: 't',
      base: 'http://localhost',
      fetchImpl: impl,
    });

    const modules = gaps.filter((g: { kind: string }) => g.kind === 'module');
    expect(modules.map((g: { source: string }) => g.source).sort()).toEqual([
      'mod-04-invoice-billing',
      'mod-13-offers',
    ]);
    for (const gap of modules) {
      expect(gap.action).toMatch(/by hand/);
    }
  });

  it('records a service that could not be reached as a gap, not as empty', async () => {
    // The dangerous failure: a service that is down looks like a service with
    // nothing to say, and the report would understate what is held.
    const { impl } = fakeFetch(ANSWERS, ['/notify']);
    const { sources, gaps } = await collect(manifest, {
      subject: 'ada@acme.test',
      token: 't',
      base: 'http://localhost',
      fetchImpl: impl,
    });

    expect(sources.map((s: { source: string }) => s.source)).not.toContain('ps-03-notification-hub');
    const gap = gaps.find((g: { source: string }) => g.source === 'ps-03-notification-hub');
    expect(gap?.reason).toMatch(/could not be reached/);
    expect(gap?.action).toMatch(/by hand|retry/);
  });

  it('explains the services that hold nothing addressable, rather than omitting them', async () => {
    const { impl } = fakeFetch(ANSWERS);
    const { gaps } = await collect(manifest, {
      subject: 'ada@acme.test',
      token: 't',
      base: 'http://localhost',
      fetchImpl: impl,
    });

    const payments = gaps.find((g: { source: string }) => g.source === 'ps-08-payments');
    expect(payments?.reason).toMatch(/financial records/);
    expect(payments?.action).toMatch(/^none/);

    // Every service in the stack is accounted for exactly once, either as a
    // source or as a gap — nothing is silently dropped.
    const { sources } = await collect(manifest, {
      subject: 'ada@acme.test',
      token: 't',
      base: 'http://localhost',
      fetchImpl: impl,
    });
    const accounted = [
      ...sources.map((s: { source: string }) => s.source),
      ...gaps.filter((g: { kind: string }) => g.kind === 'service').map((g: { source: string }) => g.source),
    ].sort();
    expect(accounted).toEqual(manifest.services.map((s: { id: string }) => s.id).sort());
  });
});
