/**
 * The monitoring drift test.
 *
 * A monitoring config is worse than none when it looks right and watches
 * nothing: a scrape target for a container that no longer exists, or an alert
 * on a metric no service publishes, both read as silence — which from the
 * outside is indistinguishable from health. So every target is checked against
 * the stack that was generated, and every metric named in a rule is checked
 * against the source of the service that is supposed to export it.
 *
 * Offline and dependency-free by construction, like the rest of `deploy`: it
 * renders the plan and reads source files, and picks the rendered YAML apart
 * with line matching rather than pulling in a parser. What that cannot prove
 * is that Prometheus itself accepts the file, so the indentation the format
 * depends on is asserted explicitly below.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PLACEHOLDER,
  planStack,
  renderAlertmanager,
  renderAlerts,
  renderBlackbox,
  renderCompose,
  renderPrometheus,
} from '../provision.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

const options = (extra = {}) => ({
  customer: 'demo',
  org: 'demo',
  domain: 'demo.example.com',
  moduleIds: ['mod-04-invoice-billing', 'mod-13-offers'],
  allServices: false,
  ...extra,
});

const plan = planStack(options());
const prometheus = renderPrometheus(plan);
const alerts = renderAlerts(plan);
const compose = renderCompose(plan, '..');

/** The quoted targets of one scrape job, in order. */
function targetsOf(config: string, job: string): string[] {
  const section = config.slice(config.indexOf(`job_name: ${job}`));
  const next = section.indexOf('job_name:', 1);
  const body = next === -1 ? section : section.slice(0, next);
  return [...body.matchAll(/^\s+- '([^']+)'$/gm)].map((m) => m[1]!);
}

/** Every `- alert: X` in a rules file. */
const alertNames = (config: string): string[] =>
  [...config.matchAll(/^\s+- alert: (\S+)$/gm)].map((m) => m[1]!);

/** The `expr:` of each rule, in the same order. */
const alertExprs = (config: string): string[] =>
  [...config.matchAll(/^\s+expr: (.+)$/gm)].map((m) => m[1]!);

