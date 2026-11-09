/**
 * Which archives a target keeps: grandfather-father-son retention.
 *
 * Walking from the newest archive back, the first archive seen in each new
 * day is kept until `daily` days are covered, the first in each new ISO week
 * until `weekly` weeks are, and the first in each new month until `monthly`
 * months are. An archive kept by any rule stays. The newest archive is always
 * kept, whatever the numbers say: retention must never be able to delete the
 * one backup that was just made.
 *
 * Buckets are counted over the archives that exist, not over the calendar —
 * a host that was off for two weeks does not lose its last good dailies to
 * the empty days. All dates are UTC, so a target shared by hosts in
 * different time zones agrees on what a "day" is.
 */

/** "2026-11-07" */
function dayKey(d) {
  return d.toISOString().slice(0, 10);
}

/** "2026-W45" — ISO 8601 week (weeks start Monday, week 1 holds the first Thursday). */
function weekKey(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow); // the Thursday of this week decides its year
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** "2026-11" */
function monthKey(d) {
  return d.toISOString().slice(0, 7);
}

/**
 * @param {{ name: string, date: Date }[]} archives
 * @param {{ daily: number, weekly: number, monthly: number }} policy
 * @returns {{ keep: string[], remove: string[] }} names, newest first
 */
export function selectRetained(archives, policy) {
  const sorted = [...archives].sort((a, b) => b.date.getTime() - a.date.getTime());
  const keep = new Set();
  if (sorted.length > 0) keep.add(sorted[0].name);

  for (const [count, keyOf] of [
    [policy.daily, dayKey],
    [policy.weekly, weekKey],
    [policy.monthly, monthKey],
  ]) {
    const seen = new Set();
    for (const archive of sorted) {
      if (seen.size >= count) break;
      const key = keyOf(archive.date);
      if (seen.has(key)) continue;
      seen.add(key);
      keep.add(archive.name);
    }
  }

  return {
    keep: sorted.filter((a) => keep.has(a.name)).map((a) => a.name),
    remove: sorted.filter((a) => !keep.has(a.name)).map((a) => a.name),
  };
}

export const _test = { dayKey, weekKey, monthKey };
