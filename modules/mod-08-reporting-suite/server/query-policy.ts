/**
 * Query safety policy — THE one place the SELECT-only rules and limits
 * live. A report's SQL is validated against this policy before it is
 * ever prepared, and the read-only connection (server/source-db.ts) is
 * the backstop if anything slips through.
 *
 * Everything is defence in depth, deliberately:
 *   1. Structural check   — one statement, starts with SELECT/WITH.
 *   2. Keyword denylist   — no write/DDL/PRAGMA/ATTACH tokens anywhere.
 *   3. Read-only handle   — better-sqlite3 { readonly: true } rejects any
 *                           statement that would mutate, at SQLite level.
 *   4. Row cap + timeout  — a runaway SELECT can't exhaust memory/CPU.
 *
 * Change a limit here and it changes everywhere; a self-check at import
 * keeps the values sane.
 */

export const QUERY_POLICY = {
  /** Hard maximum rows returned to a caller / written to a CSV export. */
  maxRows: 10_000,
  /** Wall-clock budget for a single query (ms), enforced via a progress
   *  handler on the read-only connection. */
  timeoutMs: 5_000,
} as const;

/**
 * Tokens that must never appear in a report query. Matched as whole
 * words, case-insensitively. This is a denylist ON TOP of the read-only
 * connection, not instead of it — the connection is the real guarantee.
 */
export const FORBIDDEN_KEYWORDS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'REPLACE',
  'DROP',
  'CREATE',
  'ALTER',
  'TRUNCATE',
  'PRAGMA',
  'ATTACH',
  'DETACH',
  'VACUUM',
  'REINDEX',
  'GRANT',
  'REVOKE',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
] as const;

export interface QueryCheck {
  ok: boolean;
  /** Present when ok === false: a human-readable reason. */
  reason?: string;
}

/**
 * Strip out string literals, quoted identifiers and comments so the
 * keyword scan can't be fooled by (or trip over) their contents. Returns
 * the "code" portion of the SQL, uppercased for matching.
 */
function stripLiteralsAndComments(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    // Line comment.
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    // Block comment.
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    // Single-quoted string literal.
    if (ch === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      out += ' ';
      continue;
    }
    // Double-quoted or backtick identifier.
    if (ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      while (i < n && sql[i] !== quote) i++;
      i++;
      out += ' ';
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Return the SQL split into statements on top-level semicolons, ignoring
 * the trailing empty fragment after a single trailing semicolon. Uses
 * the literal/comment-stripped form so semicolons inside strings don't
 * count. We only need the COUNT of real statements, so we count
 * separators on the cleaned text.
 */
function countStatements(cleaned: string): number {
  const parts = cleaned
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parts.length;
}

/**
 * Validate a report's SQL against the policy. Pure and synchronous — the
 * read-only connection is the runtime backstop, this is the fast, early,
 * explanatory gate that turns a bad query into a clean 422.
 */
export function checkReportSql(sql: unknown): QueryCheck {
  if (typeof sql !== 'string') return { ok: false, reason: 'SQL must be a string' };
  const trimmed = sql.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'SQL must not be empty' };
  if (trimmed.length > 20_000) return { ok: false, reason: 'SQL is too long (max 20,000 characters)' };

  const cleaned = stripLiteralsAndComments(trimmed);
  const cleanedUpper = cleaned.toUpperCase();

  // Exactly one statement — no multi-statement smuggling.
  if (countStatements(cleaned) !== 1) {
    return { ok: false, reason: 'Only a single SQL statement is allowed' };
  }

  // Must be a read: first keyword is SELECT or WITH.
  const firstWord = (cleanedUpper.match(/[A-Z]+/) ?? [''])[0];
  if (firstWord !== 'SELECT' && firstWord !== 'WITH') {
    return { ok: false, reason: 'Query must start with SELECT or WITH' };
  }

  // Whole-word denylist scan over the code (literals already removed).
  for (const kw of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${kw}\\b`).test(cleanedUpper)) {
      return { ok: false, reason: `Forbidden keyword: ${kw}` };
    }
  }

  return { ok: true };
}

// ── Config self-check (runs once at import) ──────────────────────────
{
  if (QUERY_POLICY.maxRows < 1 || !Number.isInteger(QUERY_POLICY.maxRows)) {
    throw new Error('query-policy: maxRows must be a positive integer');
  }
  if (QUERY_POLICY.timeoutMs < 1) {
    throw new Error('query-policy: timeoutMs must be positive');
  }
}
