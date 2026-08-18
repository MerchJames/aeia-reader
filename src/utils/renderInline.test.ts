/**
 * Run: npx tsx src/utils/renderInline.test.ts
 *
 * Book / Stage / VN / HTML-export inline markdown.
 *
 * This renderer is the second of Aura's two text paths — Storybook and Chat go
 * through remark, everything else comes here — and the two have to agree. They
 * did not: `renderInline` never handled UNDERSCORE emphasis, so `_very_`
 * reached the page as literal underscores in four views while rendering
 * correctly in the other two.
 *
 * That was invisible until the dialogue pass started producing underscores on
 * purpose (it rewrites emphasis inside speech to `_…_` so the `*…*` wrap around
 * the line cannot collide with it) — at which point every emphasised word
 * inside every line of dialogue showed its markers.
 */
import { renderInline } from './bookLayout';
import { processText } from './textProcessor';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (a === b) pass++;
  else { fail++; console.error('✗', msg, `\n    got ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

/* ---- both emphasis dialects ---- */

eq(renderInline('a *star* here'), 'a <em>star</em> here', 'asterisk emphasis');
eq(renderInline('a _line_ here'), 'a <em>line</em> here', 'underscore emphasis');
eq(renderInline('a **bold** claim'), 'a <strong>bold</strong> claim', 'asterisk strong');
eq(renderInline('a __bold__ claim'), 'a <strong>bold</strong> claim', 'underscore strong');
eq(renderInline('***both***'), '<strong><em>both</em></strong>', 'asterisk bold-italic');
eq(renderInline('___both___'), '<strong><em>both</em></strong>', 'underscore bold-italic');
eq(renderInline('_a_ and *b*'), '<em>a</em> and <em>b</em>', 'the two dialects mix');

// Intraword underscores are identifiers, not emphasis — CommonMark agrees, and
// `*` has no equivalent hazard, which is why this rule exists only here.
eq(renderInline('snake_case_name'), 'snake_case_name', 'intraword underscores are left alone');
eq(renderInline('file_name_here.txt'), 'file_name_here.txt', 'and so are filenames');
eq(renderInline('a_b_c_d'), 'a_b_c_d', 'even several of them');

/* ---- the case that sent this to the page broken ---- */

const line = processText(
  `"It would be *very* weird," she murmurs. "The 'Silent Observer' becoming the 'Main Attraction'."`,
  { styleQuotes: true, repairFormatting: false },
).processedText;
const html = renderInline(line);

ok(!html.includes('_very_'), 'emphasis inside dialogue is rendered, not shown as underscores');
ok(html.includes('<em>very</em>'), 'and rendered as emphasis');
ok(html.includes('class="book-say"'), 'the speech still gets its dialogue class');

// Crossing tags: `<em>…<span>…</em>…</span>` is malformed, and a browser
// re-nesting it is what mangled the paragraph on screen.
const opens = [...html.matchAll(/<(\/?)(em|strong|span)\b/g)].map(m => `${m[1]}${m[2]}`);
const stack: string[] = [];
let balanced = true;
for (const t of opens) {
  if (!t.startsWith('/')) stack.push(t);
  else if (stack.pop() !== t.slice(1)) { balanced = false; break; }
}
ok(balanced && stack.length === 0, 'the markup nests properly — no crossing tags');

/* ---- things that must survive untouched ---- */

eq(renderInline('`a_b` and `*c*`'), '<code>a_b</code> and <code>*c*</code>',
  'code spans are never styled further');
ok(renderInline('![](data:image/png;base64,AA_BB)').includes('data:image/png;base64,AA_BB'),
  'an underscore in an image URL is not emphasis');
ok(!renderInline('<b>x</b>').includes('<b>'), 'raw HTML in the source is escaped');
eq(renderInline('line\nbreak'), 'line<br>break', 'newlines become breaks');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
