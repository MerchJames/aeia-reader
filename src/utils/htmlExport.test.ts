/**
 * Run: npx tsx src/utils/htmlExport.test.ts
 *
 * The export is a file that leaves the machine, so two properties matter more
 * than anything about how it looks:
 *
 *  1. It is SELF-CONTAINED. A single `http://` in the output is a file that
 *     phones home the moment someone opens it, and neither the sender nor the
 *     receiver would ever notice.
 *  2. It says what the reader read — through the Lens, through `processText`,
 *     with hidden passages omitted. Markdown export gets all of that wrong,
 *     which is why `walkStory` exists.
 */
import type { Chain, Story } from '../types';
import { THEMES } from '../themes';
import { ExportTypography, exportStoryHtml, isSelfContained, readingStylesheet } from './htmlExport';
import { FONT_STACKS } from './fontEmbed';
import { walkStory } from './storyWalk';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };

const msg = (id: string, name: string, content: string, extra: Record<string, unknown> = {}) =>
  ({ id, name, role: (name === 'You' ? 'user' : 'ai') as 'user' | 'ai', content, ...extra });

const story = {
  id: 's1', title: 'A Night at the Hearth', format: 'sillytavern',
  characterName: 'Mara', userName: 'You', messageCount: 4, importedAt: 1,
  messages: [
    msg('m1', 'Mara', 'The hearth had burned down to **embers**.'),
    msg('m2', 'You', 'I said nothing.'),
    msg('m3', 'Mara', '"You think I did not know," she said.'),
    msg('m4', 'Mara', 'A hidden system note.', { hidden: true }),
  ],
  highlights: [{ id: 'h1', messageId: 'm1', text: 'burned down', color: 'yellow', timestamp: 1 }],
} as unknown as Story;

const chains: Chain[] = [
  { id: 'c1', messages: story.messages.slice(0, 2), starred: false },
  { id: 'c2', messages: story.messages.slice(2), starred: false },
];

const TYPE: ExportTypography = {
  stack: FONT_STACKS.serif, fontSize: 18, contentWidth: 0, paragraphSpacing: true,
};

const walked = walkStory(story, chains, {});
const { html } = exportStoryHtml(walked, { theme: THEMES.dark, typography: TYPE, highlights: story.highlights });

/* ---- the walk ---- */

ok(walked.chapters.length === 2, 'chains become chapters');
ok(walked.messages.length === 3, 'a hidden message is left out');
ok(!walked.messages.some(m => m.text.includes('hidden system note')), 'and its text never appears');
ok(walked.wordCount > 0, 'words are counted');
ok(walkStory(story, chains, { includeHidden: true }).messages.length === 4,
  'includeHidden brings it back');

// The Lens layer is the thing markdown export silently drops.
const lensed = walkStory(story, chains, {
  lensOn: true,
  overrides: [{ id: 'o1', messageId: 'm1', content: 'A REWRITTEN opening.', createdAt: 2 } as never],
});
ok(lensed.messages[0].text === 'A REWRITTEN opening.', 'a Lens override is applied');
ok(!walkStory(story, chains, { overrides: [{ id: 'o1', messageId: 'm1', content: 'x', createdAt: 2 } as never] })
  .messages[0].text.includes('REWRITTEN'), 'and is ignored when the Lens is off');

// processText runs, so placeholders do not leak into a shared file.
const subbed = walkStory(
  { ...story, messages: [msg('m1', 'Mara', 'Hello {{user}}, I am {{char}}.')] } as unknown as Story,
  [], { substituteNames: true },
);
ok(subbed.messages[0].text === 'Hello You, I am Mara.', '{{user}} and {{char}} are substituted');

/* ---- self-containment: the property that matters most ---- */

