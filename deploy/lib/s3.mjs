/**
 * The four S3 calls an off-site backup needs — put, get, list, delete — signed
 * with AWS Signature Version 4, on Node's crypto and http(s) only.
 *
 * Path-style addressing (`https://endpoint/bucket/key`), because that is what
 * every S3-compatible store answers to: MinIO on a NAS, Hetzner, Wasabi,
 * IONOS, Backblaze B2, Garage, AWS itself. The signer is tested against AWS's
 * own published examples (deploy/test/backup-offsite.test.ts) — a signature
 * that only "looks right" fails against a real bucket at 2 a.m.
 *
 * Uploads are one PUT with the real SHA-256 of the body in the signature, so
 * the store rejects a body that changed in transit. A single PUT tops out at
 * 5 GiB; larger archives are refused up front with that reason rather than
 * failing half-way through.
 */
import { createHash, createHmac } from 'node:crypto';
import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { pipeline } from 'node:stream/promises';

export const MAX_SINGLE_PUT = 5 * 1024 ** 3;
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

/** RFC 3986 encoding as SigV4 wants it; `/` kept in paths, encoded in query values. */
export function uriEncode(str, keepSlash) {
  return Array.from(Buffer.from(str, 'utf8'))
    .map((b) => {
      const c = String.fromCharCode(b);
      if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === '/')) return c;
      return `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('');
}

const hmac = (key, data) => createHmac('sha256', key).update(data, 'utf8').digest();

/**
 * Compute the SigV4 Authorization header.
 *
 * @param {{ method: string, path: string, query?: Record<string,string>,
 *           headers: Record<string,string>, payloadHash: string,
 *           accessKeyId: string, secretAccessKey: string,
 *           region: string, service?: string, amzDate: string }} req
 *   `headers` must already hold `host` and `x-amz-date`; `path` is unencoded.
 */
export function signV4(req) {
  const service = req.service ?? 's3';
  const query = req.query ?? {};
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k, false)}=${uriEncode(query[k], false)}`)
    .join('&');
  const lower = Object.fromEntries(
    Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]),
  );
  const signedHeaders = Object.keys(lower).sort();
  const canonicalHeaders = signedHeaders.map((k) => `${k}:${lower[k]}\n`).join('');
  const canonicalRequest = [
    req.method,
    uriEncode(req.path, true),
    canonicalQuery,
    canonicalHeaders,
    signedHeaders.join(';'),
    req.payloadHash,
  ].join('\n');

  const date = req.amzDate.slice(0, 8);
  const scope = `${date}/${req.region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    req.amzDate,
    scope,
    createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n');

  const kDate = hmac(`AWS4${req.secretAccessKey}`, date);
  const kSigning = hmac(hmac(hmac(kDate, req.region), service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${req.accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`,
    canonicalRequest,
    signature,
  };
}

function amzNow() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

async function sha256OfFile(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

export class S3Error extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {{ endpoint: string, region: string, bucket: string,
 *           accessKeyId: string, secretAccessKey: string }} cfg
 */
export function s3Client(cfg) {
  const base = new URL(cfg.endpoint);
  const send = base.protocol === 'http:' ? httpRequest : httpsRequest;

  /**
   * One signed request. `body` is a file path (streamed) or nothing;
   * `sink` is a file path the response body is streamed into on success.
   */
  async function call(method, key, { query = {}, bodyFile, sink } = {}) {
    const path = `${base.pathname.replace(/\/$/, '')}/${cfg.bucket}${key ? `/${key}` : ''}`;
    const payloadHash = bodyFile ? await sha256OfFile(bodyFile) : EMPTY_SHA256;
    const amzDate = amzNow();
    const headers = {
      host: base.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    if (bodyFile) headers['content-length'] = String(statSync(bodyFile).size);
    const { authorization } = signV4({
      method,
      path,
      query,
      headers,
      payloadHash,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      region: cfg.region,
      amzDate,
    });
    const qs = Object.keys(query)
      .sort()
      .map((k) => `${uriEncode(k, false)}=${uriEncode(query[k], false)}`)
      .join('&');

    return new Promise((resolve, reject) => {
      const req = send(
        {
          protocol: base.protocol,
          hostname: base.hostname,
          port: base.port || undefined,
          method,
          path: uriEncode(path, true) + (qs ? `?${qs}` : ''),
          headers: { ...headers, authorization },
          timeout: 120_000,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300 && sink) {
            pipeline(res, createWriteStream(sink, { mode: 0o600 })).then(() => resolve({ status, body: '' }), reject);
            return;
          }
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            if (status >= 200 && status < 300) return resolve({ status, body });
            const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? `HTTP ${status}`;
            const msg = /<Message>([^<]+)<\/Message>/.exec(body)?.[1] ?? '';
            reject(new S3Error(`S3 ${method} ${cfg.bucket}/${key ?? ''}: ${code}${msg ? ` — ${msg}` : ''}`, status));
          });
        },
      );
      req.on('timeout', () => req.destroy(new S3Error(`S3 ${method} timed out`, 0)));
      req.on('error', reject);
      if (bodyFile) createReadStream(bodyFile).pipe(req);
      else req.end();
    });
  }

  return {
    async put(key, file) {
      const size = statSync(file).size;
      if (size > MAX_SINGLE_PUT) {
        throw new S3Error(`archive is ${size} bytes; a single S3 PUT accepts at most 5 GiB`, 0);
      }
      await call('PUT', key, { bodyFile: file });
    },
    async get(key, file) {
      await call('GET', key, { sink: file });
    },
    async remove(key) {
      await call('DELETE', key);
    },
    /** Every key under `prefix`, following continuation tokens. */
    async list(prefix) {
      const keys = [];
      let token;
      do {
        const query = { 'list-type': '2', prefix };
        if (token) query['continuation-token'] = token;
        const { body } = await call('GET', '', { query });
        for (const m of body.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(decodeXml(m[1]));
        token = /<IsTruncated>true<\/IsTruncated>/.test(body)
          ? decodeXml(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(body)?.[1] ?? '')
          : undefined;
      } while (token);
      return keys;
    },
  };
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
