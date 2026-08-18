/**
 * Run: npx tsx src/utils/performMarkup.test.ts
 *
 * This runs over HTML the app has already built, so the first duty is to do no
 * harm — a marker that rewrites a tag or splits an entity turns a page of prose
 * into garbage, and it would do it silently. After that come the two rules the
 * React path established and this one has to match exactly: function words are
 * never marked, and a cue fires once.
 */
import {
  PERFORM_CSS, EMPHASIS_CSS, markPerformHtml, emphasisWordKinds, markSceneHtml,
  emphasisClass, emphasisKindKey,
} from './performMarkup';
import { PERFORM_KINDS, performMatcher, performWordKinds } from './scenePerform';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };

const kinds = (text: string, kind = 'swell' as const) => performWordKinds([{ text, kind }]);

/* ---- doing nothing, correctly ---- */

const html = '<p>The hearth had burned down to embers.</p>';
ok(markPerformHtml(html, null) === html, 'no cues leaves the html identical');
ok(markPerformHtml(html, new Map()) === html, 'an empty cue map changes nothing');
ok(markPerformHtml('', kinds('hearth')) === '', 'empty input stays empty');
ok(markPerformHtml(html, kinds('nothingmatches')) === html,
  'a cue that matches no word leaves the html byte-identical');

/* ---- the actual marking ---- */

const marked = markPerformHtml(html, kinds('hearth'));
ok(marked.includes('<span class="perf-swell">hearth</span>'), 'the cue word is wrapped');
ok(marked.startsWith('<p>') && marked.endsWith('</p>'), 'surrounding markup survives');
ok(marked.replace(/<[^>]+>/g, '') === 'The hearth had burned down to embers.',
  'the visible text is unchanged');

// THE contract the e2e pins: one word per mark, not the whole span.
const span = markPerformHtml('<p>she pulls away from the fire</p>', kinds('she pulls away'));
const wrapped = [...span.matchAll(/<span class="perf-swell">([^<]+)<\/span>/g)].map(m => m[1]);
ok(wrapped.every(w => !/\s/.test(w)), 'each mark contains exactly one word');
ok(wrapped.includes('pulls') && wrapped.includes('away'), 'the content words are marked');
ok(!wrapped.includes('she'), 'a pronoun in the cue is not marked');
ok(!span.includes('perf-swell">the<'), 'and neither is "the"');

// Fire-once: the flooding bug that NEVER_MARK exists to stop, from the other side.
const twice = markPerformHtml('<p>away and away and away again</p>', kinds('away'));
ok([...twice.matchAll(/perf-swell/g)].length === 1, 'a cue marks its word once, not every time');

// A shared claimed set spans paragraphs of one message.
const claimed = new Set<string>();
const k = kinds('embers');
const p1 = markPerformHtml('<p>embers</p>', k, { claimed });
const p2 = markPerformHtml('<p>embers</p>', k, { claimed });
ok(p1.includes('perf-swell') && !p2.includes('perf-swell'),
  'a shared claimed set makes the mark fire once across paragraphs');

/* ---- do no harm ---- */

// A word matching a cue but living inside an attribute must not be rewritten.
const attr = markPerformHtml('<p data-msg="hearth" class="hearth">hearth</p>', kinds('hearth'));
ok(attr.includes('data-msg="hearth"'), 'an attribute value is left alone');
ok(attr.includes('class="hearth"'), 'a class name is left alone');
ok([...attr.matchAll(/perf-swell/g)].length === 1, 'only the text node is marked');

// Entities must survive intact.
const ent = markPerformHtml('<p>&quot;embers&quot; &amp; ash</p>', kinds('embers ash'));
ok(ent.includes('&quot;') && ent.includes('&amp;'), 'entities are preserved');
ok(ent.includes('<span class="perf-swell">embers</span>'), 'a word beside an entity still marks');
ok(ent.includes('<span class="perf-swell">ash</span>'), 'and so does one after an entity');

// Code is not prose.
const code = markPerformHtml('<p>run <code>embers --now</code> please</p>', kinds('embers'));
ok(!code.includes('perf-swell'), 'nothing inside <code> is marked');
const pre = markPerformHtml('<pre>embers</pre><p>embers</p>', kinds('embers'));
ok([...pre.matchAll(/perf-swell/g)].length === 1, 'a <pre> block is skipped but the prose after it is not');

// Nested markup is walked, not flattened.
const nested = markPerformHtml('<p>the <em>embers</em> died</p>', kinds('embers'));
ok(nested.includes('<em>') && nested.includes('</em>'), 'nested tags survive');
ok(nested.includes('perf-swell'), 'and their text is still marked');

