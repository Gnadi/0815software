import { describe, expect, it } from 'vitest';
import {
  decodeEncodedWords,
  decodeQuotedPrintable,
  htmlToText,
  parseAddressList,
  parseMessage,
  parseParameterized,
  splitMultipart,
} from '../server/mime.js';

/**
 * The message parser against the examples the RFCs themselves give — the
 * reference vectors CLAUDE.md asks for: RFC 2047 §8 (encoded words), RFC 2231
 * §3–4 (parameter continuations and charsets), RFC 2045 §6.7 (quoted-
 * printable), RFC 2046 §5.1.1 (the multipart sample message) and RFC 3834
 * (marking auto-replies). Then the shapes real mail clients send.
 */

const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n');
const msg = (s: string) => parseMessage(Buffer.from(crlf(s), 'utf8'));

describe('RFC 2047 §8 — encoded words', () => {
  it.each([
    ['(=?ISO-8859-1?Q?a?=)', '(a)'],
    ['(=?ISO-8859-1?Q?a?= b)', '(a b)'],
    ['(=?ISO-8859-1?Q?a?= =?ISO-8859-1?Q?b?=)', '(ab)'],
    ['(=?ISO-8859-1?Q?a?=  =?ISO-8859-1?Q?b?=)', '(ab)'],
    ['(=?ISO-8859-1?Q?a?=\r\n    =?ISO-8859-1?Q?b?=)', '(ab)'],
    ['(=?ISO-8859-1?Q?a_b?=)', '(a b)'],
    ['(=?ISO-8859-1?Q?a?= =?ISO-8859-2?Q?_b?=)', '(a b)'],
  ])('%s → %s', (encoded, decoded) => {
    expect(decodeEncodedWords(encoded)).toBe(decoded);
  });

  it('the header examples: names in two charsets, a subject split across two words', () => {
    const m = msg(`From: =?US-ASCII?Q?Keith_Moore?= <moore@cs.utk.edu>
To: =?ISO-8859-1?Q?Keld_J=F8rn_Simonsen?= <keld@dkuug.dk>
CC: =?ISO-8859-1?Q?Andr=E9?= Pirard <PIRARD@vm1.ulg.ac.be>
Subject: =?ISO-8859-1?B?SWYgeW91IGNhbiByZWFkIHRoaXMgeW8=?=
    =?ISO-8859-2?B?dSB1bmRlcnN0YW5kIHRoZSBleGFtcGxlLg==?=

body`);
    expect(m.from).toEqual({ name: 'Keith Moore', address: 'moore@cs.utk.edu' });
    expect(m.to).toEqual([{ name: 'Keld Jørn Simonsen', address: 'keld@dkuug.dk' }]);
    expect(m.subject).toBe('If you can read this you understand the example.');
  });

  it('RFC 2231 §5 — a language on the charset', () => {
    expect(decodeEncodedWords('=?US-ASCII*EN?Q?Keith_Moore?=')).toBe('Keith Moore');
  });

  it('a UTF-8 character split between two words is joined before decoding', () => {
    // "Grüße" — the ü's two bytes (C3 BC) land in different words.
    expect(decodeEncodedWords('=?utf-8?Q?Gr=C3?= =?utf-8?Q?=BC=C3=9Fe?=')).toBe('Grüße');
  });
});

describe('RFC 2231 — parameter values', () => {
  it('§4: charset and language', () => {
    expect(parseParameterized("application/x-stuff; title*=us-ascii'en-us'This%20is%20%2A%2A%2Afun%2A%2A%2A").params.title).toBe('This is ***fun***');
  });

  it('§3 and §4.1: continuations, mixing encoded and plain segments', () => {
    const v = parseParameterized(`application/x-stuff;
      title*0*=us-ascii'en'This%20is%20even%20more%20;
      title*1*=%2A%2A%2Afun%2A%2A%2A%20;
      title*2="isn't it!"`.replace(/\n\s*/g, ' '));
    expect(v.value).toBe('application/x-stuff');
    expect(v.params.title).toBe("This is even more ***fun*** isn't it!");
  });

  it('a UTF-8 file name as Outlook and Gmail write it — and the non-standard encoded word in quotes', () => {
    expect(parseParameterized("attachment; filename*=UTF-8''Rechnung%20M%C3%A4rz.pdf").params.filename).toBe('Rechnung März.pdf');
    expect(parseParameterized('attachment; filename="=?utf-8?B?QW5nZWJvdCDDnGJlcnNpY2h0LnBkZg==?="').params.filename).toBe('Angebot Übersicht.pdf');
  });
});

