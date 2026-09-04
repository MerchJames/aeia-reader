/**
 * Run: npx tsx src/utils/fontColor.test.ts
 *
 * A colour the model wrote, kept instead of thrown away.
 *
 * `inlineHtml.test.ts` next door pins the OTHER half of this: a `<font>` tag
 * must never reach the page as literal text, and prose full of angle brackets
 * that are not HTML (`<sighs>`, `x < y`) must survive untouched. Nothing here
 * is allowed to weaken either — every property in that file still holds with
 * colours on, and the last section re-checks the two that would break first.
 *
 * What this file is for is the thing that made colour worth keeping: it is
 * NOTATION, not decoration. One colour per speaker, a system voice, a status
 * readout — distinctions the prose does not otherwise carry, which the old
 * behaviour merged into one undifferentiated grey.
 *
 * Three properties:
 *
 * **Off is exactly what it was.** The default mode is 'ignore' and must be
 * byte-identical to the behaviour before this module existed, because every
 * renderer that has not been taught to paint a colour run still calls it.
 *
 * **A run always splits back to the words.** Whatever markup goes in, the words
 * come out — a sentinel that survives to the page is worse than a dropped
 * colour, and a passage caught mid-stream will contain half a sentinel.
 *
 * **Adapt keeps the distinction, not the value.** Two colours that were
 * different before must still be different after; a colour must not come out
 * invisible against the page it landed on.
 */
import {
  MARK_CLOSE, MARK_MID, MARK_OPEN,
  adaptColor, hasColorMarks, markColorRuns, parseColor, resolveColor,
  splitColorRuns, stripColorMarks,
} from './fontColor';
import { normalizeInlineHtml, processText } from './textProcessor';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (a === b) pass++;
  else { fail++; console.error('✗', msg, `\n    got  ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

/* ── Reading a colour ────────────────────────────────────────────────────── */
{
  eq(JSON.stringify(parseColor('#FFCC66')), JSON.stringify({ r: 255, g: 204, b: 102 }), 'six-digit hex');
  eq(JSON.stringify(parseColor('#f00')), JSON.stringify({ r: 255, g: 0, b: 0 }), 'three-digit hex is doubled');
  eq(JSON.stringify(parseColor('"#88ccff"')), JSON.stringify({ r: 136, g: 204, b: 255 }), 'quotes are stripped');
  eq(JSON.stringify(parseColor('red')), JSON.stringify({ r: 255, g: 0, b: 0 }), 'a colour name');
  eq(JSON.stringify(parseColor('rgb(10, 20, 30)')), JSON.stringify({ r: 10, g: 20, b: 30 }), 'rgb()');
  // An alpha channel is dropped rather than honoured: the model chose it
  // against a background it never saw, and a half-transparent word is a
  // legibility bug rather than a style.
  eq(JSON.stringify(parseColor('#ff000080')), JSON.stringify({ r: 255, g: 0, b: 0 }), 'eight-digit hex drops alpha');
  eq(parseColor('chartreuse'), null, 'a name we do not know is not a colour');
  eq(parseColor('inherit'), null, 'a keyword is not a colour');
  eq(parseColor(''), null, 'nothing is not a colour');
  eq(parseColor('#12345'), null, 'a malformed hex is not a colour');
}

/* ── Off is exactly what it was ──────────────────────────────────────────── */
{
  const reported = "<font color=#FFCC66>It's almost there. Sixty-five percent.</font>";
  eq(normalizeInlineHtml(reported), "It's almost there. Sixty-five percent.",
    'default mode drops the tag and keeps the words, as before');
  eq(normalizeInlineHtml(reported, 'ignore'), "It's almost there. Sixty-five percent.",
    "'ignore' is spelled out to the same result");
  eq(processText(reported, {}).processedText.trim(), "It's almost there. Sixty-five percent.",
    'a caller that says nothing about colour gets no sentinels');
  ok(!hasColorMarks(processText(reported, {}).processedText),
    'and nothing marked can leak to a renderer that cannot paint it');
}

/* ── On, the colour survives the markdown pass ───────────────────────────── */
{
  const out = normalizeInlineHtml('<font color=#FFCC66>Sixty-five percent.</font>', 'original');
  ok(hasColorMarks(out), 'the run is marked');
  const runs = splitColorRuns(out);
  eq(runs.length, 1, 'one run');
  eq(runs[0].text, 'Sixty-five percent.', 'the words are intact');
  eq(runs[0].color, '#FFCC66', 'the colour is carried as written');
  eq(stripColorMarks(out), 'Sixty-five percent.', 'and strip gives the plain words back');
}

/* ── Colour is notation: two speakers stay two speakers ──────────────────── */
{
  const src = '<font color="red">"Run,"</font> she said. <font color="blue">"No."</font>';
  const runs = splitColorRuns(normalizeInlineHtml(src, 'original'));
  eq(runs.length, 3, 'coloured, plain, coloured');
  eq(runs[0].color, 'red', 'the first speaker');
  eq(runs[1].color, null, 'the narration between them is not coloured');
  eq(runs[2].color, 'blue', 'the second speaker');
  eq(runs.map(r => r.text).join(''), '"Run," she said. "No."', 'and the sentence reads unbroken');
}

/* ── A colour we cannot read is not a colour ─────────────────────────────── */
{
  // The tag still has to GO — falling back to "leave it in place" would put a
  // literal `<font>` on the page, which is the bug this app already fixed once.
  const out = normalizeInlineHtml('<font color=inherit>hello</font>', 'original');
  eq(out, 'hello', 'an unreadable colour drops the tag and keeps the words');
  ok(!hasColorMarks(out), 'and marks nothing');
}

/* ── Nesting resolves to the innermost statement ─────────────────────────── */
{
  const out = normalizeInlineHtml(
    '<font color="red">outer <font color="blue">inner</font></font>', 'original');
  const runs = splitColorRuns(out);
  eq(stripColorMarks(out), 'outer inner', 'no words are lost to nesting');
  ok(runs.every(r => r.text.length > 0), 'and no empty runs are produced');
  ok(runs.some(r => r.color === 'blue'), 'the inner colour is the one that survives');
}

/* ── `<span style="color:…">` is the same statement ──────────────────────── */
{
  const runs = splitColorRuns(
    normalizeInlineHtml('<span style="color: #0f0; font-weight: bold">go</span>', 'original'));
  eq(runs[0].color?.trim(), '#0f0', 'a styled span is read as a colour too');
  eq(runs[0].text, 'go', 'and the rest of the style is ignored, not rendered');
}

/* ── Half a sentinel never reaches the page ──────────────────────────────── */
{
  // A passage is rendered while it streams, so every intermediate prefix of a
  // marked string gets rendered at some point — including one cut mid-run.
  const full = normalizeInlineHtml('<font color="red">the whole line</font>', 'original');
  for (let i = 0; i <= full.length; i++) {
    const prefix = full.slice(0, i);
    const painted = splitColorRuns(prefix).map(r => r.text).join('');
    ok(!/[\uE200-\uE202]/.test(painted), `prefix ${i} paints no sentinel`);
    ok(!/[\uE200-\uE202]/.test(stripColorMarks(prefix)), `prefix ${i} strips clean`);
  }
}

/* ── Adapt keeps the distinction and drops the value ─────────────────────── */
{
  const red = parseColor('#ff0000')!;
  const blue = parseColor('#0000ff')!;
  ok(adaptColor(red, true) !== adaptColor(blue, true), 'two hues stay two hues on a dark page');
  ok(adaptColor(red, true) !== adaptColor(red, false), 'the same hue is re-lit per theme');

  // The case that makes adapt worth having: a colour chosen against the
  // opposite background. `#111` as "the system voice" is invisible on Sepia.
  const nearBlack = adaptColor(parseColor('#111111')!, true);
  const light = /(\d+)%\)$/.exec(nearBlack);
  ok(!!light && Number(light[1]) >= 55, 'a near-black is lifted to readable on a dark page');
  const nearWhite = adaptColor(parseColor('#fffff0')!, false);
  const dark = /(\d+)%\)$/.exec(nearWhite);
  ok(!!dark && Number(dark[1]) <= 48, 'and a near-white is dropped to readable on a light one');
}

