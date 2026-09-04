/**
 * Run: npx tsx src/utils/replyPipeline.test.ts
 *
 * The pipeline a reply goes through, as a list the reader controls.
 *
 * The property that matters most is not what any one step does — it is that
 * **the list survives**. These settings persist across versions of the app, so
 * a step added later must not appear switched on for someone who never asked
 * for it, and one removed must not linger as a broken entry. Two of the four
 * steps cost model calls, so "quietly turned on" is a real bill.
 */
import {
  DEFAULT_REPLY_STEPS, STEP_INFO, describeSteps, forceFormat, modelCost, moveStep,
  needsPolish, reconcileSteps, tidy, toggleStep, type ReplyStep,
} from './replyPipeline';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.error('✗', msg, `\n    got  ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

const steps = (...on: string[]): ReplyStep[] =>
  DEFAULT_REPLY_STEPS.map(s => ({ ...s, enabled: on.includes(s.kind) }));

/* ── Defaults ────────────────────────────────────────────────────────────── */
{
  eq(DEFAULT_REPLY_STEPS.filter(s => s.enabled).map(s => s.kind), ['tidy'],
    'only the free deterministic step is on out of the box');
  eq(modelCost(DEFAULT_REPLY_STEPS), 0, 'so a new reader pays for nothing');
  eq(modelCost(steps('tidy', 'check', 'polish')), 2, 'and the model steps are counted honestly');
}

/* ── Order ───────────────────────────────────────────────────────────────── */
{
  // The reason order is the reader's to set: `check` quotes a sentence out of
  // the text it was handed, and if `format` has moved that sentence since, the
  // repair lands on nothing.
  const moved = moveStep(DEFAULT_REPLY_STEPS, 'check', -1);
  eq(moved.map(s => s.kind), ['tidy', 'check', 'format', 'polish'], 'a step can move up');
  eq(moveStep(moved, 'check', 1).map(s => s.kind), ['tidy', 'format', 'check', 'polish'],
    'and back down');

  eq(moveStep(DEFAULT_REPLY_STEPS, 'tidy', -1).map(s => s.kind),
    DEFAULT_REPLY_STEPS.map(s => s.kind), 'the first step cannot move off the top');
  eq(moveStep(DEFAULT_REPLY_STEPS, 'polish', 1).map(s => s.kind),
    DEFAULT_REPLY_STEPS.map(s => s.kind), 'nor the last off the bottom');

  const before = JSON.stringify(DEFAULT_REPLY_STEPS);
  moveStep(DEFAULT_REPLY_STEPS, 'check', -1);
  toggleStep(DEFAULT_REPLY_STEPS, 'check');
  eq(JSON.stringify(DEFAULT_REPLY_STEPS), before, 'and neither one mutates the list it was given');
}

/* ── Surviving a version change ──────────────────────────────────────────── */
{
  // The whole reason this function exists. A reader's stored list is from
  // whatever version they last ran.
  const old = reconcileSteps([{ kind: 'tidy', enabled: true }]);
  eq(old.map(s => s.kind), ['tidy', 'format', 'check', 'polish'],
    'a list from an older version gains the steps it never knew about');
  eq(old.filter(s => s.enabled).map(s => s.kind), ['tidy'],
    'and they arrive OFF — two of them cost money, and nobody asked for them');

  eq(reconcileSteps([{ kind: 'polish', enabled: true }, { kind: 'tidy', enabled: true }])
    .map(s => s.kind), ['polish', 'tidy', 'format', 'check'],
    'a reordered list keeps the reader’s order');

  eq(reconcileSteps([{ kind: 'ghost', enabled: true }, { kind: 'tidy', enabled: true }])
    .map(s => s.kind), ['tidy', 'format', 'check', 'polish'],
    'a step that no longer exists is dropped rather than carried as a broken entry');
  eq(reconcileSteps([{ kind: 'tidy', enabled: true }, { kind: 'tidy', enabled: false }])
    .filter(s => s.kind === 'tidy').length, 1, 'and a duplicate cannot appear twice');

  eq(reconcileSteps(null).map(s => s.kind), DEFAULT_REPLY_STEPS.map(s => s.kind),
    'nothing stored means the defaults');
  eq(reconcileSteps('nonsense').filter(s => s.enabled).length, 0,
    'and rubbish stored means everything off, not everything on');
}

/* ── What the reader is told ─────────────────────────────────────────────── */
{
  eq(describeSteps(steps()), 'nothing — the reply is passed through',
    'an empty pipeline says so rather than looking configured');
  ok(describeSteps(steps('tidy', 'check')).includes('→'),
    'and a pipeline is described in the order it runs');
  ok(Object.values(STEP_INFO).every(i => i.cost),
    'every step states its cost — two of them spend money');
}

/* ── Tidy ────────────────────────────────────────────────────────────────── */
{
  const broken = 'She said "come here and then stopped.';
  ok(tidy(broken) !== broken, 'an unclosed quote is closed');
  eq(tidy('Nothing wrong here.'), 'Nothing wrong here.', 'and clean prose is untouched');
}

/* ── Force format ────────────────────────────────────────────────────────── */
{
  const config = {
    autoFormatRules: [],
    paragraphSpacing: true,
    dialogueOwnLine: false,
    smartTypography: true,
    styleQuotes: false,
  };
  eq(forceFormat('Wait... what?', config), 'Wait… what?',
    'the reader’s typography rules are applied to the text itself');

  // Not a reading convenience: `{{char}}` resolved on the page is right, and
  // resolved in the saved chat file destroys a template SillyTavern re-resolves
  // for every persona.
  eq(forceFormat('Hello {{char}}.', config), 'Hello {{char}}.',
    'but placeholders are never substituted — that would be written into the chat');

  // A pattern nothing else touches. An earlier version of this test used ` -- `
  // and passed for the wrong reason: `smartTypography` turns that into an em
  // dash by itself, so the assertion proved nothing about the rule at all.
  const rule = (enabled: boolean) => ({
    ...config,
    autoFormatRules: [
      { id: 'r', name: 'sigil', pattern: '%%', replacement: 'HERE', enabled } as never,
    ],
  });
  eq(forceFormat('a %% b', rule(true)), 'a HERE b', 'the reader’s own rules run');
  eq(forceFormat('a %% b', rule(false)), 'a %% b', 'while a disabled rule does not');
}

/* ── When polish is worth a call ─────────────────────────────────────────── */
{
  ok(needsPolish('She said "come here.'), 'an odd number of quotes is worth asking about');
  ok(needsPolish('The *lamp guttered.'), 'so is a dangling emphasis marker');
  ok(!needsPolish('She said "come here."'), 'balanced prose is not');
  ok(!needsPolish('Nothing special.'), 'and neither is prose with no marks at all');
  ok(!needsPolish('A **bold** claim.'), 'a bold pair is not a stray asterisk');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