describe('RFC 2045 §6.7 — quoted-printable', () => {
  it('soft line breaks join, =XX decodes, trailing whitespace is dropped', () => {
    const encoded = 'Now\'s the time =\r\nfor all folk to come=\r\n to the aid of their country.   \r\nGr=C3=BC=C3=9Fe=20\r\n';
    expect(decodeQuotedPrintable(encoded).toString('utf8')).toBe("Now's the time for all folk to come to the aid of their country.\r\nGrüße \r\n");
  });

  it('a lone = that is not an escape stays as it is', () => {
    expect(decodeQuotedPrintable('a=b =ZZ').toString('latin1')).toBe('a=b =ZZ');
  });
});

describe('RFC 2046 §5.1.1 — the sample multipart message', () => {
  const sample = `From: Nathaniel Borenstein <nsb@bellcore.com>
To: Ned Freed <ned@innosoft.com>
Date: Sun, 21 Mar 1993 23:56:48 -0800 (PST)
Subject: Sample message
MIME-Version: 1.0
Content-type: multipart/mixed; boundary="simple boundary"

This is the preamble.  It is to be ignored, though it
is a handy place for composition agents to include an
explanatory note to non-MIME conformant readers.

--simple boundary

This is implicitly typed plain US-ASCII text.
It does NOT end with a linebreak.
--simple boundary
Content-type: text/plain; charset=us-ascii

This is explicitly typed plain US-ASCII text.
It DOES end with a linebreak.

--simple boundary--

This is the epilogue.  It is also to be ignored.
`;

  it('two body parts, preamble and epilogue ignored, the line break before a delimiter belonging to it', () => {
    const parts = splitMultipart(crlf(sample).split('\r\n\r\n').slice(1).join('\r\n\r\n'), 'simple boundary');
    expect(parts).toEqual([
      '\r\nThis is implicitly typed plain US-ASCII text.\r\nIt does NOT end with a linebreak.',
      'Content-type: text/plain; charset=us-ascii\r\n\r\nThis is explicitly typed plain US-ASCII text.\r\nIt DOES end with a linebreak.\r\n',
    ]);
    const m = msg(sample);
    expect(m.text).toBe('This is implicitly typed plain US-ASCII text.\nIt does NOT end with a linebreak.\n\nThis is explicitly typed plain US-ASCII text.\nIt DOES end with a linebreak.');
    expect(m.date).toBe('1993-03-22T07:56:48Z');
    expect(m.attachments).toEqual([]);
    expect(m.automated).toBeNull();
  });
});

