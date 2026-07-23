/**
 * Config-as-code backoff schedule for outbound webhook delivery. Entry
 * k (0-based) is the delay in seconds before retry number k+1. A delivery
 * gets one initial attempt plus BACKOFF_SCHEDULE.length retries
 * (MAX_ATTEMPTS total) before it is dead-lettered. The import-time
 * self-check guarantees the schedule is positive and strictly ascending.
 */
export const BACKOFF_SCHEDULE = [60, 300, 1800, 7200, 21600] as const; // 1m, 5m, 30m, 2h, 6h
export const MAX_ATTEMPTS = BACKOFF_SCHEDULE.length + 1;

/**
 * Milliseconds to wait before the next attempt, given how many attempts
 * have already been made. Returns null when the delivery has exhausted its
 * attempts and should be dead-lettered instead.
 */
export function nextBackoffMs(attemptsMade: number): number | null {
  if (attemptsMade < 1 || attemptsMade > BACKOFF_SCHEDULE.length) return null;
  return BACKOFF_SCHEDULE[attemptsMade - 1]! * 1000;
}

(function selfCheck(): void {
  for (let i = 0; i < BACKOFF_SCHEDULE.length; i++) {
    if (BACKOFF_SCHEDULE[i]! <= 0) throw new Error('retry: backoff delays must be positive');
    if (i > 0 && BACKOFF_SCHEDULE[i]! <= BACKOFF_SCHEDULE[i - 1]!) {
      throw new Error('retry: backoff schedule must be strictly ascending');
    }
  }
})();
