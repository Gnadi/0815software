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
 * And one OPTIONAL fourth layer, off unless SOURCE_VIEWS_ONLY is set:
 *   5. Published surface  — every table/view the query reads must be one of
 *                           the source's `report_*` views (the reporting
 *                           contract, docs/REPORTING-CONTRACT.md).
 *
 * Layer 5 is a scope restriction, not a safety mechanism: the read-only
 * handle is still what makes a write impossible. It exists so an operator can
 * point this module at a module that publishes a contract and hold it to that
 * contract — it does NOT replace anything above it.
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

/**
 * The prefix that marks a published reporting view. A module that wants to be
 * reported on publishes `report_*` views in its own database; those views are
 * its contract and its tables stay private. See docs/REPORTING-CONTRACT.md.
 */
export const REPORT_VIEW_PREFIX = 'report_';

export interface QueryCheck {
  ok: boolean;
  /** Present when ok === false: a human-readable reason. */
  reason?: string;
}

export interface PolicyOptions {
  /**
   * Restrict the query to the source's published `report_*` views. Off by
   * default: pointed at an arbitrary customer database there is no contract to
   * enforce, and the whole schema is the point.
   */
  viewsOnly?: boolean;
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

// ── Published-surface scan (SOURCE_VIEWS_ONLY) ───────────────────────
//
// The keyword denylist above works on text with quoted identifiers blanked
// out, which is right for keywords and wrong here: `FROM "customers"` names a
// table and we have to see it. So the surface scan tokenises separately,
// keeping quoted identifiers as identifiers.

type Token = { kind: 'id' | 'punct' | 'other'; value: string };

/** Word characters SQLite accepts in an unquoted identifier. */
const ID_START = /[A-Za-z_]/;
const ID_PART = /[A-Za-z0-9_$]/;

/**
 * Tokenise for the surface scan: comments and string literals vanish, quoted
 * identifiers (`"x"`, `` `x` ``, `[x]`) become plain identifier tokens, and
 * punctuation that matters to the grammar ( `(`, `)`, `,`, `.` ) is kept.
 */
function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === "'") {
      // String literal: a value, never an object name.
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
      tokens.push({ kind: 'other', value: "''" });
      continue;
    }
    if (ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      i++;
      let value = '';
      while (i < n && sql[i] !== close) value += sql[i++];
      i++;
      // A quoted name with anything but word characters in it cannot be a
      // published view, and must not be silently ignored either — keep it as
      // an identifier token so the prefix check sees (and refuses) it.
      tokens.push({ kind: 'id', value });
      continue;
    }
    if (ID_START.test(ch)) {
      let value = '';
      while (i < n && ID_PART.test(sql[i]!)) value += sql[i++];
      tokens.push({ kind: 'id', value });
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      // Kept as a token (rather than skipped) so `FROM 42` reads as "an
      // operand I cannot classify" instead of silently looking past it.
      while (i < n && /[0-9.eE+\-xXaAbBcCdDfF]/.test(sql[i]!)) i++;
      tokens.push({ kind: 'other', value: '0' });
      continue;
    }
    if (ch === '(' || ch === ')' || ch === ',' || ch === '.') {
      tokens.push({ kind: 'punct', value: ch });
      i++;
      continue;
    }
    i++;
  }
  return tokens;
}

/**
 * Keywords that can appear where a table operand would and are never one.
 * They make the scanner refuse rather than record, which is what keeps
 * `FROM report_invoices JOIN customers` from reading as a single operand.
 */
const NEVER_AN_OPERAND = new Set([
  'AND', 'AS', 'BY', 'CROSS', 'ELSE', 'END', 'EXCEPT', 'FROM', 'FULL', 'GROUP', 'HAVING',
  'INDEXED', 'INNER', 'INTERSECT', 'JOIN', 'LEFT', 'LIMIT', 'NATURAL', 'NOT', 'OFFSET', 'ON',
  'OR', 'ORDER', 'OUTER', 'RETURNING', 'RIGHT', 'SELECT', 'SET', 'THEN', 'UNION', 'USING',
  'VALUES', 'WHEN', 'WHERE', 'WINDOW', 'WITH',
]);

/**
 * Keywords that END a FROM clause. After one of these, a comma at the same
 * paren depth belongs to some other list (an ORDER BY, a LIMIT, a WINDOW
 * definition) and must not be read as another table.
 *
 * `ON` and `USING` are deliberately NOT here: `FROM a JOIN b ON x, c` is a
 * legal comma-join whose third table comes after the join constraint, and
 * missing `c` would be exactly the hole this scan exists to close.
 */
const ENDS_FROM_CLAUSE = new Set([
  'EXCEPT', 'GROUP', 'HAVING', 'INTERSECT', 'LIMIT', 'OFFSET', 'ORDER', 'RETURNING', 'SELECT',
  'SET', 'UNION', 'VALUES', 'WHERE', 'WINDOW', 'WITH',
]);

export interface SurfaceScan {
  /** Lower-cased names of every table/view the statement reads. */
  refs: string[];
  /** True when something in a FROM clause could not be classified. */
  unparsed: boolean;
}

