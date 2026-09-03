import { defineConfig } from 'vitest/config';

/**
 * Coverage is a GATE here, not a report.
 *
 * PS-01 is the service every other one authenticates through: PS-02…12 all
 * call `POST /api/tokens/verify`, and the thirteen SSO modules delegate their
 * login to it. A defect here is a defect everywhere, and successive reviews
 * kept finding one — so the thresholds below fail the suite rather than
 * printing a number nobody reads.
 *
 * `server/index.ts` is excluded from the DENOMINATOR, not from testing:
 * `test/boot.test.ts` spawns it as a real process and asserts on its stdout,
 * its exit code, the port it opens and the headers it serves. v8 coverage
 * instruments this process only, so a child process reads as 0% however
 * thoroughly it is exercised — and leaving it in would have meant either an
 * honest number that looks worse than the truth, or a fake test that imports
 * the module without booting it. The subprocess cases are the real check; this
 * line just stops them being punished for being real.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['server/**/*.ts', 'shared/**/*.ts'],
      exclude: ['server/index.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
});