// Malformed input must not throw or truncate.
ok(typeof markPerformHtml('<p>embers', kinds('embers')) === 'string', 'an unclosed tag does not throw');
ok(markPerformHtml('a < b', kinds('zzz')) === 'a < b', 'a stray angle bracket is preserved');

// Whitespace is structural in <pre> and cosmetic elsewhere, but never lost.
const ws = markPerformHtml('<p>embers   and\n  ash</p>', kinds('embers ash'));
ok(ws.replace(/<[^>]+>/g, '') === 'embers   and\n  ash', 'exact whitespace is preserved');

/* ---- the stylesheet the sandbox iframe needs ---- */

for (const kind of PERFORM_KINDS) {
  ok(PERFORM_CSS.includes(`.perf-${kind}`), `PERFORM_CSS styles ${kind}`);
}
ok(/prefers-reduced-motion/.test(PERFORM_CSS), 'PERFORM_CSS honours reduced motion');
ok(!/[<>]/.test(PERFORM_CSS), 'PERFORM_CSS has no markup in it — it is injected into a <style>');

/* ---- the emphasis track, on the same scanner --------------------------------
 *
 * Shouts and whispers reached Storybook and Chat through `wrapWords` and Stage
 * and VN through their own span renderer — and stopped dead at Book. The
 * performance track had been unified across the five views and this one had
 * not, which is a difference nobody could have guessed from the settings panel.
 */

const emph = emphasisWordKinds(
  [{ text: 'get out now', kind: 'shout' }, { text: 'barely audible', kind: 'whisper' }] as never,
  true,
);
ok(emph?.get('get') === 'shout' && emph?.get('barely') === 'whisper', 'emphasis maps to its words');
// The same stoplist the performance track needs: a cue names a SPAN but is
// matched per word, so without it one cue paints every "out" on the page.
ok(!emph?.has('out'), 'and the stoplist still applies — "out" is a preposition, not a shout');
ok(emphasisWordKinds([{ text: 'a beat', kind: 'beat' }] as never, true) === null,
  'a beat is a pause, not a treatment, so it maps to nothing');
ok(emphasisWordKinds([{ text: 'get out', kind: 'shout' }] as never, false) === null,
  'shouts are gated on expressive text, exactly as the React path gates them');
ok(emphasisWordKinds([{ text: 'a door', kind: 'sfx' }] as never, false)?.get('door') === 'sfx',
  'an sfx mark is NOT expressive-gated');

const dressed = markSceneHtml(
  '<p>She said get out and barely audible he heard</p>', emph, null, new Set(),
);
ok(dressed.includes('<span class="expr-shout">get</span>'), 'a shout is dressed with the reader’s class');
ok(dressed.includes('<span class="expr-whisper">barely</span>'), 'and a whisper with its own');
ok(markSceneHtml('<p>a door slammed</p>',
  emphasisWordKinds([{ text: 'door', kind: 'sfx' }] as never, true), null, new Set())
  .includes('class="sfx-mark"'), 'an sfx mark uses the class the stylesheet already has');

// Both tracks share one claimed set: one mark stays one mark ACROSS them, or a
// word carrying both a shout and a swell would be wrapped twice.
const shared = new Set<string>();
const both = markSceneHtml(
  '<p>the lantern guttered</p>',
  new Map([['lantern', 'shout']]),
  new Map([['lantern', 'swell']]) as never,
  shared,
);
ok(both.includes('expr-shout') && !both.includes('perf-swell'),
  'emphasis wins the word, and the performance track does not double-wrap it');
ok(markSceneHtml('<p>the lantern guttered</p>', null, new Map([['lantern', 'swell']]) as never, new Set())
  .includes('perf-swell'), 'and with no emphasis the performance track still marks it');

// The ALL-CAPS heuristic. Storybook and Chat grew shouted words through
// `wrapWords`; Book had only the cue path, so "RUN!" sat flat one view over.
const caps = markSceneHtml('<p>She turned and screamed RUN NOW</p>', null, null, new Set(), true);
ok(caps.includes('<span class="expr-shout">RUN</span>'), 'an all-caps word is dressed as a shout');
ok(caps.includes('<span class="expr-shout">NOW</span>'), 'and so is the next one');
ok(!caps.includes('<span class="expr-shout">She</span>'), 'a capitalised word is not a shout');
ok(markSceneHtml('<p>She screamed RUN</p>', null, null, new Set(), false) === '<p>She screamed RUN</p>',
  'and none of it happens with expressive text off');

// It is a heuristic, not a cue: a word shouted three times is shouted three
// times, so it must NOT consume the fire-once set the cues share.
const thrice = markSceneHtml('<p>RUN and RUN and RUN</p>', null, null, new Set(), true);
ok((thrice.match(/expr-shout/g) ?? []).length === 3, 'every shout fires, not just the first');

