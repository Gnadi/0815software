import type Database from 'better-sqlite3';
import { hashPassword } from './auth.js';
import type { GlobalRole, MatterRole } from '../shared/types.js';
import { writeBlob } from './storage.js';

/**
 * Demo data for MOD-09. Real multi-user setup: four users (one admin) and
 * three matters with overlapping-but-distinct memberships, so cross-matter
 * isolation is easy to see by logging in as different people. Eight
 * documents carry multi-version histories and tags. Every version's bytes
 * are generated as plain text at seed time and written to the content-
 * addressed store — no binary artifacts are committed anywhere.
 *
 * Dev credentials (documented in the README):
 *   admin / demo-admin   (admin — sees every matter)
 *   mara  / demo-mara     owner on MAT-2026-014, viewer on MAT-2026-033
 *   theo  / demo-theo     editor on MAT-2026-014, owner on MAT-2026-021,
 *                         viewer on MAT-2026-033
 *   iris  / demo-iris     viewer on MAT-2026-021, owner on MAT-2026-033
 */

interface SeedUser {
  username: string;
  name: string;
  role: GlobalRole;
  password: string;
}

interface SeedMember {
  username: string;
  role: MatterRole;
}

interface SeedVersion {
  uploader: string; // username
  note: string;
  at: string;
}

interface SeedDocument {
  title: string;
  tags: string[];
  versions: SeedVersion[];
}

interface SeedMatter {
  key: string;
  name: string;
  description: string;
  createdAt: string;
  members: SeedMember[];
  documents: SeedDocument[];
}

const users: SeedUser[] = [
  { username: 'admin', name: 'Dana Ellis', role: 'admin', password: 'demo-admin' },
  { username: 'mara', name: 'Mara Voss', role: 'member', password: 'demo-mara' },
  { username: 'theo', name: 'Theo Brandt', role: 'member', password: 'demo-theo' },
  { username: 'iris', name: 'Iris Lindqvist', role: 'member', password: 'demo-iris' },
];

const matters: SeedMatter[] = [
  {
    key: 'MAT-2026-014',
    name: 'Acme Corp — Series B Financing',
    description: 'Financing round documents, cap table and board approvals.',
    createdAt: '2026-02-03T09:00:00Z',
    members: [
      { username: 'mara', role: 'owner' },
      { username: 'theo', role: 'editor' },
    ],
    documents: [
      {
        title: 'Series B Term Sheet',
        tags: ['finance', 'draft'],
        versions: [
          { uploader: 'mara', note: 'Initial draft', at: '2026-02-04T10:15:00Z' },
          { uploader: 'theo', note: 'Investor comments incorporated', at: '2026-02-10T14:40:00Z' },
          { uploader: 'mara', note: 'Signed final', at: '2026-02-18T11:05:00Z' },
        ],
      },
      {
        title: 'Cap Table',
        tags: ['finance', 'spreadsheet'],
        versions: [
          { uploader: 'mara', note: 'Pre-round table', at: '2026-02-04T10:20:00Z' },
          { uploader: 'mara', note: 'Post-round table', at: '2026-02-18T11:20:00Z' },
        ],
      },
      {
        title: 'Board Consent',
        tags: ['governance'],
        versions: [{ uploader: 'theo', note: 'Executed consent', at: '2026-02-19T09:00:00Z' }],
      },
    ],
  },
  {
    key: 'MAT-2026-021',
    name: 'Northwind Litigation',
    description: 'Pleadings, discovery index and settlement drafts.',
    createdAt: '2026-03-11T08:30:00Z',
    members: [
      { username: 'theo', role: 'owner' },
      { username: 'iris', role: 'viewer' },
    ],
    documents: [
      {
        title: 'Complaint Filing',
        tags: ['litigation', 'filing'],
        versions: [
          { uploader: 'theo', note: 'Draft complaint', at: '2026-03-12T09:30:00Z' },
          { uploader: 'theo', note: 'As filed with the court', at: '2026-03-15T16:10:00Z' },
        ],
      },
      {
        title: 'Discovery Index',
        tags: ['litigation', 'discovery'],
        versions: [
          { uploader: 'theo', note: 'Initial index', at: '2026-04-02T10:00:00Z' },
          { uploader: 'theo', note: 'Second production added', at: '2026-04-20T13:25:00Z' },
          { uploader: 'theo', note: 'Third production added', at: '2026-05-06T09:45:00Z' },
        ],
      },
      {
        title: 'Settlement Draft',
        tags: ['litigation', 'draft'],
        versions: [{ uploader: 'theo', note: 'Opening settlement proposal', at: '2026-05-20T15:00:00Z' }],
      },
    ],
  },
  {
    key: 'MAT-2026-033',
    name: 'Project Helios — Vendor Onboarding',
    description: 'Vendor NDAs and onboarding paperwork for the Helios build.',
    createdAt: '2026-05-02T07:45:00Z',
    members: [
      { username: 'iris', role: 'owner' },
      { username: 'mara', role: 'viewer' },
      { username: 'theo', role: 'viewer' },
    ],
    documents: [
      {
        title: 'Vendor NDA',
        tags: ['contract', 'nda'],
        versions: [
          { uploader: 'iris', note: 'Standard template', at: '2026-05-03T09:10:00Z' },
          { uploader: 'iris', note: 'Vendor redlines accepted', at: '2026-05-09T11:30:00Z' },
        ],
      },
      {
        title: 'Onboarding Checklist',
        tags: ['ops', 'checklist'],
        versions: [
          { uploader: 'iris', note: 'Checklist v1', at: '2026-05-03T09:20:00Z' },
          { uploader: 'iris', note: 'Added security review step', at: '2026-05-12T10:00:00Z' },
        ],
      },
    ],
  },
];

