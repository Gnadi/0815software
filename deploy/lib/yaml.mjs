/**
 * A tiny, deterministic YAML writer for generated Compose files.
 *
 * Only the value shapes provision.mjs actually emits are supported: strings,
 * finite numbers, booleans, arrays and plain objects. Every string is written
 * double-quoted and escaped, which is always valid YAML and removes any
 * question of a value being reinterpreted as a number, a boolean or null —
 * Compose interpolation of "${VAR}" works fine inside double quotes.
 *
 * No dependency, no round-tripping, no anchors: the input is a plain object
 * built in one place, and `docker compose config` is the acceptance check.
 */

const BARE_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function quote(str) {
  return JSON.stringify(str); // JSON string escaping is valid YAML double-quoting
}

function scalar(value) {
  if (typeof value === 'string') return quote(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`cannot emit non-finite number: ${value}`);
    return String(value);
  }
  if (value === null) return 'null';
  throw new Error(`unsupported YAML value of type ${typeof value}`);
}

function isContainer(value) {
  return (value !== null && typeof value === 'object') || Array.isArray(value);
}

function emit(value, indent, lines) {
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) throw new Error('cannot emit an empty array — omit the key instead');
    for (const item of value) {
      if (isContainer(item)) {
        const nested = [];
        emit(item, indent + 1, nested);
        // Splice the first nested line onto the dash so the block reads normally.
        lines.push(`${pad}- ${nested[0].trimStart()}`);
        lines.push(...nested.slice(1));
      } else {
        lines.push(`${pad}- ${scalar(item)}`);
      }
    }
    return;
  }
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  if (entries.length === 0) {
    // An intentionally empty mapping (a Compose network or volume definition).
    lines.push(`${pad}{}`);
    return;
  }
  for (const [key, val] of entries) {
    const name = BARE_KEY.test(key) ? key : quote(key);
    if (isContainer(val)) {
      const nested = [];
      emit(val, indent + 1, nested);
      if (nested.length === 1 && nested[0].trim() === '{}') {
        lines.push(`${pad}${name}: {}`);
      } else {
        lines.push(`${pad}${name}:`);
        lines.push(...nested);
      }
    } else {
      lines.push(`${pad}${name}: ${scalar(val)}`);
    }
  }
}

/**
 * Serialize `value` to a YAML document.
 * `header` lines are emitted as leading `# ` comments.
 */
export function toYaml(value, { header = [] } = {}) {
  const lines = header.map((line) => (line ? `# ${line}` : '#'));
  emit(value, 0, lines);
  return `${lines.join('\n')}\n`;
}