/**
 * Every object name the statement reads.
 *
 * One pass over the tokens, tracking per paren depth whether we are inside a
 * FROM clause. An operand is read after FROM, after JOIN, and after every
 * comma that is still inside the FROM clause at that depth — so
 * `FROM a JOIN b ON 1=1, c` yields all three, and a comma in an ORDER BY or
 * inside a function call yields none.
 *
 * That makes the three obvious ways round it fail by construction:
 *  - an ALIAS renames the operand but does not replace it, and it is the
 *    operand that is recorded (`FROM customers AS report_c` → `customers`);
 *  - a SUBQUERY has its own FROM, which this same walk reaches at its own
 *    depth;
 *  - a CTE is just a subquery with a name, so its body is scanned too — which
 *    is why calling one `report_anything` buys nothing.
 *
 * When an operand cannot be classified the scan says so instead of guessing,
 * and the caller refuses the query. Unknown shape → no.
 */
export function scanSourceSurface(sql: string): SurfaceScan {
  const tokens = tokenize(sql);
  const refs: string[] = [];
  let unparsed = false;

  /** Record the single table operand starting at `start`, if there is one. */
  const readOperand = (start: number): void => {
    const tok = tokens[start];
    if (!tok) {
      unparsed = true;
      return;
    }
    // A subquery or a parenthesised join: nothing to record here, its own
    // FROM/JOIN tokens are visited by the walk below.
    if (tok.kind === 'punct' && tok.value === '(') return;
    if (tok.kind !== 'id' || NEVER_AN_OPERAND.has(tok.value.toUpperCase())) {
      unparsed = true;
      return;
    }
    // schema-qualified: `main.report_invoices` → the object is the last part.
    const qualified = tokens[start + 1]?.value === '.' && tokens[start + 2]?.kind === 'id';
    refs.push((qualified ? tokens[start + 2]!.value : tok.value).toLowerCase());
  };

  // inFrom[depth] — are we inside a FROM clause at this paren depth? Indexed
  // by depth (not a single flag) so a subquery's FROM cannot end its parent's.
  const inFrom: boolean[] = [true];
  inFrom[0] = false;
  let depth = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (tok.kind === 'punct') {
      if (tok.value === '(') {
        depth += 1;
        inFrom[depth] = false;
      } else if (tok.value === ')') {
        inFrom[depth] = false;
        depth = Math.max(0, depth - 1);
      } else if (tok.value === ',' && inFrom[depth]) {
        readOperand(i + 1);
      }
      continue;
    }
    if (tok.kind !== 'id') continue;
    const upper = tok.value.toUpperCase();
    if (upper === 'FROM' || upper === 'JOIN') {
      inFrom[depth] = true;
      readOperand(i + 1);
    } else if (inFrom[depth] && ENDS_FROM_CLAUSE.has(upper)) {
      inFrom[depth] = false;
    }
  }

  return { refs: [...new Set(refs)], unparsed };
}

/**
 * Names bound by a WITH clause. A CTE is not an object in the source database,
 * so referring to one is allowed — its body is scanned like any other FROM,
 * which is why naming a CTE `report_anything` buys an author nothing.
 */
export function cteNames(sql: string): Set<string> {
  const names = new Set<string>();
  const pattern =
    /(?:\bWITH\b(?:\s+RECURSIVE\b)?|,)\s*(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_$]*))\s*(?:\([^()]*\)\s*)?\bAS\b\s*(?:(?:NOT\s+)?MATERIALIZED\s*)?\(/gi;
  for (const match of sql.matchAll(pattern)) {
    const name = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (name) names.add(name.toLowerCase());
  }
  return names;
}

/**
 * Validate a report's SQL against the policy. Pure and synchronous — the
 * read-only connection is the runtime backstop, this is the fast, early,
 * explanatory gate that turns a bad query into a clean 422.
 */
export function checkReportSql(sql: unknown, options: PolicyOptions = {}): QueryCheck {
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

  // Optional layer 5: the published reporting surface only.
  if (options.viewsOnly) {
    const { refs, unparsed } = scanSourceSurface(trimmed);
    if (unparsed) {
      return {
        ok: false,
        reason:
          'Only the published report_* views are readable (SOURCE_VIEWS_ONLY is on), and this ' +
          'query has a FROM/JOIN this module cannot read well enough to check. Select from a ' +
          'report_* view directly.',
      };
    }
    const ctes = cteNames(trimmed);
    const offenders = refs.filter((ref) => !ref.startsWith(REPORT_VIEW_PREFIX) && !ctes.has(ref));
    if (offenders.length > 0) {
      return {
        ok: false,
        reason:
          `Only the published report_* views are readable (SOURCE_VIEWS_ONLY is on). ` +
          `This query reads ${offenders.map((o) => `"${o}"`).join(', ')}, which ${
            offenders.length === 1 ? 'is not one of them' : 'are not among them'
          }. ` +
          `An alias or a CTE does not change that — what matters is the table the query reads.`,
      };
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