/* ── resolveColor is the one door the renderers use ──────────────────────── */
{
  eq(resolveColor('#ff0000', 'ignore', false), null, 'ignore paints nothing');
  eq(resolveColor('#ff0000', 'original', false), 'rgb(255 0 0)', 'original is the value as written');
  ok(resolveColor('#ff0000', 'adapt', true)?.startsWith('hsl('), 'adapt is re-lit');
  eq(resolveColor('bananas', 'original', false), null, 'and nonsense still paints nothing');
}

/* ── The neighbouring guarantees still hold ──────────────────────────────── */
{
  // These are `inlineHtml.test.ts`'s properties, re-checked with colours ON,
  // because the colour pass runs before the tag strip and could plausibly eat
  // either of them.
  eq(normalizeInlineHtml('She <sighs> and turns away.', 'original'),
    'She <sighs> and turns away.', 'angle brackets that are not HTML are left alone');
  eq(normalizeInlineHtml('3 < 5 and 5 > 3', 'original'), '3 < 5 and 5 > 3',
    'comparisons are not tags');
  const fenced = '```html\n<font color="red">x</font>\n```';
  eq(normalizeInlineHtml(fenced, 'original'), fenced, 'a fenced block keeps its tags verbatim');
  eq(normalizeInlineHtml('She <b>meant</b> it.', 'original'), 'She **meant** it.',
    'and the other tags still fold into markdown');
}

/* ── The sentinels themselves ────────────────────────────────────────────── */
{
  const marks: string[] = [MARK_OPEN, MARK_MID, MARK_CLOSE];
  eq(new Set(marks).size, 3, 'the three sentinels are distinct');
  ok(marks.every(c => c >= '\uE200' && c <= '\uE2FF'),
    'and live in a private-use block of their own, away from textProcessor’s');
  eq(stripColorMarks('nothing to do here'), 'nothing to do here', 'strip is a no-op on plain prose');
  eq(splitColorRuns('plain').length, 1, 'and split returns one plain run');
  eq(splitColorRuns('plain')[0].color, null, 'with no colour');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
