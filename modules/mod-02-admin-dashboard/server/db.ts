import Database from 'better-sqlite3';
import { resources, type FieldDef } from '../shared/resources.js';

const IDENT = /^[a-z_][a-z0-9_]*$/;

function sqlType(field: FieldDef): string {
  switch (field.type) {
    case 'number':
      return 'REAL';
    case 'boolean':
      return 'INTEGER';
    default:
      return 'TEXT';
  }
}

/**
 * Open (or create) the database and make sure one table per configured
 * resource exists. Table and column names come exclusively from the
 * resource config and are validated against a strict identifier pattern,
 * so interpolating them into DDL/DML is safe.
 */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  for (const resource of resources) {
    if (!IDENT.test(resource.name)) {
      throw new Error(`Invalid resource name in config: ${resource.name}`);
    }
    const columns = resource.fields.map((f) => {
      if (!IDENT.test(f.name) || f.name === 'id') {
        throw new Error(`Invalid field name in config: ${resource.name}.${f.name}`);
      }
      return `"${f.name}" ${sqlType(f)}`;
    });
    db.exec(
      `CREATE TABLE IF NOT EXISTS "${resource.name}" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ${columns.join(',\n        ')}
      )`,
    );
  }
  return db;
}
