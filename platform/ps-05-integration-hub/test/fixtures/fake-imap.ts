import { createServer as createNetServer, type Server, type Socket } from 'node:net';
import { createServer as createTlsServer, TLSSocket } from 'node:tls';
import type { Duplex } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { TEST_CERT, TEST_KEY } from './tls.js';

/**
 * A just-enough IMAP4rev1 server for the mailbox tests, speaking the
 * responses RFC 3501 §8 shows: greeting, LOGIN (quoted or literal
 * arguments), STARTTLS, SELECT with EXISTS and UIDVALIDITY, UID SEARCH
 * UNSEEN, UID FETCH (RFC822.SIZE, BODY.PEEK[], BODY.PEEK[HEADER]) with
 * literals, UID STORE +FLAGS.SILENT (\Seen), LOGOUT. In memory, one folder.
 */

export interface FakeMessage {
  uid: number;
  raw: string;
  seen?: boolean;
}

export interface FakeImap {
  port: number;
  messages: FakeMessage[];
  /** Every command line received, passwords included — tests assert on them. */
  commands: string[];
  uidvalidity: number;
  close(): Promise<void>;
}

export async function startFakeImap(opts: {
  mode: 'tls' | 'starttls';
  username: string;
  password: string;
  messages: FakeMessage[];
  uidvalidity?: number;
}): Promise<FakeImap> {
  const state: FakeImap = {
    port: 0,
    messages: opts.messages,
    commands: [],
    uidvalidity: opts.uidvalidity ?? 3857529045,
    close: async () => undefined,
  };
  const sockets = new Set<Duplex>();

  const serve = (initial: Duplex): void => {
    let socket = initial;
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    let line = '';
    const literals: Buffer[] = [];
    let need = 0;
    let loggedIn = false;
    let selected = false;
    const send = (text: string | Buffer): void => {
      socket.write(text);
    };
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (need > 0) {
          if (buffer.length < need) return;
          literals.push(buffer.subarray(0, need));
          line += `\u0000${literals.length - 1}\u0000`;
          buffer = buffer.subarray(need);
          need = 0;
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol < 0) return;
        const piece = buffer.subarray(0, eol).toString('utf8');
        buffer = buffer.subarray(eol + 2);
        const lit = /\{(\d+)\}$/.exec(piece);
        if (lit) {
          line += piece.slice(0, -lit[0].length);
          need = Number(lit[1]);
          send('+ Ready for literal data\r\n');
          continue;
        }
        line += piece;
        const full = line;
        const args = [...literals];
        line = '';
        literals.length = 0;
        if (handle(full, args) === 'upgrade') return;
      }
    };
    const words = (text: string, lits: Buffer[]): string[] => {
      const out: string[] = [];
      const re = /"((?:[^"\\]|\\.)*)"|\u0000(\d+)\u0000|(\S+)/g;
      for (const m of text.matchAll(re)) {
        if (m[1] !== undefined) out.push(m[1].replace(/\\(.)/g, '$1'));
        else if (m[2] !== undefined) out.push(lits[Number(m[2])]!.toString('utf8'));
        else out.push(m[3]!);
      }
      return out;
    };
    const uidsOf = (set: string): number[] => set.split(',').map(Number);
    const handle = (full: string, lits: Buffer[]): 'upgrade' | void => {
      const [tag, ...rest] = words(full, lits);
      const command = (rest[0] ?? '').toUpperCase();
      state.commands.push(`${command} ${rest.slice(1).join(' ')}`.trim());
      if (command === 'CAPABILITY') {
        send(`* CAPABILITY IMAP4rev1 ${opts.mode === 'starttls' ? 'STARTTLS ' : ''}AUTH=PLAIN\r\n${tag} OK CAPABILITY completed\r\n`);
      } else if (command === 'STARTTLS') {
        send(`${tag} OK Begin TLS negotiation now\r\n`);
        socket.off('data', onData);
        const secure = new TLSSocket(socket as Socket, { isServer: true, key: TEST_KEY, cert: TEST_CERT });
        socket = secure;
        sockets.add(secure);
        secure.on('data', onData);
        secure.on('error', () => undefined);
        return 'upgrade';
      } else if (command === 'LOGIN') {
        if (rest[1] === opts.username && rest[2] === opts.password) {
          loggedIn = true;
          send(`${tag} OK LOGIN completed\r\n`);
        } else send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
      } else if (command === 'SELECT') {
        if (!loggedIn) return void send(`${tag} BAD not authenticated\r\n`);
        selected = true;
        send(
          `* ${state.messages.length} EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY ${state.uidvalidity}] UIDs valid\r\n* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n${tag} OK [READ-WRITE] SELECT completed\r\n`,
        );
      } else if (command === 'UID' && selected) {
        const sub = (rest[1] ?? '').toUpperCase();
        if (sub === 'SEARCH') {
          const unseen = state.messages.filter((m) => !m.seen).map((m) => m.uid);
          send(`* SEARCH${unseen.map((u) => ` ${u}`).join('')}\r\n${tag} OK SEARCH completed\r\n`);
        } else if (sub === 'FETCH') {
          const uids = uidsOf(rest[2]!);
          const items = rest.slice(3).join(' ').toUpperCase();
          for (const uid of uids) {
            const index = state.messages.findIndex((m) => m.uid === uid);
            if (index < 0) continue;
            const message = state.messages[index]!;
            const bytes = Buffer.from(message.raw, 'utf8');
            if (items.includes('RFC822.SIZE')) send(`* ${index + 1} FETCH (UID ${uid} RFC822.SIZE ${bytes.length})\r\n`);
            else {
              const section = items.includes('[HEADER]') ? 'HEADER' : '';
              const headerEnd = bytes.indexOf('\r\n\r\n');
              const body = section === 'HEADER' ? bytes.subarray(0, headerEnd < 0 ? bytes.length : headerEnd + 4) : bytes;
              send(`* ${index + 1} FETCH (UID ${uid} BODY[${section}] {${body.length}}\r\n`);
              send(body);
              send(')\r\n');
            }
          }
          send(`${tag} OK FETCH completed\r\n`);
        } else if (sub === 'STORE') {
          for (const uid of uidsOf(rest[2]!)) {
            const message = state.messages.find((m) => m.uid === uid);
            if (message) message.seen = true;
          }
          send(`${tag} OK STORE completed\r\n`);
        } else send(`${tag} BAD unknown UID command\r\n`);
      } else if (command === 'LOGOUT') {
        send(`* BYE IMAP4rev1 Server logging out\r\n${tag} OK LOGOUT completed\r\n`);
        socket.end();
      } else {
        send(`${tag} BAD command unknown or arguments invalid\r\n`);
      }
    };
    socket.on('data', onData);
    socket.on('error', () => undefined);
    send('* OK IMAP4rev1 Service Ready\r\n');
  };

  const server: Server = opts.mode === 'tls' ? createTlsServer({ key: TEST_KEY, cert: TEST_CERT }, serve) : createNetServer(serve);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = (server.address() as AddressInfo).port;
  state.close = () =>
    new Promise((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    });
  return state;
}

/** A plain message with CRLF line endings. */
export function rawMessage(headers: Record<string, string>, body: string): string {
  return `${Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\r\n')}\r\n\r\n${body.replace(/\r?\n/g, '\r\n')}`;
}
