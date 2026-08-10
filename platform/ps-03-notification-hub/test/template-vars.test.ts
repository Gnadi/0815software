/**
 * Template interpolation promises that a `{{var}}` with no supplied value is a
 * 422. Regression cover for the membership test reaching Object.prototype:
 * `{{constructor}}`, `{{toString}}` and friends counted as supplied and
 * rendered a native function's source into the outgoing message.
 */
import { describe, expect, it } from 'vitest';
import { renderTemplate } from '../server/templates.js';
import { DomainError } from '../server/errors.js';

const email = (subject: string | null, body: string) =>
  ({ subject, body, channel_type: 'email' }) as const;

describe('template variables', () => {
  it('treats an inherited property as missing, not as supplied', () => {
    for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      let thrown: unknown;
      try {
        renderTemplate(email(null, `Hello {{${name}}}`), { name: 'Ada' });
      } catch (err) {
        thrown = err;
      }
      expect(thrown, `{{${name}}} should be reported missing`).toBeInstanceOf(DomainError);
      expect((thrown as DomainError).status).toBe(422);
      expect((thrown as DomainError).details[0]?.field).toBe(`variables.${name}`);
    }
  });

  it('never leaks internals into a rendered body', () => {
    const rendered = renderTemplate(email(null, 'Hi {{constructor}}'), { constructor: 'Ada' });
    expect(rendered.body).toBe('Hi Ada');
    expect(rendered.body).not.toContain('native code');
  });

  it('still renders and escapes ordinary variables', () => {
    const rendered = renderTemplate(email('Order {{ref}}', 'Hello {{name}}'), {
      ref: 'A-1',
      name: '<b>Ada</b>',
    });
    expect(rendered.subject).toBe('Order A-1');
    expect(rendered.body).toBe('Hello &lt;b&gt;Ada&lt;/b&gt;');
  });
});
