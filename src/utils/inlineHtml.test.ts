/**
 * Run: npx tsx src/utils/inlineHtml.test.ts
 *
 * HTML the model wrote, on its way to the page.
 *
 * The bug this exists for: raw HTML did not disappear, it arrived as LITERAL
 * TAGS. `remark-rehype` hands the tags on as `raw` nodes and, with no
 * `rehype-raw` in the pipeline, the JSX runtime renders a raw node as its own
 * text — so a coloured passage read `<font color=#FFCC66>It's almost there.
 * Sixty-five percent.</font>` on the page, in every view, and `<b>`, `<i>` and
 * `<br>` did the same. SillyTavern logs are full of all four.
 *
 * Three properties carry this file, and two of them are about what must NOT be
 * touched — because the obvious fix (strip `<[^>]+>`) quietly destroys prose.
 *
 * **Roleplay is full of angle brackets that are not HTML.** `<sighs>`,
 * `<Name>`, `x < y`, `<3`. A generic strip deletes all of them and the reader
 * never learns why their text lost words. Only known tag names may be rewritten.
 *
 * **A fenced block means it literally.** It is the one place a tag is supposed
 * to survive, and `MessageBlock`'s `HTML_ISH` reads fenced HTML to offer it as
 * a live pinned visual — rewriting it there would take that feature apart.
 *
 * **And nothing may be parked behind a bare number.** The guard that protects
 * code spans replaces them with a placeholder; if that placeholder is just an
 * index, the restore pass matches every literal number in the prose. The very
 * passage that reported this bug says "Sixty-five percent" and "100".
 */
import { normalizeInlineHtml, processText } from './textProcessor';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (a === b) pass++;
  else { fail++; console.error('✗', msg, `\n    got  ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

/* ── The reported passage ────────────────────────────────────────────────── */
{
  const reported = "<font color=#FFCC66>It's almost there. Sixty-five percent. Sixty-eight.</font>";
  eq(normalizeInlineHtml(reported), "It's almost there. Sixty-five percent. Sixty-eight.",
    'the font tag goes and every word of the passage stays');
  ok(!/[<>]/.test(processText(reported, {}).processedText),
    'and nothing tag-shaped survives the full pipeline');

  eq(normalizeInlineHtml('<font color="#88ccff">"Do not touch it,"</font> she said'),
    '"Do not touch it," she said', 'a quoted attribute is no different');
  eq(normalizeInlineHtml('half a tag </font'), 'half a tag </font',
    'an unterminated tag is prose — there is no tag there to remove');
}

/* ── What markdown can say, it says ──────────────────────────────────────── */
{
  eq(normalizeInlineHtml('She <b>meant</b> it.'), 'She **meant** it.', '<b> becomes bold');
  eq(normalizeInlineHtml('<i>The room hummed.</i>'), '*The room hummed.*', '<i> becomes emphasis');
  eq(normalizeInlineHtml('<strong>x</strong> <em>y</em>'), '**x** *y*', 'and their long names too');
  eq(normalizeInlineHtml('<del>gone</del>'), '~~gone~~', 'strikethrough, which gfm renders');
  eq(normalizeInlineHtml('a<br>b'), 'a\nb', '<br> becomes the line break it means');
  eq(normalizeInlineHtml('<h2>Chapter Two</h2>x'), '\n\n## Chapter Two\n\nx',
    'a heading becomes a markdown heading, so the heading channel can dress it');
  eq(normalizeInlineHtml('see <a href="https://x.test">the docs</a>'),
    'see [the docs](https://x.test)', 'a link keeps its href instead of losing it');

  // An unclosed tag leaves a dangling marker, which `repairFormatting` closes
  // at the end of its paragraph — the same treatment prose mis-marked by hand
  // already gets, rather than a second repair mechanism living here.
  eq(normalizeInlineHtml('She <b>meant it.'), 'She **meant it.',
    'an unclosed tag still becomes a marker and is left to the repair pass');
}

/* ── What must survive untouched ─────────────────────────────────────────── */
{
  const rp = '<sighs> x < y and <3 and <Name> stay put';
  eq(normalizeInlineHtml(rp), rp,
    'angle brackets that are not HTML tags are prose, and prose is never edited');
  eq(normalizeInlineHtml('a <notatag> b'), 'a <notatag> b', 'an invented tag name is left alone');

  const fence = 'text\n```html\n<div class="chart"><b>x</b></div>\n```\nafter';
  eq(normalizeInlineHtml(fence), fence,
    'a fenced block means its tags literally — HTML_ISH pins those as live visuals');
  eq(normalizeInlineHtml('use `<br>` for a break'), 'use `<br>` for a break',
    'and so does an inline code span');

  // The bare-index trap, in the words of the passage that reported the bug.
  eq(normalizeInlineHtml('Sixty-five percent, `100`, and 68% remain'),
    'Sixty-five percent, `100`, and 68% remain',
    'a literal number is never mistaken for a parked code span');
  eq(normalizeInlineHtml('no angle brackets here'), 'no angle brackets here',
    'text with no "<" is returned as it came');
}

/* ── It runs for everyone, not only when a preset is switched on ─────────── */
{
  // The "Strip HTML/XML tags" auto-format preset already existed and is opt-in,
  // so the DEFAULT experience was the broken one. This pass is unconditional.
  const out = processText('<font color=#FFCC66>hello</font>', {}).processedText;
  eq(out.trim(), 'hello', 'no autoFormat, no rules, no options — still clean');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
