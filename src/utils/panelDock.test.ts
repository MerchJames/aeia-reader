/**
 * Run: npx tsx src/utils/panelDock.test.ts
 *
 * A draggable panel has exactly one way to fail badly, and it is not a wrong
 * pixel: it ends up somewhere the pointer cannot reach, and because the
 * position is persisted, it is still there tomorrow. The reader has lost their
 * assistant and has no idea why — there is nothing to click, and nothing on
 * screen explains where it went.
 *
 * So almost every test here asserts the same thing from a different direction:
 * **whatever you do, the panel can be grabbed again.** The header stays on
 * screen, the panel keeps a foothold at either edge, and geometry saved on a
 * bigger monitor comes back reachable on a smaller one.
 */
import {
  clampDock, defaultDock, dockStyle, dragDock, HANDLE_H, KEEP_VISIBLE, MIN_H, MIN_W,
  presetDock, resizeDock, sanitizeDock, type DockRect, type Viewport,
} from './panelDock';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (a === b) pass++;
  else { fail++; console.error('✗', msg, `\n    got  ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

const laptop: Viewport = { width: 1440, height: 900 };
const phone: Viewport = { width: 390, height: 780 };
const tiny: Viewport = { width: 320, height: 400 };

/** The one property that matters, checked directly. */
const grabbable = (r: DockRect, vp: Viewport, label: string) => {
  ok(r.y >= 0, `${label}: the header is not above the top of the screen`);
  ok(r.y <= vp.height - HANDLE_H, `${label}: the header is not below the bottom of the screen`);
  ok(r.x + r.w >= KEEP_VISIBLE, `${label}: enough of the panel is inside the left edge to grab`);
  ok(r.x <= vp.width - KEEP_VISIBLE, `${label}: and inside the right edge`);
  ok(r.w >= MIN_W && r.h >= MIN_H, `${label}: it is still big enough to be a chat`);
};

/* ------------------------------------------------------------------ */
/* The default                                                         */
/* ------------------------------------------------------------------ */

{
  const d = defaultDock(laptop);
  eq(d.w, 420, 'the default is the size the panel has always been');
  grabbable(d, laptop, 'default');
  ok(d.x + d.w <= laptop.width, 'and it sits fully inside a laptop screen');
  ok(d.y + d.h <= laptop.height, 'vertically too');

  // The same default on a phone must not be 420px wide on a 390px screen.
  const p = defaultDock(phone);
  ok(p.w <= phone.width, 'on a phone it fits the width it actually has');
  grabbable(p, phone, 'default on a phone');

  // A window smaller than the minimum panel: the minimum wins, because a panel
  // below it is not usable, and clamping keeps it reachable anyway.
  const t = defaultDock(tiny);
  eq(t.w, MIN_W, 'in a window narrower than the minimum, the minimum wins');
  grabbable(t, tiny, 'default in a tiny window');
}

/* ------------------------------------------------------------------ */
/* Dragging                                                            */
/* ------------------------------------------------------------------ */

{
  const start = defaultDock(laptop);

  // Dragged hard up and left — the classic way to lose a window.
  const upLeft = dragDock(start, -5000, -5000, laptop);
  grabbable(upLeft, laptop, 'dragged off the top-left');
  eq(upLeft.y, 0, 'the top edge stops at the top of the screen, exactly');

  const downRight = dragDock(start, 5000, 5000, laptop);
  grabbable(downRight, laptop, 'dragged off the bottom-right');
  ok(downRight.x < laptop.width, 'the panel cannot be pushed past the right edge entirely');

  // A normal drag is just a move, with nothing clever done to it.
  const nudged = dragDock(start, 40, -30, laptop);
  eq(nudged.x, start.x + 40, 'an ordinary drag moves by exactly the delta');
  eq(nudged.y, start.y - 30, 'in both axes');
  eq(nudged.w, start.w, 'and changes no size');
  eq(nudged.h, start.h, 'at all');
}

{
  // Hanging off the bottom is allowed — it can be dragged back. Hanging off the
  // TOP is not, because the handle is the header and there would be nothing
  // left to grab.
  const r = clampDock({ x: 100, y: 800, w: 400, h: 600 }, laptop);
  ok(r.y + r.h > laptop.height, 'a panel may hang off the bottom of the screen');
  grabbable(r, laptop, 'hanging off the bottom');
  eq(clampDock({ x: 100, y: -300, w: 400, h: 600 }, laptop).y, 0,
    'but never off the top — that is the one move a reader cannot undo');
}

/* ------------------------------------------------------------------ */
/* Resizing                                                            */
/* ------------------------------------------------------------------ */

{
  const start: DockRect = { x: 400, y: 200, w: 500, h: 500 };

  const se = resizeDock(start, 'se', 100, 100, laptop);
  eq(se.w, 600, 'a south-east grip grows the width');
  eq(se.h, 600, 'and the height');
  eq(se.x, start.x, 'without moving the origin');
  eq(se.y, start.y, 'in either axis');

  const nw = resizeDock(start, 'nw', 100, 100, laptop);
  eq(nw.w, 400, 'a north-west grip shrinks as it is dragged inward');
  eq(nw.x, 500, 'and moves the origin to match, so the far corner stays put');
  eq(nw.x + nw.w, start.x + start.w, 'which is what "the opposite corner is anchored" means');
  eq(nw.y + nw.h, start.y + start.h, 'vertically too');

  // Past the minimum, a west grip must STOP — not start walking the panel
  // across the screen, which is what happens if the origin is computed from
  // the already-clamped width instead of the original.
  const squashed = resizeDock(start, 'w', 5000, 0, laptop);
  eq(squashed.w, MIN_W, 'dragging a west edge past the minimum stops at the minimum');
  eq(squashed.x + squashed.w, start.x + start.w, 'and the right edge has not moved');

  const flat = resizeDock(start, 'n', 5000, 5000, laptop);
  eq(flat.h, MIN_H, 'the same for a north edge');
  eq(flat.y + flat.h, start.y + start.h, 'with the bottom anchored');

  // Single-axis grips leave the other axis alone.
  eq(resizeDock(start, 'e', 50, 999, laptop).h, start.h, 'an east grip ignores vertical movement');
  eq(resizeDock(start, 's', 999, 50, laptop).w, start.w, 'and a south grip ignores horizontal');
}

{
  // Resized bigger than the screen.
  const huge = resizeDock({ x: 20, y: 20, w: 400, h: 400 }, 'se', 9000, 9000, laptop);
  ok(huge.w <= laptop.width, 'a panel cannot be resized wider than the window');
  ok(huge.h <= laptop.height, 'nor taller');
  grabbable(huge, laptop, 'resized past the screen');
}

/* ------------------------------------------------------------------ */
/* The viewport changing under a saved position                        */
/* ------------------------------------------------------------------ */

{
  // Saved on a big monitor, opened on a laptop. This is the case dragging alone
  // never covers, and it is why clamping runs on the way IN rather than only
  // on move.
  const fromBigMonitor: DockRect = { x: 2400, y: 1300, w: 900, h: 1100 };
  const here = clampDock(fromBigMonitor, laptop);
  grabbable(here, laptop, 'geometry saved on a larger screen');
  ok(here.x < fromBigMonitor.x, 'a panel saved off to the right is pulled back into view');
  ok(here.h < fromBigMonitor.h, 'and one taller than the window is cut down to it');
  // The width fitted already, so it is left alone — clamping repairs what is
  // broken and does not tidy what is not.
  eq(here.w, fromBigMonitor.w, 'while a width that already fits is untouched');

  // And on a phone after that.
  const onPhone = clampDock(here, phone);
  grabbable(onPhone, phone, 'the same geometry on a phone');
}

{
  // A tablet rotated from landscape to portrait mid-session.
  const landscape: Viewport = { width: 1024, height: 768 };
  const portrait: Viewport = { width: 768, height: 1024 };
  const placed = clampDock({ x: 600, y: 400, w: 400, h: 340 }, landscape);
  grabbable(clampDock(placed, portrait), portrait, 'after a rotation');
}

/* ------------------------------------------------------------------ */
/* Reading back what was stored                                        */
/* ------------------------------------------------------------------ */

{
  // Persisted geometry outlives the code that wrote it. A NaN would render an
  // invisible, un-grabbable panel — the exact failure this module exists for.
  eq(sanitizeDock(null, laptop), null, 'nothing stored means the default corner');
  eq(sanitizeDock('{}', laptop), null, 'a string is not geometry');
  eq(sanitizeDock({ x: 1, y: 2, w: 3 }, laptop), null, 'nor is a half-written rectangle');
  eq(sanitizeDock({ x: NaN, y: 0, w: 400, h: 400 }, laptop), null, 'and a NaN is rejected outright');
  eq(sanitizeDock({ x: 0, y: 0, w: Infinity, h: 400 }, laptop), null, 'so is an infinity');

  const good = sanitizeDock({ x: 100, y: 100, w: 400, h: 400 }, laptop);
  ok(good !== null, 'a real rectangle survives');
  if (good) {
    eq(good.x, 100, 'unchanged when it was already valid');
    grabbable(good, laptop, 'restored');
  }

  // Valid numbers, impossible position — sanitize clamps rather than rejecting,
  // because the reader's intent ("over there") is still worth honouring.
  const offscreen = sanitizeDock({ x: -9000, y: -9000, w: 400, h: 400 }, laptop);
  ok(offscreen !== null, 'an off-screen rectangle is repaired, not thrown away');
  if (offscreen) grabbable(offscreen, laptop, 'repaired from off-screen');
}

/* ------------------------------------------------------------------ */
/* Presets                                                             */
/* ------------------------------------------------------------------ */

{
  for (const vp of [laptop, phone, tiny]) {
    for (const preset of ['corner', 'tall', 'wide', 'centre'] as const) {
      grabbable(presetDock(preset, vp), vp, `${preset} at ${vp.width}×${vp.height}`);
    }
  }

  const tall = presetDock('tall', laptop);
  ok(tall.h > tall.w, 'the side column is taller than it is wide');
  ok(tall.h >= laptop.height * 0.9, 'and uses nearly the whole height — that is the point of it');

  const wide = presetDock('wide', laptop);
  ok(wide.w > wide.h, 'the bottom strip is wider than it is tall');
  ok(wide.y + wide.h <= laptop.height, 'and sits on the bottom edge');

  const centre = presetDock('centre', laptop);
  const gapLeft = centre.x;
  const gapRight = laptop.width - (centre.x + centre.w);
  ok(Math.abs(gapLeft - gapRight) <= 1, 'the centred preset is actually centred');
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

{
  const s = dockStyle({ x: 10, y: 20, w: 300, h: 400 });
  eq(s.left, 10, 'x becomes left');
  eq(s.top, 20, 'y becomes top');
  eq(s.width, 300, 'w becomes width');
  eq(s.height, 400, 'h becomes height');

  // Sub-pixel positions cause blurred text on a fractional-DPI screen, and the
  // panel is mostly text.
  const dragged = dragDock({ x: 10.4, y: 20.6, w: 300, h: 400 }, 0.3, 0.2, laptop);
  ok(Number.isInteger(dragged.x) && Number.isInteger(dragged.y), 'positions come back whole');
  ok(Number.isInteger(dragged.w) && Number.isInteger(dragged.h), 'and so do sizes');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