ok(!/https?:\/\//.test(html), 'the output contains no http(s) URL');
ok(!/src\s*=\s*["']\/\//.test(html), 'and no protocol-relative src');
ok(!/<script[^>]+src=/i.test(html), 'no script is loaded from anywhere');
ok(html.includes('<script>'), 'the reveal script is inlined');
ok(!/@import/.test(html), 'no CSS @import');
ok(!/url\(\s*["']?https?:/i.test(html), 'no remote url() in the CSS');
ok(html.includes('<style>'), 'the stylesheet is inlined');

ok(isSelfContained('data:image/png;base64,AAA'), 'a data URI is self-contained');
ok(!isSelfContained('https://example.com/a.png'), 'a remote URL is not');
ok(!isSelfContained('//example.com/a.png'), 'nor a protocol-relative one');

const withImages = exportStoryHtml(
  walkStory({ ...story, messages: [msg('m1', 'Mara', 'x', { images: ['https://e.com/a.png', 'data:image/png;base64,AA'] })] } as unknown as Story, []),
  { theme: THEMES.dark, typography: TYPE },
);
ok(withImages.droppedImages === 1, 'a remote image is dropped and counted');
ok(withImages.html.includes('data:image/png;base64,AA'), 'an embedded one is kept');
ok(!/https?:\/\//.test(withImages.html), 'and the file is still self-contained');

/* ---- the document ---- */

ok(html.startsWith('<!doctype html>'), 'it is a whole document');
ok(html.includes('<title>A Night at the Hearth</title>'), 'the title is set');
ok(html.includes('Chapter 1') && html.includes('Chapter 2'), 'chapters are labelled');
ok(html.includes('<nav class="toc"'), 'a multi-chapter story gets contents');
ok(!exportStoryHtml(walkStory(story, [chains[0]], {}), { theme: THEMES.dark, typography: TYPE }).html.includes('<nav class="toc"'),
  'a single-chapter one does not');
ok(html.includes('<strong>embers</strong>'), 'markdown is rendered');
ok(html.includes('book-say'), 'dialogue keeps its own class');
ok(html.includes('<mark>burned down</mark>'), 'highlights are painted back in');
ok(html.includes('class="who">Mara<'), 'speakers are named');
ok(html.includes('article class="user"'), 'and the reader’s turns are marked');

// Escaping: a story is untrusted text and must not be able to author markup.
const evil = exportStoryHtml(
  walkStory({ ...story, messages: [msg('m1', '<img onerror=x>', 'Hi </div><script>alert(1)</script>')] } as unknown as Story, []),
  { theme: THEMES.dark, typography: TYPE },
).html;
ok(!evil.includes('<script>alert'), 'an injected script is escaped');
ok(evil.includes('&lt;script&gt;'), 'and shows as text');
ok(!evil.includes('<img onerror'), 'a speaker name cannot author a tag');

/* ---- typography: the reader's settings, not the exporter's taste ---- */

const custom = readingStylesheet(THEMES.dark, {
  stack: FONT_STACKS.handwriting, fontSize: 24, contentWidth: 900, paragraphSpacing: false,
});
ok(custom.includes(FONT_STACKS.handwriting), 'the reader’s font stack is used, not a hardcoded serif');
ok(custom.includes('--fs:24px'), 'their type size carries over');
ok(custom.includes('--w:900px'), 'and their column width');
ok(custom.includes('--para:1em'), 'paragraph spacing off means tight paragraphs');
ok(readingStylesheet(THEMES.dark, TYPE).includes('--para:1.35em'), 'and on means airy ones');
ok(readingStylesheet(THEMES.dark, { ...TYPE, contentWidth: 0 }).includes('--w:38rem'),
  'a width of 0 falls back to a comfortable default');

// An embedded face must actually reach the file, or "embed fonts" is a lie.
const embedded = readingStylesheet(THEMES.dark, {
  ...TYPE, faceCss: '@font-face{font-family:"X";src:url(data:font/woff2;base64,AAA)}',
});
ok(embedded.includes('data:font/woff2;base64,AAA'), 'inlined font bytes are in the stylesheet');
ok(!/https?:/.test(embedded), 'and the stylesheet still fetches nothing');

/* ---- layouts ---- */

const chat = exportStoryHtml(walked, { theme: THEMES.dark, typography: TYPE, layout: 'chat' }).html;
ok(chat.includes('data-layout="chat"'), 'the page opens in the chosen layout');
ok(chat.includes('aria-pressed="true"'), 'and the toggle reflects it');
ok(html.includes('data-layout="storybook"'), 'storybook is the default');
// Both layouts ship in one file — the recipient can switch.
ok(html.includes('body[data-layout="chat"]') && html.includes('body[data-layout="storybook"]'),
  'both layouts are styled regardless of which one opens');
ok(html.includes('class="pic"'), 'a portrait (or its fallback initial) is present for chat');

/* ---- the reveal ---- */

ok(html.includes('id="aura-play"'), 'there is a play button');
ok(html.includes('aura-w'), 'and the reveal class it drives');
// The document must be READABLE with no script — the words are not wrapped in
// the file, so text is plain until someone presses play.
ok(!html.includes('<span class="aura-w">'), 'words are wrapped at play time, not baked into the file');
ok(html.includes('prefers-reduced-motion'), 'the reveal honours reduced motion');
const noStream = exportStoryHtml(walked, { theme: THEMES.dark, typography: TYPE, streaming: false }).html;
ok(!noStream.includes('<script>'), 'streaming off ships no script at all');
ok(!noStream.includes('id="aura-bar"'), 'and no control bar');

/* ---- highlights: scoped, and bounded ---- */

// A highlight belongs to one message. Painting it everywhere marked words the
// reader never marked — and made the work grow with (highlights × messages).
const twoMsg = {
  ...story,
  messages: [msg('a1', 'Mara', 'The hearth had burned down.'), msg('a2', 'Mara', 'The hearth again.')],
} as unknown as Story;
const scoped = exportStoryHtml(walkStory(twoMsg, [], {}), {
  theme: THEMES.dark, typography: TYPE,
  highlights: [{ id: 'h', messageId: 'a1', text: 'The hearth', color: 'y', timestamp: 1 }],
}).html;
ok((scoped.match(/<mark>/g) ?? []).length === 1, 'a highlight marks only its own message');

// Older highlights have no messageId; those still match anywhere.
const legacy = exportStoryHtml(walkStory(twoMsg, [], {}), {
  theme: THEMES.dark, typography: TYPE,
  highlights: [{ id: 'h', text: 'The hearth', color: 'y', timestamp: 1 }],
}).html;
ok((legacy.match(/<mark>/g) ?? []).length === 2, 'a highlight with no message id still matches anywhere');

/**
 * THE size property, stated so it cannot be satisfied by accident.
 *
 * Looping per highlight re-scanned the marks the previous pass had inserted, so
 * the document grew with the highlight COUNT rather than with what was actually
 * marked — until V8 refused with "Invalid string length". Holding the marked
 * TEXT constant and multiplying the number of highlight records must therefore
 * change nothing at all.
 */
const bulkStory = {
  ...story,
  messages: Array.from({ length: 40 }, (_, i) => msg(`b${i}`, 'Mara', 'The hearth had burned down to embers. '.repeat(20))),
} as unknown as Story;
const bulkWalk = walkStory(bulkStory, [], {});
const TEXTS = ['The hearth', 'burned down', 'to embers'];
/** Every message gets the same three texts, recorded `copies` times over. */
const sizeWith = (copies: number) => exportStoryHtml(bulkWalk, {
  theme: THEMES.dark, typography: TYPE,
  highlights: Array.from({ length: 40 * TEXTS.length * copies }, (_, i) => ({
    id: `h${i}`, messageId: `b${i % 40}`, color: 'y', timestamp: 1,
    text: TEXTS[i % TEXTS.length],
  })),
}).html.length;
const once = sizeWith(1);
const hundred = sizeWith(100);
ok(once === hundred,
  `100x the same highlights marks the same words and costs the same (${once} vs ${hundred})`);
ok(!exportStoryHtml(bulkWalk, { theme: THEMES.dark, typography: TYPE }).html.includes('<mark>'),
  'no highlights, no marks');

// Overlapping highlights: the longer one wins rather than being cut in half.
const overlap = exportStoryHtml(walkStory(twoMsg, [], {}), {
  theme: THEMES.dark, typography: TYPE,
  highlights: [
    { id: '1', messageId: 'a1', text: 'hearth', color: 'y', timestamp: 1 },
    { id: '2', messageId: 'a1', text: 'The hearth had', color: 'y', timestamp: 1 },
  ],
}).html;
ok(overlap.includes('<mark>The hearth had</mark>'), 'the longest overlapping highlight wins');
ok(!overlap.includes('<mark><mark>'), 'and marks are never nested inside each other');

// Regex metacharacters in a highlight must not become a pattern.
const meta = exportStoryHtml(
  walkStory({ ...story, messages: [msg('c1', 'Mara', 'Cost: $5.00 (a lot).')] } as unknown as Story, []),
  {
    theme: THEMES.dark, typography: TYPE,
    highlights: [{ id: 'h', messageId: 'c1', text: '$5.00 (a lot)', color: 'y', timestamp: 1 }],
  },
).html;
ok(meta.includes('<mark>$5.00 (a lot)</mark>'), 'a highlight with regex metacharacters is matched literally');

/* ---- the cover -----------------------------------------------------------
 *
 * One block of markup with two treatments. The interesting property is not
 * that a cover exists — it is that the page's own layout toggle switches it,
 * so a file opened in Chat mode does not lead with a book's title page. That
 * means BOTH covers must be in the document at once, with CSS choosing.
 */

const AT = Date.parse('2026-08-16T12:00:00Z');
const covered = exportStoryHtml(walked, {
  theme: THEMES.dark, typography: TYPE, exportedAt: AT,
}).html;

ok(covered.includes('<header class="cover">'), 'the export opens on a cover');
ok(covered.indexOf('<header class="cover">') < covered.indexOf('<section class="chapter"'),
  'and the cover comes before the first chapter');
ok(covered.includes('A Night at the Hearth'), 'the cover carries the title');
ok(covered.includes('Mara &amp; You'), 'and the byline');
ok(/3 passages · \d+ words · about \d+ min/.test(covered), 'and what you are in for');
ok(/Exported \w+ \d+, 2026|Exported 2026-08-16/.test(covered), 'and when it was made');
ok(covered.includes('href="#ch1"'), 'the cover links into the story');

// Both wordings ship; CSS picks one. Losing this is how a chat log ends up
// announcing itself as "a story, kept".
ok(covered.includes('class="kicker book-only"') && covered.includes('class="kicker chat-only"'),
  'both covers are in the file, so the layout toggle can switch between them');
ok(covered.includes('Conversation with Mara'), 'the chat treatment names who you were talking to');
const css = readingStylesheet(THEMES.dark, TYPE);
ok(css.includes('.cover .book-only{display:none}')
  && css.includes('body[data-layout="storybook"] .cover .book-only{display:block}'),
  'and CSS is what chooses, per layout');

// The mark: corner of the first page, once, and never in the reading column.
ok(covered.includes('class="aeia"'), 'the Aeia mark is on the cover');
ok(covered.split('class="aeia"').length === 2, 'exactly once — a repeated logo is a watermark');
const markSrc = /<img src="(data:[^"]+)" alt=""/.exec(covered.slice(covered.indexOf('class="aeia"')));
ok(!!markSrc && isSelfContained(markSrc[1]), 'and it is embedded, not linked');
ok(!covered.slice(covered.indexOf('<main>')).includes('aeia'),
  'the mark never appears inside the story itself');

// Opting out gives the old plain header back, and no mark at all.
const bare = exportStoryHtml(walked, { theme: THEMES.dark, typography: TYPE, cover: false }).html;
ok(!bare.includes('<header class="cover">') && bare.includes('<header class="story">'),
  'cover:false falls back to the plain header');
ok(!bare.includes('class="aeia"'), 'and carries no mark');
ok(!bare.includes('<p class="convo-start">'), 'nor the conversation divider');

// A cover must not cost self-containment — the whole point of the format.
ok(!/(src|href)=["'](?!data:|#)/.test(covered), 'the covered page still links nowhere');
ok(!/https?:\/\//.test(covered.replace(/<html lang="en">/, '')), 'and fetches nothing');

// A story with no portrait still gets a plate rather than an empty hole.
const noArt = exportStoryHtml(
  walkStory({ ...story, characterAvatar: undefined, avatar: undefined } as unknown as Story, chains, {}),
  { theme: THEMES.dark, typography: TYPE, exportedAt: AT },
).html;
ok(/<span class="art" style="background:hsl\(/.test(noArt), 'no portrait falls back to a lettered plate');
ok(noArt.includes('>M</span>'), 'lettered with the character initial');

// A remote portrait is dropped, exactly like a remote image in a passage.
const remoteArt = walkStory(
  { ...story, characterAvatar: 'https://example.com/mara.png' } as unknown as Story, chains, {},
);
ok(remoteArt.coverImage === undefined, 'a remote portrait never becomes cover art');

/* ---- the Director's tracks reach the file -----------------------------------
 *
 * The export reproduced the theme, the font, the dialogue styling and the scene
 * mood, and then dropped the two tracks that make a directed passage LOOK
 * directed. A shouted line arrived flat; a swelled word arrived plain.
 * -------------------------------------------------------------------------- */

const SCENES = {
  m1: {
    messageId: 'm1', hash: 'h', mood: 'awe', tension: 0.4,
    emphasis: [{ text: 'hearth', kind: 'shout' }],
    perform: [{ text: 'embers', kind: 'swell' }],
  },
} as never;

const directed = exportStoryHtml(walked, { theme: THEMES.dark, typography: TYPE, scenes: SCENES }).html;
ok(directed.includes('class="expr-shout"'), 'an emphasis cue reaches the exported file');
ok(directed.includes('class="perf-swell"'), 'and so does a performance cue');
ok(directed.includes('.expr-shout{'), 'with the CSS to render it');
ok(directed.includes('.perf-swell{'), 'and the CSS for the other track');
ok(!/https?:\/\//.test(directed), 'and the file still fetches nothing');

// Off when asked, and absent when there is nothing to mark.
const undirected = exportStoryHtml(walked, {
  theme: THEMES.dark, typography: TYPE, scenes: SCENES, sceneMarks: false,
}).html;
ok(!undirected.includes('expr-shout'), 'sceneMarks:false leaves the words plain');
ok(!undirected.includes('.perf-swell{'), 'and ships none of the CSS for it');
ok(!exportStoryHtml(walked, { theme: THEMES.dark, typography: TYPE }).html.includes('perf-swell'),
  'a story the Director never read carries no marks');

/* ---- and so do the reader's OWN marks ---------------------------------------
 *
 * The file carried the Director's read and dropped the reader's marking, which
 * meant the one part of the page that was unmistakably theirs was the part that
 * did not survive being saved.
 * -------------------------------------------------------------------------- */

const marked = exportStoryHtml(walked, {
  theme: THEMES.dark,
  typography: TYPE,
  readerMarks: {
    emphasis: { m1: [{ text: 'burned', kind: 'color', color: 'blue' }] },
    perform: { m1: [{ text: 'hearth', kind: 'tremble' }] },
  },
}).html;
ok(marked.includes('class="expr-color-blue"'), "a hand-marked colour reaches the file");
ok(marked.includes('.expr-color-blue{'), 'with the CSS to render it');
ok(marked.includes('class="perf-tremble"'), 'and a hand-marked direction too');
ok(!/https?:\/\//.test(marked), 'and the file still fetches nothing');

// A cadence run is the one cue whose small words matter, and the export uses the
// same matcher the reader does.
const cadence = exportStoryHtml(walked, {
  theme: THEMES.dark,
  typography: TYPE,
  readerMarks: { perform: { m1: [{ text: 'had burned down', kind: 'stagger' }] } },
}).html;
const staggered = (cadence.match(/class="perf-stagger"/g) ?? []).length;
ok(staggered === 3, `every word of a cadence run is marked in the file (got ${staggered})`);
ok(cadence.includes('pRunTell'), 'and the tell that says the pause was meant');

// The stoplist and the fire-once rule come along with the scanner: a cue names
// a span but is matched per word, so neither may be lost in the export path.
const flood = exportStoryHtml(
  walkStory({ ...story, messages: [msg('m1', 'Mara', 'the hearth and the hearth and the hearth')] } as unknown as Story, []),
  {
    theme: THEMES.dark, typography: TYPE,
    scenes: { m1: { messageId: 'm1', hash: 'h', mood: 'awe', tension: 0.4, emphasis: [{ text: 'the hearth', kind: 'shout' }] } } as never,
  },
).html;
// Counted in the BODY: the stylesheet also names the class.
const floodBody = flood.slice(flood.indexOf('<main>'));
ok((floodBody.match(/class="expr-shout"/g) ?? []).length === 1, 'one mark stays one mark');
ok(!/class="expr-shout">the</.test(flood), 'and "the" is never dressed as a shout');

/* ---- the stylesheet ---- */

for (const id of ['dark', 'light', 'sepia', 'terminal', 'book'] as const) {
  const css = readingStylesheet(THEMES[id], TYPE);
  ok(css.includes(THEMES[id].vars.bg), `${id}: its background colour is baked in`);
  ok(!/https?:/.test(css), `${id}: its stylesheet fetches nothing`);
}
ok(readingStylesheet(THEMES.dark, TYPE, '#ff0000').includes('#ff0000'), 'an accent override wins');
ok(readingStylesheet(THEMES.dark, TYPE).includes('@media print'), 'it is printable');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
