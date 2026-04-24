import type { APIRoute } from 'astro';

// This endpoint runs server-side (not prerendered).
// Configure these env vars (see .env.example):
//   RESEND_API_KEY   — get one at https://resend.com
//   CONTACT_TO_EMAIL — where form submissions land
//   CONTACT_FROM_EMAIL — must be a verified Resend domain
export const prerender = false;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  // ── Parse body ────────────────────────────────────────────────────────
  let body: { name?: string; company?: string; email?: string; message?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request body.' }, 400);
  }

  const name    = body.name?.trim()    ?? '';
  const company = body.company?.trim() ?? '';
  const email   = body.email?.trim()   ?? '';
  const message = body.message?.trim() ?? '';

  // ── Validate ──────────────────────────────────────────────────────────
  if (!name)                      return json({ error: 'Name is required.'            }, 400);
  if (!email)                     return json({ error: 'Email is required.'           }, 400);
  if (!EMAIL_RE.test(email))      return json({ error: 'Invalid email address.'       }, 400);
  if (!message)                   return json({ error: 'Message is required.'         }, 400);
  if (message.length < 10)        return json({ error: 'Message is too short.'        }, 400);

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
        body: JSON.stringify({ from: fromEmail, to: [toEmail], subject, text, html }),
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