ok(!markSceneHtml('<p><code>RUN</code></p>', null, null, new Set(), true).includes('expr-shout'),
  'and code is still never dressed');


/* ---- cadence runs ---- */

// The whole point: the words that STALL are the small ones, and the word map
// throws them away. A run must dress the lot.
{
  const cues = [{ text: 'In the end', kind: 'stagger' as const }];
  const out = markSceneHtml(
    '<p>In the end it was nothing at all.</p>', null, performWordKinds(cues),
    new Set(), false, undefined, performMatcher(cues),
  );
  ok((out.match(/perf-stagger/g) ?? []).length === 3, 'every word of the cadence is marked');
  ok(out.includes('class="perf-stagger">In<'), 'including the stopwords the map throws away');
  ok(out.includes('class="perf-stagger">the<'), 'both of them');
  ok(!/perf-stagger">nothing</.test(out), 'and nothing outside the run is touched');
}

// A run is very often a repeat, and each beat has to animate on its own.
{
  const cues = [{ text: 'No. No. No.', kind: 'drop' as const }];
  const played = new Set<string>();
  const out = markSceneHtml(
    '<p>No. No. No. she said</p>', null, performWordKinds(cues), new Set(), false,
    played, performMatcher(cues),
  );
  ok((out.match(/perf-drop/g) ?? []).length === 3, 'all three beats are marked');
  ok(!out.includes('fx-played'), 'and none of them is treated as a repeat of the first');
}

// Second render of the same passage: marked the same, moving no longer.
{
  const cues = [{ text: 'In the end', kind: 'stagger' as const }];
  const played = new Set<string>();
  const render = () => markSceneHtml(
    '<p>In the end.</p>', null, performWordKinds(cues), new Set<string>(), false, played,
    performMatcher(cues),
  );
  render();
  const again = render();
  ok((again.match(/perf-stagger/g) ?? []).length === 3, 'the run keeps its look on a re-render');
  ok((again.match(/fx-played/g) ?? []).length === 3, 'and stops animating');
}

// A cadence cue must not smear across a tag boundary or into code.
{
  const cues = [{ text: 'go now', kind: 'stagger' as const }];
  const out = markSceneHtml(
    '<p>go <em>now</em></p>', null, null, new Set(), false, undefined, performMatcher(cues),
  );
  ok(out.includes('<em>') && (out.match(/perf-stagger/g) ?? []).length === 2,
    'a run crosses inline markup without eating it');
}

/* ---- the typographic emphasis kinds ---- */

ok(emphasisKindKey({ text: 'x', kind: 'underline' }) === 'underline', 'plain kinds are their own key');
ok(emphasisKindKey({ text: 'x', kind: 'color', color: 'pink' }) === 'color-pink', 'a colour is part of the key');
ok(emphasisKindKey({ text: 'x', kind: 'color' }) === 'color-accent', 'no colour falls back to the accent');
ok(emphasisKindKey({ text: 'x', kind: 'color', color: 'chartreuse' }) === 'color-accent',
  'and so does a colour the palette does not have — an invented name still marks');

ok(emphasisClass('shout') === 'expr-shout' && emphasisClass('sfx') === 'sfx-mark',
  'the vocal kinds keep the class names the stylesheet already uses');
ok(emphasisClass('color-blue') === 'expr-color-blue', 'and a colour key becomes its own class');

// Typographic emphasis is not vocal, so it does not follow the expressive-text
// setting the way shout and whisper do.
{
  const spans = [
    { text: 'ruined', kind: 'strike' as const },
    { text: 'burned', kind: 'shout' as const },
  ];
  const off = emphasisWordKinds(spans, false);
  ok(off?.get('ruined') === 'strike', 'a strike survives expressive text being off');
  ok(off?.get('burned') === undefined, 'a shout does not');
}

ok(emphasisWordKinds([{ text: 'wait', kind: 'beat' }], true) === null,
  'a beat is a pause, and still draws nothing');

{
  const out = markSceneHtml(
    '<p>The letter was ruined.</p>',
    emphasisWordKinds([{ text: 'ruined', kind: 'color', color: 'blue' }], true),
    null, new Set(),
  );
  ok(out.includes('class="expr-color-blue">ruined'), 'a coloured span reaches the HTML views');
}

for (const cls of ['expr-underline', 'expr-strike', 'expr-color-accent', 'expr-color-blue']) {
  ok(EMPHASIS_CSS.includes(`.${cls}`), `${cls} is styled in the exported stylesheet too`);
}
ok(PERFORM_CSS.includes('pRunTell') && PERFORM_CSS.includes('.perf-stagger{animation:pStamp'),
  'and the cadence tell ships with the export');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
