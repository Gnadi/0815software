import type { APIRoute } from 'astro';

// This endpoint runs server-side (not prerendered).
// Configure these env vars (see .env.example):
//   RESEND_API_KEY   — get one at https://resend.com
//   CONTACT_TO_EMAIL — where form submissions land
//   CONTACT_FROM_EMAIL — must be a verified Resend domain
export const prerender = false;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Field length caps — generous for humans, a wall for abuse
const MAX_NAME = 200;
const MAX_COMPANY = 200;
const MAX_EMAIL = 320;
const MAX_MESSAGE = 5000;

// Best-effort per-IP rate limit (in-memory, per serverless instance)
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 5;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_MAX;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  // ── Rate limit ────────────────────────────────────────────────────────
  let ip = 'unknown';
  try { ip = clientAddress; } catch { /* not available in all runtimes */ }
  if (rateLimited(ip)) {
    return json({ error: 'Too many requests. Please try again later.' }, 429);
  }

  // ── Parse body ────────────────────────────────────────────────────────
  let body: { name?: string; company?: string; email?: string; message?: string; website?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request body.' }, 400);
  }

  // Honeypot: a real visitor never fills this field. Pretend success.
  if (body.website) return json({ ok: true });

  const name    = body.name?.trim()    ?? '';
  const company = body.company?.trim() ?? '';
  const email   = body.email?.trim()   ?? '';
  const message = body.message?.trim() ?? '';

  // ── Validate ──────────────────────────────────────────────────────────
  if (!name)                          return json({ error: 'Name is required.'            }, 400);
  if (name.length > MAX_NAME)         return json({ error: 'Name is too long.'            }, 400);
  if (company.length > MAX_COMPANY)   return json({ error: 'Company is too long.'         }, 400);
  if (!email)                         return json({ error: 'Email is required.'           }, 400);
  if (email.length > MAX_EMAIL)       return json({ error: 'Email is too long.'           }, 400);
  if (!EMAIL_RE.test(email))          return json({ error: 'Invalid email address.'       }, 400);
  if (!message)                       return json({ error: 'Message is required.'         }, 400);
  if (message.length < 10)            return json({ error: 'Message is too short.'        }, 400);
  if (message.length > MAX_MESSAGE)   return json({ error: 'Message is too long (max 5000 characters).' }, 400);

  // ── Send via Resend ───────────────────────────────────────────────────
  const apiKey   = import.meta.env.RESEND_API_KEY;
  const toEmail  = import.meta.env.CONTACT_TO_EMAIL  || 'hello@0815software.com';
  const fromEmail= import.meta.env.CONTACT_FROM_EMAIL || 'contact@0815software.com';

  if (apiKey) {
    const subject = `New project request from ${name}${company ? ` (${company})` : ''}`;
    const text = [
      `NAME:    ${name}`,
      `COMPANY: ${company || '—'}`,
      `EMAIL:   ${email}`,
      '',
      message,
    ].join('\n');

    const html = `
      <table style="font-family:monospace;font-size:14px;border-collapse:collapse;width:100%">
        <tr><td style="padding:4px 12px 4px 0;color:#6B675F;white-space:nowrap">NAME</td><td>${esc(name)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#6B675F;white-space:nowrap">COMPANY</td><td>${esc(company || '—')}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#6B675F;white-space:nowrap">EMAIL</td><td><a href="mailto:${esc(email)}">${esc(email)}</a></td></tr>
      </table>
      <hr style="border:none;border-top:1px solid #eee;margin:16px 0"/>
      <div style="font-family:sans-serif;font-size:15px;line-height:1.6;white-space:pre-wrap">${esc(message)}</div>
    `;

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ from: fromEmail, to: [toEmail], reply_to: email, subject, text, html }),
      });

      if (!res.ok) {
        const detail = await res.text();
        console.error('[contact] Resend error:', detail);
        return json({ error: 'Failed to send message. Please try again.' }, 502);
      }
    } catch (err) {
      console.error('[contact] Resend fetch failed:', err);
      return json({ error: 'Failed to send message. Please try again.' }, 502);
    }
  } else {
    // Development fallback — log to console
    console.log('[contact form submission]', { name, company, email, message });
    console.log('[contact] Set RESEND_API_KEY in .env to enable real emails.');
  }

  return json({ ok: true });
};

/** Minimal HTML escaping */
function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
