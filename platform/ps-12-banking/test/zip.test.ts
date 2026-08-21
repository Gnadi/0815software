import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { documentsIn, looksLikeZip, unzip, ZipError } from '../server/zip.js';

/**
 * The ZIP reader, tested against archives built here byte by byte.
 *
 * Building the fixtures in the test rather than committing binaries is what
 * makes the awkward cases reachable: an entry whose local header lies about
 * its size (general-purpose bit 3, which a streaming writer sets and which is
 * the reason this reader trusts the central directory instead), an archive
 * comment, ZIP64 markers, an unknown compression method. Each of those is a
 * silent wrong answer in a reader that guesses.
 *
 * The reader was also checked by hand against archives from Info-ZIP's `zip`
 * and Python's `zipfile` — two implementations that have never read this code
 * — including a 50 KB entry recovered byte for byte.
 */

interface Entry {
  name: string;
  content: Buffer;
  /** Store instead of deflate. */
  stored?: boolean;
  /** Set bit 3 and zero the LOCAL header's sizes, as a streaming writer does. */
  streamed?: boolean;
  flagBits?: number;
  /** Force a compression method the reader should refuse. */
  method?: number;
}

/** A ZIP writer, just complete enough to feed the reader its hard cases. */
function makeZip(entries: Entry[], comment = ''): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const method = entry.method ?? (entry.stored === true ? 0 : 8);
    const body = method === 0 ? entry.content : deflateRawSync(entry.content);
    const flags = (entry.flagBits ?? 0) | (entry.streamed === true ? 0x0008 : 0);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    // A streaming writer does not know the sizes yet, so it writes zeroes and
    // repeats them after the data. A reader trusting these gets nothing.
    local.writeUInt32LE(entry.streamed === true ? 0 : body.length, 18);
    local.writeUInt32LE(entry.streamed === true ? 0 : entry.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + body.length;
  }

  const directory = Buffer.concat(centrals);
  const tail = Buffer.from(comment, 'utf8');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(tail.length, 20);
  return Buffer.concat([...locals, directory, eocd, tail]);
}

const xml = (n: number): Buffer => Buffer.from(`<?xml version="1.0"?><Doc n="${n}">${'p'.repeat(n * 100)}</Doc>`, 'utf8');

describe('reading an archive', () => {
  it('opens a deflated entry and gives back the exact bytes', () => {
    const content = xml(50);
    const entries = unzip(makeZip([{ name: 'camt.053.xml', content }]));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe('camt.053.xml');
    expect(entries[0]!.content.equals(content)).toBe(true);
  });

  it('opens a stored entry', () => {
    const content = Buffer.from('not worth compressing', 'utf8');
    expect(unzip(makeZip([{ name: 'a.xml', content, stored: true }]))[0]!.content.equals(content)).toBe(true);
  });

  it('keeps several entries, in order', () => {
    const archive = makeZip([
      { name: 'day1.xml', content: xml(1) },
      { name: 'day2.xml', content: xml(2) },
      { name: 'day3.xml', content: xml(3) },
    ]);
    expect(unzip(archive).map((e) => e.name)).toEqual(['day1.xml', 'day2.xml', 'day3.xml']);
    expect(unzip(archive)[2]!.content.equals(xml(3))).toBe(true);
  });

  it('reads sizes from the central directory, not the local header', () => {
    // THE REASON THIS READER EXISTS IN THIS SHAPE. A streaming writer sets bit
    // 3 and leaves the local header's sizes at zero. A reader that trusted
    // them would return an empty file — with no error, for a bank statement.
    const content = xml(20);
    const entries = unzip(makeZip([{ name: 'streamed.xml', content, streamed: true }]));
    expect(entries[0]!.content.byteLength).toBe(content.byteLength);
    expect(entries[0]!.content.equals(content)).toBe(true);
  });

  it('finds the directory past a trailing archive comment', () => {
    const content = xml(5);
    const archive = makeZip([{ name: 'a.xml', content }], 'produced by a bank, 2026-08-21');
    expect(unzip(archive)[0]!.content.equals(content)).toBe(true);
  });

  it('skips directory entries — they carry no document', () => {
    const archive = makeZip([
      { name: 'statements/', content: Buffer.alloc(0), stored: true },
      { name: 'statements/a.xml', content: xml(2) },
    ]);
    expect(unzip(archive).map((e) => e.name)).toEqual(['statements/a.xml']);
  });
});

describe('refusing what it cannot open honestly', () => {
  it('refuses something that is not an archive at all', () => {
    expect(() => unzip(Buffer.from('<?xml version="1.0"?><Document/>', 'utf8'))).toThrow(ZipError);
    expect(() => unzip(Buffer.alloc(0))).toThrow(/no end-of-central-directory/);
  });

  it('refuses an encrypted entry rather than returning garbage', () => {
    const archive = makeZip([{ name: 'secret.xml', content: xml(1), flagBits: 0x0001 }]);
    expect(() => unzip(archive)).toThrow(/encrypted/);
  });

  it('refuses a compression method it cannot open', () => {
    // Method 12 is bzip2. Inflating it would produce noise, not an error.
    const archive = makeZip([{ name: 'a.xml', content: xml(1), method: 12 }]);
    expect(() => unzip(archive)).toThrow(/compression method 12/);
  });

  it('refuses a truncated archive', () => {
    const archive = makeZip([{ name: 'a.xml', content: xml(10) }]);
    const chopped = Buffer.concat([archive.subarray(0, 40), archive.subarray(archive.length - 200)]);
    expect(() => unzip(chopped)).toThrow(ZipError);
  });
});

describe('documentsIn — what the bank actually sent', () => {
  it('unpacks an archive', () => {
    const archive = makeZip([{ name: 'a.xml', content: xml(1) }, { name: 'b.xml', content: xml(2) }]);
    expect(documentsIn(archive)).toHaveLength(2);
  });

  it('passes a bare XML document straight through', () => {
    // Sniffed, not taken from the BTF: a bank that publishes Container=ZIP
    // may still send one bare document, and believing the BTF would hand that
    // to the ZIP reader and get nothing.
    const bare = Buffer.from('<?xml version="1.0"?><Document/>', 'utf8');
    expect(documentsIn(bare)).toHaveLength(1);
    expect(documentsIn(bare)[0]!.equals(bare)).toBe(true);
    expect(looksLikeZip(bare)).toBe(false);
  });
});
