/**
 * Tests for the alert surface.
 *
 * This module exists because two storage failures were silent, so the tests are
 * about the ways a notification surface can be silent *while appearing not to
 * be* — which is worse, because it looks like the reader was told.
 *
 * Three of them carry real weight:
 *
 * 1. A repeating failure collapses instead of stacking. A failing write fires
 *    on every keystroke; without this the one message that matters is buried
 *    under four hundred copies of itself.
 * 2. A `danger` alert never auto-dismisses and is never trimmed away by
 *    routine notices. "Your work is not being saved" that vanishes after six
 *    seconds is worse than nothing.
 * 3. A listener that throws cannot break the caller. These fire from inside
 *    storage writes, and an exception escaping would turn "we could not tell
 *    you" into "and the save also failed".
 *
 * Run: npx tsx src/utils/alerts.test.ts
 */

import {
  ALERT_TTL_MS, MAX_ALERTS, _resetAlertListeners,
  alertLoadFailed, alertSaveFailed, dropAlert, expireAlerts, onAlert,
  pushAlert, raiseAlert, trimAlerts,
  type Alert, type AlertSpec,
} from './alerts';

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

const info = (title: string, key?: string): AlertSpec => ({ tone: 'info', title, key });
const danger = (title: string, key?: string): AlertSpec => ({ tone: 'danger', title, key });

/* ------------------------------------------------------------------ */
/* Adding                                                              */
/* ------------------------------------------------------------------ */

{
  const one = pushAlert([], info('Exported'));
  eq(one.length, 1, 'an alert is added');
  eq(one[0].title, 'Exported', 'with its title');
  eq(one[0].count, 1, 'counted once');
  ok(!one[0].sticky, 'an info alert is dismissible');
  ok(!!one[0].id, 'and gets an id');

  const two = pushAlert(one, info('Imported'));
  eq(two.length, 2, 'a second alert is added');
  eq(one.length, 1, 'and the input list is not mutated');
}

{
  ok(pushAlert([], danger('Save failed'))[0].sticky,
    'a danger alert is sticky whatever the caller says');
  ok(pushAlert([], { tone: 'warn', title: 'x' })[0].sticky === false,
    'a warning is dismissible by default');
  ok(pushAlert([], { tone: 'warn', title: 'x', sticky: true })[0].sticky,
    'but can be made sticky deliberately');
}

/* ------------------------------------------------------------------ */
/* Collapsing repeats — the storage-write case                         */
/* ------------------------------------------------------------------ */

{
  /**
   * The behaviour this module was written for.
   *
   * A quota failure repeats on every save. Four hundred identical rows is not
   * a notification, it is a denial of service against the reader's attention.
   */
  let list: Alert[] = [];
  for (let i = 0; i < 400; i++) list = pushAlert(list, danger('Not saving', 'save-failed'));

  eq(list.length, 1, '400 repeats of one failure collapse to a single alert');
  eq(list[0].count, 400, 'and it counts them, so the scale is still visible');
}

{
  // The row must not re-animate on every repeat, so the id is kept.
  const first = pushAlert([], danger('Not saving', 'k'));
  const again = pushAlert(first, danger('Not saving', 'k'));
  eq(again[0].id, first[0].id, 'a collapsed repeat keeps its id — the row does not redraw');
  ok(again[0].at >= first[0].at, 'but its timestamp moves forward');
}

{
  // Keyless alerts are independent even when identical: they are separate
  // events, and the caller chose not to collapse them.
  const list = pushAlert(pushAlert([], info('Saved')), info('Saved'));
  eq(list.length, 2, 'alerts with no key do not collapse');
}

{
  // Different keys are different problems.
  const list = pushAlert(pushAlert([], danger('A', 'a')), danger('B', 'b'));
  eq(list.length, 2, 'different keys stay separate');
}

{
  // A collapsed repeat takes the NEW wording — a failure that changes its
  // reason mid-run should say the current reason, not the first one.
  const list = pushAlert(
    pushAlert([], { tone: 'warn', title: 'Old', detail: 'first', key: 'k' }),
    { tone: 'danger', title: 'New', detail: 'second', key: 'k' },
  );
  eq(list[0].title, 'New', 'the latest wording wins');
  eq(list[0].detail, 'second', 'including the detail');
  ok(list[0].sticky, 'and an escalation to danger makes it sticky');
}

/* ------------------------------------------------------------------ */
/* The cap, and what it is not allowed to drop                         */
/* ------------------------------------------------------------------ */

{
  let list: Alert[] = [];
  for (let i = 0; i < MAX_ALERTS + 5; i++) list = pushAlert(list, info(`n${i}`));
  eq(list.length, MAX_ALERTS, 'the list is capped');
  eq(list[list.length - 1].title, `n${MAX_ALERTS + 4}`, 'keeping the newest');
}

{
  /**
   * The trim rule that matters.
   *
   * A reader who is losing their work will also be doing ordinary things that
   * raise ordinary notices. Those must not push the warning off the screen.
   */
  let list = pushAlert([], danger('Your work is not being saved', 'save-failed'));
  for (let i = 0; i < 20; i++) list = pushAlert(list, info(`routine ${i}`));

  eq(list.filter(a => a.sticky).length, 1, 'the sticky warning survives 20 routine notices');
  eq(list[0].title, 'Your work is not being saved', 'and stays at the front, where it was raised');
  eq(list.length, MAX_ALERTS, 'while the cap still holds');
}

