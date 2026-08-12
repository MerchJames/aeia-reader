/**
 * Run: npx tsx src/utils/readingFocus.test.ts
 * Pure geometry for the reading spotlight (no DOM).
 *
 * Everything here is in VIEWPORT pixels. That is the point of the rewrite: the
 * earlier versions expressed the light as percentages of whichever element was
 * being masked, so the band drifted off the words whenever that element's box
 * did something unexpected. A fixed scrim has no such coupling.
 */
import { Box, focusMoved, focusVars } from './readingFocus';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };

/** A reveal edge one 24px line tall, mid-screen. */
const mid: Box = { left: 500, top: 400, width: 8, height: 24 };

const v = focusVars(mid)!;
ok(!!v, 'a normal edge yields vars');
ok(v['--focus-x'] === '504px', `the light centres on the glyph in viewport px (${v['--focus-x']})`);
ok(v['--focus-y'] === '412px', `vertically too (${v['--focus-y']})`);

// No element box is involved, so the same glyph anywhere on screen gives the
// same-sized light — the coupling that caused the drift is simply gone.
const far = focusVars({ ...mid, left: 40, top: 900 })!;
ok(far['--focus-rx'] === v['--focus-rx'] && far['--focus-ry'] === v['--focus-ry'],
  'the light is the same size wherever the glyph is');
ok(far['--focus-x'] === '44px' && far['--focus-y'] === '912px', 'and follows it exactly');

// A horizontal ellipse: reading runs along a line.
const rx = parseInt(v['--focus-rx'], 10);
const ry = parseInt(v['--focus-ry'], 10);
ok(rx > ry * 2, `the light is much wider than tall (${rx} × ${ry})`);
ok(ry > 24 && ry < 24 * 4, `it covers a bit over one line (${ry}px for a 24px line)`);

// Sized in line heights, so it hugs the same amount of text at any font size —
// which matters because autofocus zoom changes the font size.
ok(parseInt(focusVars({ ...mid, height: 12 })!['--focus-rx'], 10) < rx, 'a smaller line, a smaller light');
ok(parseInt(focusVars({ ...mid, height: 48 })!['--focus-rx'], 10) > rx, 'a bigger line, a bigger light');

// Bounds, so a strange line box can neither black out nor reveal the screen.
ok(parseInt(focusVars({ ...mid, height: 5000 })!['--focus-rx'], 10) <= 1100, 'the light is capped');
ok(parseInt(focusVars({ ...mid, height: 1 })!['--focus-ry'], 10) >= 34, 'and floored');

// A rect that has not laid out yet lights nothing rather than flashing dark.
ok(focusVars({ ...mid, height: 0 }) === null, 'a zero-height edge yields no light');

/* ---- repaint gating ---- */

ok(focusMoved(null, v), 'the first measurement always paints');
ok(!focusMoved(v, v), 'an unmoved edge does not repaint');
// A few glyphs along the same line is below the noise floor…
ok(!focusMoved(v, focusVars({ ...mid, left: 505 })!), 'a few pixels along the line does not repaint');
// …but a LINE BREAK moves the reader's eye and must be followed at once.
ok(focusMoved(v, focusVars({ ...mid, left: 120, top: 424 })!), 'a line break repaints');
ok(focusMoved(v, focusVars({ ...mid, top: 408 })!), 'even a part-line vertical move repaints');
// A font-size change (autofocus zoom) resizes the light immediately.
ok(focusMoved(v, focusVars({ ...mid, height: 30 })!), 'a font-size change repaints');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