describe('what mail clients actually send', () => {
  it('alternative plain + HTML with a PDF and an inline logo, quoted-printable German, windows-1252', () => {
    const m = msg(`Return-Path: <anna@kunde.example>
Message-ID: <CAF1234@mail.kunde.example>
In-Reply-To: <ticket-TKT-2026-0007@support.example>
References: <a1@x.example> <ticket-TKT-2026-0007@support.example>
From: "Huber, Anna" <Anna@Kunde.example>
Reply-To: anna.privat@kunde.example
To: Support <support@firma.example>, "Team, Second" <team@firma.example>
Subject: =?windows-1252?Q?Re:_[TKT-2026-0007]_Druckerfehler_=96_noch_offen?=
Date: Thu, 29 Oct 2026 09:15:00 +0100
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="mixed"

--mixed
Content-Type: multipart/alternative; boundary="alt"

--alt
Content-Type: text/plain; charset="windows-1252"
Content-Transfer-Encoding: quoted-printable

Gr=FC=DF Gott,

der Drucker zeigt immer noch =84Papierstau=93 =96 kostet 20 =80 am Tag.
--alt
Content-Type: multipart/related; boundary="rel"

--rel
Content-Type: text/html; charset="utf-8"

<p>HTML version</p><img src="cid:logo@x">
--rel
Content-Type: image/png
Content-ID: <logo@x>
Content-Transfer-Encoding: base64

iVBORw0KGgo=
--rel--
--alt--
--mixed
Content-Type: application/pdf; name="Fehlerprotokoll.pdf"
Content-Disposition: attachment; filename="Fehlerprotokoll.pdf"
Content-Transfer-Encoding: base64

JVBERi0xLjQK
JSVFT0YK
--mixed--
`);
    expect(m.message_id).toBe('CAF1234@mail.kunde.example');
    expect(m.in_reply_to).toBe('ticket-TKT-2026-0007@support.example');
    expect(m.references).toEqual(['a1@x.example', 'ticket-TKT-2026-0007@support.example']);
    expect(m.from).toEqual({ name: 'Huber, Anna', address: 'anna@kunde.example' });
    expect(m.reply_to).toEqual({ name: null, address: 'anna.privat@kunde.example' });
    expect(m.to.map((a) => a.address)).toEqual(['support@firma.example', 'team@firma.example']);
    expect(m.subject).toBe('Re: [TKT-2026-0007] Druckerfehler – noch offen');
    expect(m.text).toBe('Grüß Gott,\n\nder Drucker zeigt immer noch „Papierstau“ – kostet 20 € am Tag.');
    expect(m.attachments.map((a) => [a.filename, a.content_type, a.inline, a.content_id])).toEqual([
      ['attachment-1.png', 'image/png', true, 'logo@x'],
      ['Fehlerprotokoll.pdf', 'application/pdf', false, null],
    ]);
    expect(m.attachments[1]!.content.toString('latin1')).toBe('%PDF-1.4\n%%EOF\n');
    expect(m.automated).toBeNull();
  });

  it('HTML only: readable text, no markup, entities decoded', () => {
    const m = msg(`From: x@y.example
Content-Type: text/html; charset=utf-8
Content-Transfer-Encoding: 8bit

<html><head><style>p{color:red}</style></head><body><p>Hallo&nbsp;Team,</p><p>Ger&auml;t defekt &amp; laut.<br>Danke</p><ul><li>eins</li></ul></body></html>`);
    expect(m.text).toBe('Hallo Team,\nGerät defekt & laut.\nDanke\n\n- eins');
    expect(htmlToText('<script>alert(1)</script>ok &#x263A; &#9731;')).toBe('ok ☺ ☃');
  });

  it('raw UTF-8 in headers (RFC 6532), an address with an old-style comment', () => {
    const m = msg(`From: jdoe@example.org (Jörg Doe)
Subject: Überweisung fehlt

x`);
    expect(m.from).toEqual({ name: 'Jörg Doe', address: 'jdoe@example.org' });
    expect(m.subject).toBe('Überweisung fehlt');
  });

  it('address lists keep commas inside quotes', () => {
    expect(parseAddressList('"Doe, John" <j@x.example>, plain@y.example, Broken')).toEqual([
      { name: 'Doe, John', address: 'j@x.example' },
      { name: null, address: 'plain@y.example' },
    ]);
  });

  it('a forwarded message stays one attachment; a missing close delimiter loses nothing', () => {
    const m = msg(`From: a@b.example
Content-Type: multipart/mixed; boundary=b

--b
Content-Type: text/plain

see below
--b
Content-Type: message/rfc822

From: c@d.example
Subject: inner

inner body
--b
Content-Type: text/plain; name="notes.txt"

tail without close`);
    expect(m.text).toBe('see below');
    expect(m.attachments.map((a) => [a.filename, a.content_type])).toEqual([
      ['attachment-1.eml', 'message/rfc822'],
      ['notes.txt', 'text/plain'],
    ]);
    expect(m.attachments[1]!.content.toString()).toBe('tail without close');
  });
});

describe('RFC 3834 — mail a machine sent', () => {
  const base = 'From: x@y.example\nSubject: s\n';
  it.each([
    ['Auto-Submitted: auto-replied\n', 'Auto-Submitted: auto-replied'],
    ['Precedence: bulk\n', 'Precedence: bulk'],
    ['X-Autoreply: yes\n', 'auto-reply header'],
    ['List-Id: <news.example.com>\n', 'mailing list'],
    ['Return-Path: <>\n', 'bounce (empty return path)'],
    ['Content-Type: multipart/report; report-type=delivery-status; boundary=x\n', 'delivery report'],
  ])('%s', (extra, reason) => {
    expect(msg(`${base}${extra}\nbody`).automated).toBe(reason);
  });

  it('a bounce from the mailer daemon; Auto-Submitted: no is a person', () => {
    expect(msg('From: MAILER-DAEMON@mx.example\nSubject: Undelivered\n\nx').automated).toBe('bounce (mailer-daemon@mx.example)');
    expect(msg(`${base}Auto-Submitted: no\n\nbody`).automated).toBeNull();
  });
});
