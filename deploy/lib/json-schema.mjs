/**
 * A deliberately minimal JSON Schema (draft 2020-12) validator.
 *
 * The repository keeps a lean dependency surface on purpose, and the only
 * schemas we validate are our own: modules/registry.schema.json and the
 * generated manifest. So instead of pulling in a full validator we implement
 * exactly the keywords those schemas use:
 *
 *   type, const, enum, required, properties, additionalProperties,
 *   patternProperties, items, minItems, uniqueItems, minLength, pattern,
 *   minimum, maximum, $ref (local "#/$defs/..." pointers only)
 *
 * Anything else in a schema is ignored rather than silently "passed" — the
 * test suite asserts the keyword coverage below stays sufficient, so a schema
 * that grows a keyword this validator does not understand fails loudly.
 */

export const SUPPORTED_KEYWORDS = new Set([
  '$schema',
  '$id',
  '$ref',
  '$defs',
  'title',
  'description',
  'type',
  'const',
  'enum',
  'required',
  'properties',
  'additionalProperties',
  'patternProperties',
  'items',
  'minItems',
  'uniqueItems',
  'minLength',
  'pattern',
  'minimum',
  'maximum',
]);

/** Every keyword used anywhere in `schema`, for a coverage assertion. */
export function keywordsUsed(schema, out = new Set()) {
  if (Array.isArray(schema)) {
    for (const item of schema) keywordsUsed(item, out);
    return out;
  }
  if (schema === null || typeof schema !== 'object') return out;
  for (const [key, value] of Object.entries(schema)) {
    out.add(key);
    // Below these keywords the keys are names, not keywords.
    if (key === 'properties' || key === 'patternProperties' || key === '$defs') {
      for (const sub of Object.values(value)) keywordsUsed(sub, out);
    } else if (key === 'required' || key === 'enum' || key === 'const') {
      /* values, not schemas */
    } else {
      keywordsUsed(value, out);
    }
  }
  return out;
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  if (typeof value === 'number') return 'number';
  return typeof value; // 'string' | 'boolean' | 'object'
}

function typeMatches(expected, actual) {
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  if (expected === 'object') return actual === 'object';
  return expected === actual;
}

function resolveRef(ref, root) {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref "${ref}" — only local pointers`);
  let node = root;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    node = node?.[key];
    if (node === undefined) throw new Error(`$ref "${ref}" does not resolve`);
  }
  return node;
}

function check(schema, value, path, root, errors) {
  if (schema === true || schema === undefined) return;
  if (schema === false) {
    errors.push(`${path}: schema forbids any value`);
    return;
  }
  if (schema.$ref) {
    check(resolveRef(schema.$ref, root), value, path, root, errors);
    return;
  }

  const actual = typeOf(value);
  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expected.some((t) => typeMatches(t, actual))) {
      errors.push(`${path}: expected type ${expected.join('|')}, got ${actual}`);
      return; // further keywords would only produce noise
    }
  }

  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }
  if (schema.enum !== undefined && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }

  if (actual === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
      errors.push(`${path}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
    }
  }

  if (actual === 'number' || actual === 'integer') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum ${schema.maximum}`);
  }

  if (actual === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: fewer than minItems ${schema.minItems}`);
    }
    if (schema.uniqueItems === true) {
      const seen = new Set(value.map((v) => JSON.stringify(v)));
      if (seen.size !== value.length) errors.push(`${path}: items are not unique`);
    }
    if (schema.items !== undefined) {
      value.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, root, errors));
    }
  }

  if (actual === 'object') {
    for (const name of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, name)) errors.push(`${path}: missing required "${name}"`);
    }
    const patterns = Object.entries(schema.patternProperties ?? {});
    for (const [key, sub] of Object.entries(value)) {
      const propSchema = schema.properties?.[key];
      let matched = propSchema !== undefined;
      if (propSchema !== undefined) check(propSchema, sub, `${path}.${key}`, root, errors);
      for (const [pattern, patternSchema] of patterns) {
        if (new RegExp(pattern, 'u').test(key)) {
          matched = true;
          check(patternSchema, sub, `${path}.${key}`, root, errors);
        }
      }
      if (!matched && schema.additionalProperties === false) {
        errors.push(`${path}: unexpected property "${key}"`);
      } else if (!matched && typeof schema.additionalProperties === 'object') {
        check(schema.additionalProperties, sub, `${path}.${key}`, root, errors);
      }
    }
  }
}

/** Validate `value` against `schema`. Returns a list of human-readable errors. */
export function validate(schema, value) {
  const errors = [];
  check(schema, value, '$', schema, errors);
  return errors;
}
