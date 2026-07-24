import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Operability without dependencies: structured request logging, request ids,
 * and a Prometheus-style metrics registry (text exposition format). Each
 * service mounts `requestTelemetry` early and exposes its counters plus any
 * domain gauges (queue depths, dead-letters) on `GET /api/metrics`.
 * Logging is off by default in tests (mounted only when index.ts asks).
 */

export interface TelemetryOptions {
  /** Service name stamped on every log line, e.g. "ps-02". */
  service: string;
  /** Write one JSON line per request (default true; tests pass false). */
  log?: boolean;
}

interface CounterKey {
  path: string;
  status: number;
}

const requestCounts = new Map<string, number>();

/** Collapse dynamic path segments so the metric label space stays bounded. */
function routeLabel(path: string): string {
  return (
    path
      .split('?')[0]!
      .split('/')
      .map((seg) => (/^\d+$/.test(seg) || /^[0-9a-f]{8,}$/.test(seg) ? ':id' : seg))
      .join('/') || '/'
  );
}

export function requestTelemetry(opts: TelemetryOptions) {
  const log = opts.log !== false;
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = Date.now();
    const requestId = (typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id']) || randomBytes(8).toString('hex');
    res.setHeader('X-Request-Id', requestId);
    res.on('finish', () => {
      const key = JSON.stringify({ path: routeLabel(req.path), status: res.statusCode } satisfies CounterKey);
      requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);
      if (log) {
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            service: opts.service,
            request_id: requestId,
            method: req.method,
            path: req.path,
            status: res.statusCode,
            duration_ms: Date.now() - started,
          }),
        );
      }
    });
    next();
  };
}

/** A named gauge whose value is computed at scrape time (e.g. a COUNT query). */
export interface Gauge {
  name: string;
  help: string;
  value: () => number;
}

/** Render the Prometheus text exposition for requests + the given gauges. */
export function renderMetrics(service: string, gauges: Gauge[]): string {
  const lines: string[] = [];
  lines.push('# HELP http_requests_total Requests handled, by route and status.');
  lines.push('# TYPE http_requests_total counter');
  for (const [key, count] of requestCounts) {
    const { path, status } = JSON.parse(key) as CounterKey;
    lines.push(`http_requests_total{service="${service}",path="${path}",status="${status}"} ${count}`);
  }
  for (const g of gauges) {
    lines.push(`# HELP ${g.name} ${g.help}`);
    lines.push(`# TYPE ${g.name} gauge`);
    let v: number;
    try {
      v = g.value();
    } catch {
      v = -1; // scrape must never throw; -1 signals a broken gauge
    }
    lines.push(`${g.name}{service="${service}"} ${v}`);
  }
  return lines.join('\n') + '\n';
}