{
  // Only when there is nothing else to drop does a sticky one go, and then the
  // newest are kept.
  let list: Alert[] = [];
  for (let i = 0; i < MAX_ALERTS + 2; i++) list = pushAlert(list, danger(`d${i}`));
  eq(list.length, MAX_ALERTS, 'a flood of sticky alerts is still capped');
  eq(list[list.length - 1].title, `d${MAX_ALERTS + 1}`, 'keeping the most recent');
}

{
  eq(trimAlerts([]), [], 'trimming an empty list is fine');
}

/* ------------------------------------------------------------------ */
/* Expiry                                                              */
/* ------------------------------------------------------------------ */

{
  const now = 1_000_000;
  const list: Alert[] = [
    { id: '1', tone: 'info', title: 'fresh', count: 1, at: now, sticky: false },
    { id: '2', tone: 'info', title: 'stale', count: 1, at: now - ALERT_TTL_MS - 1, sticky: false },
    { id: '3', tone: 'danger', title: 'ancient', count: 1, at: 0, sticky: true },
  ];
  const kept = expireAlerts(list, now);
  eq(kept.map(a => a.id), ['1', '3'],
    'the stale dismissible one goes; the fresh one and the sticky one stay');

  eq(expireAlerts(list, 0).length, 3, 'nothing has expired at time zero');
}

{
  /**
   * The rule stated as a property rather than an example.
   *
   * No passage of time, however long, removes a sticky alert. This is the
   * whole promise of `danger`, and it should not depend on the TTL constant.
   */
  const sticky: Alert = { id: 's', tone: 'danger', title: 'x', count: 1, at: 0, sticky: true };
  const survives = [1e3, 1e6, 1e12, Number.MAX_SAFE_INTEGER]
    .every(t => expireAlerts([sticky], t).length === 1);
  ok(survives, 'a sticky alert never expires, at any time');
}

/* ------------------------------------------------------------------ */
/* Dismissing                                                          */
/* ------------------------------------------------------------------ */

{
  const list = pushAlert(pushAlert([], info('a')), info('b'));
  const after = dropAlert(list, list[0].id);
  eq(after.length, 1, 'an alert can be dismissed');
  eq(after[0].title, 'b', 'the right one goes');
  eq(dropAlert(list, 'nope').length, 2, 'dismissing something absent changes nothing');

  // A sticky alert is dismissible BY THE READER — it just does not go on its
  // own. Refusing to let them close it would be its own kind of rude.
  const d = pushAlert([], danger('save failed'));
  eq(dropAlert(d, d[0].id).length, 0, 'the reader can always dismiss a sticky alert themselves');
}

/* ------------------------------------------------------------------ */
/* The emitter                                                         */
/* ------------------------------------------------------------------ */

{
  _resetAlertListeners();
  const seen: AlertSpec[] = [];
  const off = onAlert(s => seen.push(s));

  raiseAlert(info('hello'));
  eq(seen.length, 1, 'a listener hears an alert');
  eq(seen[0].title, 'hello', 'with its content');

  off();
  raiseAlert(info('after'));
  eq(seen.length, 1, 'and stops hearing once unsubscribed');
}

{
  _resetAlertListeners();
  // No listener at all: startup, before the host has mounted.
  let threw = false;
  try { raiseAlert(danger('nobody is listening')); } catch { threw = true; }
  ok(!threw, 'raising an alert with nothing listening is a no-op, not an error');
}

{
  /**
   * The one that protects the caller.
   *
   * These fire from inside IndexedDB writes. If a broken subscriber could
   * throw through `raiseAlert`, reporting a failed save would itself fail the
   * save that was still working.
   */
  _resetAlertListeners();
  const heard: string[] = [];
  onAlert(() => { throw new Error('a listener blew up'); });
  onAlert(s => heard.push(s.title));

  let threw = false;
  try { raiseAlert(danger('still delivered')); } catch { threw = true; }

  ok(!threw, 'a throwing listener does not propagate to the caller');
  eq(heard, ['still delivered'], 'and the other listeners still hear it');
  _resetAlertListeners();
}

/* ------------------------------------------------------------------ */
/* The named failures                                                  */
/* ------------------------------------------------------------------ */

{
  _resetAlertListeners();
  const seen: AlertSpec[] = [];
  onAlert(s => seen.push(s));

  alertSaveFailed('your notes');
  alertLoadFailed();

  eq(seen.length, 2, 'both storage failures raise');
  ok(seen.every(s => s.tone === 'danger'), 'both are danger — they are about lost work');
  ok(seen.every(s => !!s.key), 'both are keyed, because both repeat');
  ok(seen[0].detail!.includes('your notes'), 'the save failure names what would not save');

  // The load failure has one job beyond reporting: stopping the reader from
  // restoring a backup over a library that is merely unreadable this session.
  ok(seen[1].detail!.toLowerCase().includes('nothing has been deleted'),
    'the load failure says the data is probably still there');
  ok(seen[1].detail!.toLowerCase().includes('reload'),
    'and tells them to reload before importing over it');

  _resetAlertListeners();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
