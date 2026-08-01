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
 * And one OPTIONAL fifth layer, off unless SOURCE_VIEWS_ONLY is set:
 *   5. Published surface  — every object the query reads must be one of the
 *                           source's published `report_*` VIEWS (the
 *                           reporting contract, docs/REPORTING-CONTRACT.md).
 *
 * Layer 5 is a scope restriction, not a safety mechanism: the read-only
 * handle is still what makes a write impossible. It exists so an operator can
 * point this module at a module that publishes a contract and hold it to that
 * contract — it does NOT replace anything above it.
 *
 * The allowed set is passed IN (`PolicyOptions.publishedObjects`), derived
 * from the source database's own catalog by server/source-db.ts. The name
 * prefix is a naming convention, NOT the boundary: a private TABLE called
 * `report_secrets` is not in the catalog-derived set and is refused like any
 * other private table. This module stays pure and synchronous — it holds no
 * database handle — because validateReport() calls it at save time.
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
 * The naming convention for a published reporting view. A module that wants to
 * be reported on publishes `report_*` VIEWS in its own database; those views
 * are its contract and its tables stay private. See docs/REPORTING-CONTRACT.md.
 *
 * This is the convention a module follows when publishing. It is NOT what
 * authorises an object at query time — that is the catalog-derived set in
 * `PolicyOptions.publishedObjects`, which contains views only.
 */
export const REPORT_VIEW_PREFIX = 'report_';

export interface QueryCheck {
  ok: boolean;
  /** Present when ok === false: a human-readable reason. */
  reason?: string;
}

export interface PolicyOptions {
  /**
   * Restrict the query to the source's published views. Off by default:
   * pointed at an arbitrary customer database there is no contract to
   * enforce, and the whole schema is the point.
   */
  viewsOnly?: boolean;
  /**
   * The objects a restricted query may read, lower-cased. Built from the
   * source database's catalog (server/source-db.ts `publishedViews()`), so it
   * contains real `report_*` VIEWS and nothing else.
   *
   * Required whenever `viewsOnly` is set. Omitting it FAILS CLOSED — an empty
   * allowed set refuses every query that reads anything — because a caller
   * that forgot to supply it must not silently get an unrestricted check.
   */
  publishedObjects?: ReadonlySet<string>;
}

const NOTHING_PUBLISHED: ReadonlySet<string> = new Set<string>();

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

