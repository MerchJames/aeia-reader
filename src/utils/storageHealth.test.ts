/**
 * Tests for the storage-durability report.
 *
 * The interesting cases here are all the ones where the browser declines to
 * answer properly, because that is what browsers actually do: a private window
 * reports a zero quota, an old webview has no Storage API at all, and an
 * estimate can come back with half its fields missing. Every one of those must
 * produce an honest "unknown" rather than a confident wrong number — a false
 * "your disk is full" banner is how a warning system gets ignored, and an
 * ignored warning is the same as no warning on the day it is real.
 *
 * Run: npx tsx src/utils/storageHealth.test.ts
 */

import {
  FULL_RATIO, TIGHT_RATIO, describeStorage, formatBytes, pressureOf, shouldWarn,
  type StorageReport,
} from './storageHealth';

let passed = 0;
let failed = 0;

const eq = (got: unknown, want: unknown, what: string) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) { passed++; return; }
  failed++;
  console.error(`✗ ${what}\n    got  ${a}\n    want ${b}`);
};
const ok = (cond: boolean, what: string) => eq(!!cond, true, what);

const GB = 1024 ** 3;

const report = (over: Partial<StorageReport> = {}): StorageReport => ({
  durability: 'persisted', usage: 1 * GB, quota: 10 * GB, pressure: 'fine', ...over,
});

/* ------------------------------------------------------------------ */
/* Pressure                                                            */
/* ------------------------------------------------------------------ */

{
  eq(pressureOf(0, 100), 'fine', 'an empty origin is fine');
  eq(pressureOf(50, 100), 'fine', 'half full is fine');
  eq(pressureOf(TIGHT_RATIO * 100, 100), 'tight', 'the tight threshold is inclusive');
  eq(pressureOf(90, 100), 'tight', 'ninety percent is tight');
  eq(pressureOf(FULL_RATIO * 100, 100), 'full', 'the full threshold is inclusive');
  eq(pressureOf(100, 100), 'full', 'completely full is full');
  eq(pressureOf(120, 100), 'full', 'and over quota is still just full');
}

{
  /**
   * The one that would put a permanent false alarm on screen.
   *
   * Private windows and some webviews report `quota: 0`. Dividing by it gives
   * Infinity, which reads as "your storage is full" to a reader who has no
   * problem at all — and after they dismiss that once, they will dismiss the
   * real one too.
   */
  eq(pressureOf(0, 0), 'unknown', 'a zero quota is a browser declining to say, not a full disk');
  eq(pressureOf(500, 0), 'unknown', 'even with usage reported');
  eq(pressureOf(10, -5), 'unknown', 'a negative quota is nonsense, not an emergency');
}

{
  eq(pressureOf(null, 100), 'unknown', 'no usage, no verdict');
  eq(pressureOf(100, null), 'unknown', 'no quota, no verdict');
  eq(pressureOf(null, null), 'unknown', 'neither, no verdict');
  eq(pressureOf(NaN, 100), 'unknown', 'NaN is not a measurement');
  eq(pressureOf(10, Infinity), 'unknown', 'nor is Infinity');
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

{
  eq(formatBytes(0), '0 B', 'zero bytes');
  eq(formatBytes(512), '512 B', 'bytes stay bytes');
  eq(formatBytes(1024), '1.0 KB', 'a kilobyte');
  eq(formatBytes(1536), '1.5 KB', 'one decimal below ten');
  eq(formatBytes(1024 * 15), '15 KB', 'and none above it');
  eq(formatBytes(1024 ** 2 * 3.4), '3.4 MB', 'megabytes');
  eq(formatBytes(GB * 1.42), '1.4 GB', 'gigabytes are rounded to one decimal, not two');
  eq(formatBytes(1024 ** 4 * 2), '2.0 TB', 'and it does not run out of units');
  eq(formatBytes(1024 ** 5), '1024 TB', 'beyond the last unit it keeps counting in it');
}

{
  /**
   * Unknown must not render as zero.
   *
   * "0 B" next to a library of four hundred stories reads as "your library is
   * empty", which is the single most alarming thing this app could say to
   * someone whose data is in fact fine.
   */
  eq(formatBytes(null), '—', 'an unknown size is a dash');
  eq(formatBytes(undefined), '—', 'and so is a missing one');
  eq(formatBytes(NaN), '—', 'and NaN');
  eq(formatBytes(-1), '—', 'a negative size is not a size');
}

/* ------------------------------------------------------------------ */
/* When to speak up                                                    */
/* ------------------------------------------------------------------ */

{
  ok(!shouldWarn(report()), 'a persisted origin with room says nothing');
  ok(shouldWarn(report({ durability: 'best-effort' })),
    'an origin the browser has not promised to keep IS worth warning about');
  ok(shouldWarn(report({ pressure: 'tight' })), 'running low is worth warning about');
  ok(shouldWarn(report({ pressure: 'full' })), 'and full certainly is');
  ok(!shouldWarn(report({ pressure: 'unknown' })),
    'but an unmeasurable origin is not a problem — warning on it would cry wolf in every private window');
  ok(!shouldWarn(report({ durability: 'unsupported', pressure: 'unknown' })),
    'nor is a browser that simply has no Storage API');
}

/* ------------------------------------------------------------------ */
/* What it says                                                        */
/* ------------------------------------------------------------------ */

{
  const persisted = describeStorage(report());
  ok(persisted.includes('1.0 GB'), 'the description states the usage');
  ok(persisted.includes('10 GB'), 'and the quota');
  ok(/only you can clear it/i.test(persisted), 'a persisted library says it is safe from eviction');

  const evictable = describeStorage(report({ durability: 'best-effort' }));
  ok(/NOT promised/.test(evictable), 'an evictable one says so plainly');
  ok(/cleared/.test(evictable), 'and says what could happen');

  ok(/backup/i.test(describeStorage(report({ durability: 'unsupported' }))),
    'a browser that will not say gets told to keep a backup');
}

{
  /**
   * A missing measurement must not produce a sentence with a hole in it.
   *
   * Note what is NOT asserted here: the presence of an em dash. The persisted
   * wording contains one as ordinary punctuation, so testing for "no —" fails
   * on correct output. What matters is the placeholder never appearing where a
   * number should be, and the sentence never starting with the full stop that
   * was meant to follow the number.
   */
  const noNumbers = describeStorage(report({ usage: null, quota: null }));
  ok(!/Using\s*—/.test(noNumbers), 'an unmeasured origin never renders "Using —"');
  ok(!/^[.\s]/.test(noNumbers), 'and never opens with the full stop that followed the missing number');
  ok(!noNumbers.includes('  '), 'and leaves no double space where the numbers were');
  ok(noNumbers.trim().length > 20, 'it still says something useful');

  const halfMeasured = describeStorage(report({ quota: null }));
  ok(halfMeasured.startsWith('Using 1.0 GB.'),
    'a known usage with an unknown quota states the usage and stops there');

  const zeroQuota = describeStorage(report({ quota: 0 }));
  ok(!zeroQuota.includes('of 0 B'), 'a zero quota is omitted rather than stated as a real limit');
  ok(zeroQuota.startsWith('Using 1.0 GB.'), 'and the usage still gets its own clean sentence');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
