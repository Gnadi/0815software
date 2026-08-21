/**
 * The mock bank, over HTTP — for a cross-process end-to-end run only.
 *
 * Same reasoning as mock-bank.ts itself: this listens on a socket and would
 * accept payment files, so it lives in `test/` and is started by hand. Nothing
 * imports it, and no deployment can reach it.
 */
import { createServer } from 'node:http';
import { MockBank } from './mock-bank.js';

const bank = new MockBank({ hostId: process.env.HOST_ID ?? 'MOCKHOST' });
const port = Number(process.env.PORT ?? 4999);

createServer((req, res) => {
  if (req.url === '/received') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(bank.received.map((o) => ({ ...o, orderData: o.orderData.toString('utf8') }))));
    return;
  }
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const answer = bank.post(Buffer.concat(chunks).toString('utf8'));
    res.statusCode = answer.status;
    res.setHeader('content-type', 'text/xml; charset=UTF-8');
    res.end(answer.body);
  });
}).listen(port, () => console.log(`[mock-bank] listening on ${port}`));