/** Index just past the `)` matching the `(` at `start`. */
function skipParens(tokens: Token[], start: number): number {
  let depth = 0;
  let i = start;
  for (; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (tok.kind !== 'punct') continue;
    if (tok.value === '(') depth += 1;
    else if (tok.value === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return i;
}

/**
 * What a `(` after FROM/JOIN opens. SQLite's grammar allows THREE things
 * there, and only the first is a subquery:
 *   `( SELECT … )` / `( WITH … )` / `( VALUES … )` → a subquery
 *   `( customers, report_invoices )`               → a table list
 *   `( customers JOIN report_invoices ON … )`      → a join clause
 * Reading the last two as "a subquery, the inner walk will handle it" is how
 * `SELECT * FROM (customers)` used to reach a private table.
 */
const SUBQUERY_OPENERS = new Set(['SELECT', 'WITH', 'VALUES']);

export interface SurfaceScan {
  /** Lower-cased names of every table/view the statement reads. */
  refs: string[];
  /** True when something in a FROM clause could not be classified. */
  unparsed: boolean;
  /** Lower-cased names bound by a leading WITH clause. */
  ctes: Set<string>;
}

/**
 * Names bound by a leading `WITH` clause, read off the TOKEN STREAM.
 *
 * Deriving these from raw SQL with a regex is what made
 * `SELECT 'WITH customers AS (' AS bait FROM customers` pass: the text inside
 * a string literal (or a comment) was read as a CTE declaration and
 * `customers` landed in the allowlist. The tokenizer has already thrown
 * literals and comments away, so nothing inside them can be seen here.
 *
 * Only a LEADING `WITH` is a CTE clause. The old regex also matched on any
 * comma, so `… WINDOW x AS (), customers AS ()` declared a "CTE" named
 * `customers` in the middle of a statement. A `WITH` anywhere else is not a
 * declaration and binds nothing.
 *
 * Handles: one CTE or a comma-separated list, `RECURSIVE`, an optional column
 * list `name(a, b) AS (…)`, `MATERIALIZED` / `NOT MATERIALIZED`, quoted
 * identifiers, and nested parentheses in the body. A name is recorded only
 * once its `AS ( … )` body has actually been seen, so a half-formed clause
 * binds nothing. Anything unexpected stops the walk — a name that is not
 * recorded is simply not excused, which is the safe direction.
 */
function cteNamesFromTokens(tokens: Token[]): Set<string> {
  const names = new Set<string>();
  if (!(tokens[0]?.kind === 'id' && tokens[0]!.value.toUpperCase() === 'WITH')) return names;

  let i = 1;
  if (tokens[i]?.kind === 'id' && tokens[i]!.value.toUpperCase() === 'RECURSIVE') i += 1;

  for (;;) {
    const nameTok = tokens[i];
    if (!nameTok || nameTok.kind !== 'id') return names;
    const candidate = nameTok.value.toLowerCase();
    i += 1;

    // Optional column list: name(a, b) AS (…)
    if (tokens[i]?.kind === 'punct' && tokens[i]!.value === '(') i = skipParens(tokens, i);

    if (!(tokens[i]?.kind === 'id' && tokens[i]!.value.toUpperCase() === 'AS')) return names;
    i += 1;
    if (tokens[i]?.kind === 'id' && tokens[i]!.value.toUpperCase() === 'NOT') i += 1;
    if (tokens[i]?.kind === 'id' && tokens[i]!.value.toUpperCase() === 'MATERIALIZED') i += 1;

    // The body. No body, no binding.
    if (!(tokens[i]?.kind === 'punct' && tokens[i]!.value === '(')) return names;
    names.add(candidate);
    i = skipParens(tokens, i);

    if (tokens[i]?.kind === 'punct' && tokens[i]!.value === ',') {
      i += 1;
      continue;
    }
    // The clause ends here; whatever follows is the statement itself.
    return names;
  }
}

/**
 * Names bound by a leading WITH clause. A CTE is not an object in the source
 * database, so referring to one is allowed — its body is scanned like any
 * other FROM, which is why naming a CTE `report_anything` buys nothing and
 * hiding a private table inside one is still refused.
 */
export function cteNames(sql: string): Set<string> {
  return cteNamesFromTokens(tokenize(sql));
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

  /**
   * Token indexes of `(` that open a parenthesised TABLE LIST or JOIN rather
   * than a subquery. The walk below opens a FROM context inside those, so
   * `FROM (customers, report_invoices)` reads both operands.
   */
  const fromListParens = new Set<number>();

  /** Record the single table operand starting at `start`, if there is one. */
  const readOperand = (start: number): void => {
    const tok = tokens[start];
    if (!tok) {
      unparsed = true;
      return;
    }
    if (tok.kind === 'punct' && tok.value === '(') {
      const next = tokens[start + 1];
      if (next?.kind === 'id' && SUBQUERY_OPENERS.has(next.value.toUpperCase())) {
        // A real subquery. Its own FROM/JOIN tokens are visited by the walk.
        return;
      }
      // A parenthesised table list or join clause: the parenthesis is
      // decoration, the operands inside are real. Mark it so the walk opens a
      // FROM context at the inner depth (that is what picks up the commas),
      // and read the first operand here since no FROM/JOIN/comma precedes it.
      fromListParens.add(start);
      readOperand(start + 1);
      return;
    }
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
  const inFrom: boolean[] = [false];
  let depth = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (tok.kind === 'punct') {
      if (tok.value === '(') {
        depth += 1;
        // A parenthesised table list continues the FROM clause inside the
        // parenthesis; anything else (a subquery, a function call) does not.
        inFrom[depth] = fromListParens.has(i);
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

  return { refs: [...new Set(refs)], unparsed, ctes: cteNamesFromTokens(tokens) };
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
    const { refs, unparsed, ctes } = scanSourceSurface(trimmed);
    if (unparsed) {
      return {
        ok: false,
        reason:
          'Only the published report_* views are readable (SOURCE_VIEWS_ONLY is on), and this ' +
          'query has a FROM/JOIN this module cannot read well enough to check. Select from a ' +
          'report_* view directly.',
      };
    }
    // The catalog decides, not the name. `publishedObjects` holds real views;
    // a private table called `report_secrets` is not in it. Absent → empty →
    // everything that reads anything is refused (fail closed).
    const published = options.publishedObjects ?? NOTHING_PUBLISHED;
    const offenders = refs.filter((ref) => !published.has(ref) && !ctes.has(ref));
    if (offenders.length > 0) {
      return {
        ok: false,
        reason:
          `Only the published report_* views are readable (SOURCE_VIEWS_ONLY is on). ` +
          `This query reads ${offenders.map((o) => `"${o}"`).join(', ')}, which ${
            offenders.length === 1 ? 'is not a published view' : 'are not published views'
          }. ` +
          `Neither an alias, a CTE, a parenthesised table list nor a table merely named ` +
          `report_* changes that — the source's catalog decides, and it lists only views.`,
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