const RULE = '─'.repeat(60);

function renderVersion(
  matter: SeedMatter,
  doc: SeedDocument,
  versionNo: number,
  version: SeedVersion,
): string {
  return [
    '0815SOFTWARE · MOD-09 DEMO DOCUMENT',
    RULE,
    `MATTER    ${matter.key} — ${matter.name}`,
    `DOCUMENT  ${doc.title}`,
    `VERSION   ${versionNo}`,
    `UPLOADED  ${version.at.slice(0, 10)} by ${version.uploader}`,
    `TAGS      ${doc.tags.join(', ')}`,
    RULE,
    '',
    version.note,
    '',
    `This is synthetic content for version ${versionNo} of "${doc.title}".`,
    'Each version has distinct bytes so its SHA-256 hash differs from the',
    'others in the chain. Not a real document.',
    '',
  ].join('\n');
}

/**
 * Insert the demo data set and generate its version files. Runs only
 * against an empty database (no users); existing data is never touched.
 * The storage directory is created either way.
 */
export async function seed(db: Database.Database, storageDir: string): Promise<void> {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
  if (count > 0) {
    console.log(`[seed] ${count} users already present, skipping`);
    return;
  }

  const insertUser = db.prepare(
    'INSERT INTO users (username, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const insertMatter = db.prepare(
    'INSERT INTO matters (key, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const insertMember = db.prepare(
    'INSERT INTO matter_members (matter_id, user_id, role, created_at) VALUES (?, ?, ?, ?)',
  );
  const insertDocument = db.prepare(
    'INSERT INTO documents (matter_id, title, created_by, created_at) VALUES (?, ?, ?, ?)',
  );
  const insertVersion = db.prepare(
    `INSERT INTO document_versions
       (document_id, version_no, size_bytes, sha256, content_type, filename, storage_path, uploaded_by, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertTag = db.prepare('INSERT INTO document_tags (document_id, tag) VALUES (?, ?)');

  let versionCount = 0;

  // Password hashing is async now (it runs off the event loop — see
  // server/auth.ts) and a better-sqlite3 transaction is synchronous, so the
  // hashes are computed before the transaction opens.
  const passwordHashes = new Map<string, string>(
    await Promise.all(
      users.map(async (u): Promise<[string, string]> => [u.username, await hashPassword(u.password)]),
    ),
  );

  db.transaction(() => {
    const userIds = new Map<string, number>();
    for (const user of users) {
      const id = insertUser.run(
        user.username,
        user.name,
        user.role,
        passwordHashes.get(user.username),
        matters[0]!.createdAt,
      ).lastInsertRowid as number;
      userIds.set(user.username, id);
    }

    for (const matter of matters) {
      const ownerId = userIds.get(matter.members.find((m) => m.role === 'owner')!.username)!;
      const matterId = insertMatter.run(
        matter.key,
        matter.name,
        matter.description,
        ownerId,
        matter.createdAt,
      ).lastInsertRowid as number;

      for (const member of matter.members) {
        insertMember.run(matterId, userIds.get(member.username)!, member.role, matter.createdAt);
      }

      for (const doc of matter.documents) {
        const firstUploader = userIds.get(doc.versions[0]!.uploader)!;
        const documentId = insertDocument.run(
          matterId,
          doc.title,
          firstUploader,
          doc.versions[0]!.at,
        ).lastInsertRowid as number;

        doc.versions.forEach((version, index) => {
          const versionNo = index + 1;
          const content = renderVersion(matter, doc, versionNo, version);
          const bytes = Buffer.from(content, 'utf8');
          const stored = writeBlob(storageDir, bytes);
          const filename = `${slug(doc.title)}-v${versionNo}.txt`;
          insertVersion.run(
            documentId,
            versionNo,
            stored.size,
            stored.sha256,
            'text/plain; charset=utf-8',
            filename,
            stored.storagePath,
            userIds.get(version.uploader)!,
            version.at,
          );
          versionCount += 1;
        });

        for (const tag of doc.tags) insertTag.run(documentId, tag);
      }
    }
  })();

  console.log(
    `[seed] inserted ${users.length} users, ${matters.length} matters, ` +
      `${matters.reduce((n, m) => n + m.documents.length, 0)} documents, ` +
      `${versionCount} versions (blobs in ${storageDir})`,
  );
}

function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// CLI entry: npm run seed
const { pathToFileURL } = await import('node:url');
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { openDb } = await import('./db.js');
  const { configFromEnv } = await import('./config.js');
  const config = configFromEnv();
  const db = openDb(config.databasePath);
  await seed(db, config.storageDir);
  db.close();
  console.log(`[seed] done — database at ${config.databasePath}`);
}