describe('scrape targets match the stack', () => {
  it('scrapes every service in the selection, and nothing else', () => {
    const expected = plan.services.map((s) => `${s.name}:${s.service.defaultPort}`).sort();
    expect(targetsOf(prometheus, 'platform-services').sort()).toEqual(expected);
  });

  it('probes readiness for every service AND module — the modules publish no metrics', () => {
    const expected = [
      ...plan.services.map((s) => `http://${s.name}:${s.service.defaultPort}/api/ready`),
      ...plan.modules.map((m: { subdomain: string; mod: { defaultPort: number } }) =>
        `http://${m.subdomain}:${m.mod.defaultPort}/api/ready`),
    ].sort();
    expect(targetsOf(prometheus, 'readiness').sort()).toEqual(expected);
  });

  it('names only containers the compose file defines', () => {
    for (const target of [...targetsOf(prometheus, 'platform-services'), ...targetsOf(prometheus, 'readiness')]) {
      const host = target.replace(/^http:\/\//, '').split(':')[0]!;
      expect(compose, `${host} is scraped but is not a container in this stack`).toContain(`  ${host}:`);
    }
  });

  it('grows with the selection', () => {
    const bigger = planStack(options({ allServices: true }));
    const targets = targetsOf(renderPrometheus(bigger), 'platform-services');
    expect(targets).toHaveLength(bigger.services.length);
    expect(targets.length).toBeGreaterThan(plan.services.length);
  });
});

describe('alert rules mean something', () => {
  it('always covers a container being down, not ready, or erroring', () => {
    expect(alertNames(alerts)).toEqual(expect.arrayContaining(['ContainerDown', 'NotReady', 'ServerErrors']));
  });

  it('every domain metric it alerts on is really exported by a selected service', () => {
    // The gauge names live in each service's app.ts. Rename one there and the
    // rule quietly stops matching anything — the failure this test exists for.
    const sources = plan.services.map(({ service }) => ({
      id: service.id,
      src: readFileSync(`${root}/platform/${service.id}/server/app.ts`, 'utf8'),
    }));
    const domainMetrics = alertExprs(alerts)
      .flatMap((expr) => expr.match(/[a-z][a-z0-9_]*_[a-z0-9_]+/g) ?? [])
      .filter((m) => !m.startsWith('http_requests') && !['probe_success', 'up'].includes(m));

    expect(domainMetrics.length, 'no domain metric is watched at all').toBeGreaterThan(0);
    for (const metric of new Set(domainMetrics)) {
      const exporter = sources.find(({ src }) => src.includes(`name: '${metric}'`));
      expect(exporter, `no service in this stack exports ${metric}`).toBeDefined();
    }
  });

  it('leaves out rules for services this stack does not run', () => {
    // PS-02 and PS-05 are not in this selection, so their rules must be absent:
    // a rule nobody can ever satisfy reads as permanent good news.
    expect(plan.services.map((s) => s.service.id)).not.toContain('ps-02-workflow-engine');
    expect(alertNames(alerts)).not.toContain('WebhookDeliveriesNotDraining');
    expect(alertNames(alerts)).not.toContain('IntegrationSyncFailing');
    // …and the ones it does run are there.
    expect(alertNames(alerts)).toContain('AuditChainBroken');

    const everything = renderAlerts(planStack(options({ allServices: true })));
    expect(alertNames(everything)).toContain('WebhookDeliveriesNotDraining');
    expect(alertNames(everything)).toContain('IntegrationSyncFailing');
  });

  it('gives every rule a severity and a delay, so a blip is not a page', () => {
    const severities = [...alerts.matchAll(/^\s+labels: \{ severity: (\w+) \}$/gm)].map((m) => m[1]!);
    const delays = [...alerts.matchAll(/^\s+for: (\S+)$/gm)].map((m) => m[1]!);
    expect(severities).toHaveLength(alertNames(alerts).length);
    expect(delays).toHaveLength(alertNames(alerts).length);
    for (const severity of severities) expect(['critical', 'warning']).toContain(severity);
    for (const delay of delays) expect(delay).toMatch(/^\d+m$/);
  });

  it('keeps the indentation the rules format depends on', () => {
    // Without a YAML parser here, this is what stands between a template edit
    // and a rules file Prometheus refuses to load.
    expect(alerts).toContain('groups:\n  - name: platform\n    rules:\n');
    for (const line of alerts.split('\n')) {
      if (line.startsWith('#') || line.trim() === '') continue;
      expect(line, `unexpected indentation: ${line}`).not.toMatch(/\t/);
      if (line.includes('- alert:')) expect(line.startsWith('      - alert:'), line).toBe(true);
    }
  });
});

describe('the monitoring containers', () => {
  it('are opt-in through a compose profile', () => {
    for (const name of ['prometheus', 'alertmanager', 'blackbox']) {
      expect(compose).toContain(`  ${name}:`);
    }
    expect(compose.match(/profiles:\n\s+- "monitoring"/g) ?? []).toHaveLength(3);
  });

  it('persists Prometheus data, so history survives a restart', () => {
    expect(compose).toContain('prometheus-data:/prometheus');
    expect(compose).toContain('  prometheus-data:');
  });

  it('does not route alerts through the stack it is watching', () => {
    // PS-03 could send the mail, and would be unable to exactly when it counts.
    // The generated file explains that in a comment; what must not appear is a
    // receiver actually pointing back into the stack.
    const config = renderAlertmanager(plan);
    const receivers = config.slice(config.indexOf('receivers:'));
    expect(receivers).not.toMatch(/ps0\d|:40\d\d/);
    expect(config).toContain(PLACEHOLDER); // the receiver is the operator's to fill in
  });

  it('probes with a config the blackbox exporter understands', () => {
    expect(renderBlackbox(plan)).toContain('prober: http');
    expect(renderBlackbox(plan)).toContain('valid_status_codes: [200]');
  });
});
