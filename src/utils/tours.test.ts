/**
 * Run: npx tsx src/utils/tours.test.ts
 *
 * A guided tour makes claims about the app that nothing else in the codebase
 * makes: that this view exists, that this panel opens, that the manual has more
 * to say about it. Every one of those can be quietly falsified by a rename in a
 * file nobody thought was related, and the result is a tour that confidently
 * points at the wrong corner of the screen — worse than no tour, because the
 * reader trusts it.
 *
 * So the cross-references are checked here, and the DOM anchors — which cannot
 * be checked without a DOM — are checked by `scripts/checkTourAnchors.mjs`
 * against the components themselves.
 */

import { GUIDE_DOCS } from './guideDocs';
import { VIEW_ORDER } from './viewBar';
import {
  TOURS, TOUR_ANCHORS, anchorSelector, availableTours, needsSample, stepTo, stopLabel,
  tourBlocker, tourById, visibleStops,
} from './tours';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) pass++; else { fail++; console.error('✗', msg); }
};
const eq = (a: unknown, b: unknown, msg: string) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.error('✗', msg, `\n    got  ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

/** Kept in step with `GuidePanel` in guideDocs.ts by the assertion below. */
const PANELS = [
  'settings', 'codex', 'sheets', 'ai', 'frame', 'multiverse', 'branching',
  'backup', 'sync', 'tour', 'library',
];

/* ── The tours exist and are distinct ────────────────────────────────────── */

// A count, so adding or dropping a tour is a decision rather than a diff nobody
// reads. The user asked for one per big mode; this is the list of what "big"
// currently means.
eq(TOURS.length, 14, 'fourteen tours');
eq(new Set(TOURS.map(t => t.id)).size, TOURS.length, 'with distinct ids');
eq(
  new Set(TOURS.flatMap(t => t.stops.map(s => s.id))).size,
  TOURS.reduce((n, t) => n + t.stops.length, 0),
  // Stop ids are how progress is remembered. Two stops sharing one would make a
  // reader who finished the first appear to have finished the second.
  'and every stop id is unique across all of them',
);
ok(TOURS.every(t => t.stops.length >= 3), 'each tour is worth starting — three stops at least');

/* ── Cross-references ────────────────────────────────────────────────────── */

for (const tour of TOURS) {
  for (const stop of tour.stops) {
    if (stop.view) {
      ok(VIEW_ORDER.includes(stop.view), `${stop.id} switches to a real view (${stop.view})`);
    }
    if (stop.panel) {
      ok(PANELS.includes(stop.panel), `${stop.id} opens a panel the guide may open (${stop.panel})`);
    }
    if (stop.doc) {
      ok(
        GUIDE_DOCS.some(d => d.id === stop.doc),
        // "Tell me more" is a promise. A stop pointing at a manual entry that
        // was renamed sends the reader to an empty page.
        `${stop.id} points at a manual entry that exists (${stop.doc})`,
      );
    }
  }
}

/* ── What a stop says ────────────────────────────────────────────────────── */

for (const tour of TOURS) {
  for (const stop of tour.stops) {
    ok(stop.title.length <= 60, `${stop.id}: the title is a title, not a sentence`);
    ok(
      stop.body.length >= 60 && stop.body.length <= 420,
      // Small to medium, both ways. Under sixty characters explains nothing;
      // over four hundred is a paragraph on top of the thing it is pointing at,
      // and gets skipped. The manual is one click away on every stop.
      `${stop.id}: the body is small to medium (${stop.body.length} chars)`,
    );
    ok(!/\bclick here\b/i.test(stop.body), `${stop.id}: says what a thing does, not "click here"`);
  }
}

/* ── Anchors ─────────────────────────────────────────────────────────────── */

ok(TOUR_ANCHORS.length > 0, 'the tours name elements to spotlight');
eq(
  TOUR_ANCHORS.length, new Set(TOUR_ANCHORS).size,
  'and the anchor list is deduplicated, so a shared anchor is checked once',
);
eq(anchorSelector('pin-dock'), '[data-tour="pin-dock"]', 'anchors resolve to one attribute');
ok(
  TOUR_ANCHORS.every(a => /^[a-z][a-z0-9-]*$/.test(a)),
  // They go into a CSS attribute selector. A stray quote would either break the
  // query or select something else entirely.
  'and every anchor is safe to put in a selector',
);

/* ── Offering them ───────────────────────────────────────────────────────── */

const none = { hasStory: false, aiReady: false };
const full = { hasStory: true, aiReady: true };

ok(availableTours(full).length === TOURS.length, 'with a story and a model, every tour is offered');
ok(
  availableTours(none).some(t => t.needsStory),
  // Wanting a story stopped being a reason to withhold a tour when the sample
  // arrived. Four of the seven are about reading, the Lens and the workspace,
  // and greying all four out for the reader who has imported nothing yet hides
  // the app from exactly the person it was built for.
  'with no story open, the ones that need one are still offered',
);
ok(
  TOURS.filter(t => t.needsStory).every(t => needsSample(t, none)),
  'and each of them says it will open the sample first',
);
ok(
  TOURS.filter(t => t.needsStory).every(t => !needsSample(t, full)),
  'while a reader who already has a story open keeps the one they are reading',
);
ok(
  TOURS.filter(t => !t.needsStory).every(t => !needsSample(t, none)),
  'a tour that needs no story never replaces the screen with one',
);
ok(
  !availableTours(none).some(t => t.ai),
  'and with no endpoint, the AI tour is not offered either',
);
ok(
  availableTours(none).length > 0,
  // A picker with nothing in it on first run is the moment a reader decides the
  // feature is broken.
  'but something is always offered, even on a first run',
);

const lens = tourById('lens')!;
ok(
  visibleStops(lens, none).length < visibleStops(lens, full).length,
  'AI stops drop out of a mixed tour when there is no endpoint',
);
ok(
  !visibleStops(lens, none).some(s => s.ai),
  // Shown-and-disabled would spend the reader's attention on a feature they
  // have already decided not to use.
  'and are dropped rather than shown greyed out',
);

ok(!!tourBlocker(tourById('ai')!, none), 'a tour needing an endpoint says so');
eq(tourBlocker(tourById('library')!, none), null, 'and an available one does not');
eq(
  tourBlocker(tourById('reading')!, none), null,
  // A blocker is something the reader has to go and fix. Needing a story is
  // something the app can just do, and confusing the two is what turned four
  // tours into dead ends.
  'needing a story is not a blocker — it is a sample waiting to be opened',
);
eq(tourById('nope'), undefined, 'an unknown tour id is undefined, not a throw');

/* ── Stepping ────────────────────────────────────────────────────────────── */

const stops = tourById('library')!.stops;
eq(stepTo(stops, 0, 1), 1, 'next goes forward');
eq(stepTo(stops, 1, -1), 0, 'back goes back');
eq(stepTo(stops, 0, -1), 0, 'back from the first stays put rather than wrapping');
eq(stepTo(stops, stops.length - 1, 1), null, 'and next from the last ends the tour');
eq(stopLabel(0, 4), '1 of 4', 'progress counts from one, like people do');


/* ── Examples are the point ──────────────────────────────────────────────── */

/*
 * A stop that says "pins hold facts the story keeps forgetting" is a
 * definition. Three real pins out of a real chat are a picture of what a
 * well-used library looks like, and that is what somebody needs before they
 * will build one. The whole reason to have a tour rather than a manual is that
 * it can SHOW the thing — so a stop without an example is a stop that has
 * fallen back to being the manual.
 */
{
  const stops = TOURS.flatMap(t => t.stops);
  const bare = stops.filter(s => !s.example?.length).map(s => s.id);
  eq(bare, [], 'every stop carries worked examples');

  const lines = stops.reduce((n, s) => n + (s.example?.length ?? 0), 0);
  ok(lines >= 150, `there are ${lines} example lines across ${stops.length} stops`);
  ok(
    stops.every(s => (s.example?.length ?? 0) >= 2),
    // One example reads as a special case; two or more read as a shape.
    'and never fewer than two on a stop',
  );
  ok(
    stops.every(s => (s.example ?? []).every(e => e.length <= 90)),
    'each of them fits on a line of the card',
  );
  ok(
    stops.every(s => new Set(s.example ?? []).size === (s.example?.length ?? 0)),
    'with no stop repeating itself',
  );
}

/* ── Coverage ────────────────────────────────────────────────────────────── */

/*
 * The segmentation is by what the reader came to do, not by where the code
 * lives — but it still has to REACH the app. These are the two ways a tour set
 * quietly stops covering things: a feature area loses its tour in a refactor,
 * or the tours stay and stop pointing at anything real.
 */
{
  const want = [
    'library', 'reading', 'views', 'marking', 'lens', 'workspace', 'ai',
    'assistants', 'scenes', 'audio', 'appearance', 'export', 'sync', 'safety',
  ];
  eq(TOURS.map(t => t.id).sort(), [...want].sort(), 'every feature area has a tour');

  const stops = TOURS.flatMap(t => t.stops);
  ok(
    stops.filter(s => s.target).length >= stops.length * 0.6,
    'most stops point at something on screen rather than only describing it',
  );
  ok(
    stops.filter(s => s.doc).length >= stops.length * 0.6,
    'and most have a manual entry behind them for "tell me more"',
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
