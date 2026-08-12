/**
 * Run: npx tsx src/utils/onboarding.test.ts
 *
 * The tour is the one place in the app that makes PROMISES. A step that names a
 * view which no longer exists, or that claims an AI feature is required, is
 * worse than no tour at all — so those are the things checked here, against the
 * app's real view list rather than against a copy of it.
 */
import { ONBOARDING_STEPS, isAiStep } from './onboarding';
import { VIEW_LABEL, VIEW_ORDER } from './viewBar';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };

ok(ONBOARDING_STEPS.length >= 4 && ONBOARDING_STEPS.length <= 14,
  `the tour is short enough to finish (${ONBOARDING_STEPS.length} steps)`);
// A tour that only describes is a wall of text. Most steps should SHOW.
const shown = ONBOARDING_STEPS.filter(s => s.demo || s.example || s.views).length;
ok(shown >= ONBOARDING_STEPS.length - 2, `nearly every step demonstrates something (${shown}/${ONBOARDING_STEPS.length})`);

const ids = ONBOARDING_STEPS.map(s => s.id);
ok(new Set(ids).size === ids.length, 'every step has a distinct id');
ok(ids[0] === 'welcome', 'it opens on the welcome');
ok(ids[ids.length - 1] === 'done', 'and closes on the sign-off');

for (const step of ONBOARDING_STEPS) {
  ok(!!step.title.trim(), `${step.id}: has a title`);
  ok(step.title.length <= 60, `${step.id}: the title fits on one line (${step.title.length})`);
  ok(!!step.body.trim(), `${step.id}: has a body`);
  // Any longer and it stops being read, which defeats the point of a tour.
  ok(step.body.length <= 320, `${step.id}: the body stays short (${step.body.length})`);
  ok(!step.example || step.example.length <= 5, `${step.id}: at most five example lines`);
  ok(!step.example || step.example.every(e => !!e.trim()), `${step.id}: no blank examples`);
}

// THE check worth having: a step cannot advertise a view that does not exist.
for (const step of ONBOARDING_STEPS) {
  for (const view of step.views ?? []) {
    ok(VIEW_ORDER.includes(view), `${step.id}: "${view}" is a real view`);
    ok(!!VIEW_LABEL[view], `${step.id}: "${view}" has a label to show`);
  }
}

// The views step promises "nine ways to read" — so it had better name all of
// them, and the app had better still have that many.
const viewsStep = ONBOARDING_STEPS.find(s => s.id === 'views')!;
ok(viewsStep.views?.length === VIEW_ORDER.length,
  `the views step names every view (${viewsStep.views?.length} of ${VIEW_ORDER.length})`);
ok(/nine/i.test(viewsStep.title) === (VIEW_ORDER.length === 9),
  'and the number it claims out loud matches how many there are');

// Audio and the AI endpoint are separate optional services, not bundled — the
// tour must not imply either ships with Aura.
const sound = ONBOARDING_STEPS.find(s => s.id === 'sound')!;
ok(!!sound.demo, 'the audio step demonstrates rather than lists');

/* ---- the ethos the tour must not break ---- */

const aiSteps = ONBOARDING_STEPS.filter(isAiStep);
ok(aiSteps.length >= 1, 'the AI steps are marked as such');
for (const step of aiSteps) {
  ok(/optional|off by default|fallback/i.test(step.title + step.body),
    `${step.id}: says out loud that it is optional`);
}
const summary = aiSteps.find(s => s.id === 'ai')!;
ok(/fallback|AI-free|without/i.test(summary.body), 'and that there is a path without it');

// No step may imply the reader must connect anything to use Aura.
for (const step of ONBOARDING_STEPS) {
  if (isAiStep(step)) continue;
  ok(!/\bAPI key\b|\byou (?:must|need to) connect\b/i.test(step.body),
    `${step.id}: does not demand an endpoint`);
}

// The sign-off has to tell the reader how to get back here, or the button in
// the library is undiscoverable.
const done = ONBOARDING_STEPS[ONBOARDING_STEPS.length - 1];
ok(/reopen|again|any time/i.test(done.body), 'the last step says the tour can be reopened');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
