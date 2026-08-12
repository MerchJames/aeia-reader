/**
 * Run: npx tsx src/utils/sandboxTheme.test.ts
 * Pure checks for the Sandbox heuristic floor — no DOM, no AI.
 */
import {
  buildDoc, buildSpeakerMap, colorForHue, contrastRatio, escapeHtml, formatBody,
  hashHue, parseColor, speakerColor, splitSpeakers, ThemeVars,
} from './sandboxTheme';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };

const DARK = '#1e293b';
const LIGHT = '#f8fafc';
const vars: ThemeVars = { bg: '#0f172a', surface: DARK, text: '#d1d5db', border: '#3f3f46', accent: '#8b5cf6' };

// hashHue is deterministic and in range.
ok(hashHue('Mara') === hashHue('mara'), 'hashHue is case-insensitive/stable');
ok(hashHue('Mara') >= 0 && hashHue('Mara') < 360, 'hashHue in [0,360)');

// speakerColor is deterministic per name.
ok(speakerColor('Mara', DARK) === speakerColor('Mara', DARK), 'speakerColor deterministic');
ok(speakerColor('Mara', DARK) !== speakerColor('Kael', DARK), 'different speakers differ (usually)');

// Contrast clamp: every color clears WCAG AA (4.5:1) against the surface.
const surfDark = parseColor(DARK)!;
const surfLight = parseColor(LIGHT)!;
for (const name of ['Mara', 'Kael', 'Bo', 'Seraphina', 'X', 'the narrator']) {
  const cD = parseColor(speakerColor(name, DARK))!;
  ok(contrastRatio(cD, surfDark) >= 4.5, `contrast>=4.5 on dark for ${name}`);
  const cL = parseColor(speakerColor(name, LIGHT))!;
  ok(contrastRatio(cL, surfLight) >= 4.5, `contrast>=4.5 on light for ${name}`);
}

// colorForHue clears AA for a sweep of hues.
for (let h = 0; h < 360; h += 30) {
  ok(contrastRatio(parseColor(colorForHue(h, DARK))!, surfDark) >= 4.5, `hue ${h} readable on dark`);
}

// Composite labels split and each gets a color.
ok(JSON.stringify(splitSpeakers('Alice & Bob')) === JSON.stringify(['Alice', 'Bob']), 'split &');
ok(JSON.stringify(splitSpeakers('Alice/Bob')) === JSON.stringify(['Alice', 'Bob']), 'split /');
ok(JSON.stringify(splitSpeakers('Alice and Bob')) === JSON.stringify(['Alice', 'Bob']), 'split and');

// buildSpeakerMap keys every distinct speaker (composites expanded).
const map = buildSpeakerMap(['Mara', 'Kael & Mara', 'kael'], DARK);
ok(Object.keys(map).sort().join(',') === 'kael,mara', 'map dedupes to distinct lowercased speakers');

// Escaping: source text can never break out into markup.
ok(escapeHtml('<script>x</script>') === '&lt;script&gt;x&lt;/script&gt;', 'escapeHtml neutralizes tags');
const evil = formatBody('He said </div><script>alert(1)</script>');
ok(!evil.includes('<script>') && evil.includes('&lt;script&gt;'), 'formatBody keeps injected script inert');

// formatBody: paragraphs + quote wrap.
const fb = formatBody('Line one.\n\n"Hello," she said.');
ok((fb.match(/<p>/g) || []).length === 2, 'blank line splits paragraphs');
ok(fb.includes('<span class="say">'), 'quoted speech wrapped');

// buildDoc: verbatim body present, our reporter present, injected script inert.
const doc = buildDoc({ name: 'Mara', isUser: false, content: 'A quiet <b>room</b>.', color: '#7cc', vars, index: 0 });
ok(doc.includes('A quiet &lt;b&gt;room&lt;/b&gt;.'), 'buildDoc slots escaped verbatim text');
ok(doc.includes('aura-sandbox-h'), 'buildDoc includes the trusted height reporter');
ok(doc.includes("default-src 'none'"), 'buildDoc has a no-network CSP');
ok(doc.includes('>Mara<'), 'buildDoc labels the speaker');

// buildDoc exposes theme vars + a live-updatable body target.
ok(doc.includes('--who:'), 'buildDoc exposes --who css var');
ok(doc.includes('id="aura-body"'), 'buildDoc has a live-updatable body target');
ok(doc.includes('aura-sandbox-set'), 'buildDoc runtime accepts live body swaps');

// buildDoc with a treatment: the AI css is used and the heuristic card is dropped.
const treated = buildDoc({
  name: 'Mara', isUser: false, content: 'hi', color: '#7cc', vars, index: 0,
  treatment: { css: '.card{background:papayawhip}' },
});
ok(treated.includes('.card{background:papayawhip}'), 'treatment css is injected');
ok(!treated.includes('sandboxIn'), 'treatment drops the heuristic card animation');

// buildDoc with a skeleton: placeholders slot escaped verbatim text, never words.
const skel = buildDoc({
  name: 'Mara', isUser: false, content: 'A <secret>', color: '#7cc', vars, index: 3,
  treatment: { css: '.note{}', skeleton: '<b class="who">{{speaker}}</b><div class="note">{{body}}</div>' },
});
ok(skel.includes('<b class="who">Mara</b>'), 'skeleton {{speaker}} filled');
ok(skel.includes('id="aura-body"') && skel.includes('A &lt;secret&gt;'), 'skeleton {{body}} slots escaped text');

// A *view* is just buildDoc with fullFrame — one message fills the viewport,
// its body live-updatable (streaming) via the same runtime, verbatim text slotted.
const view = buildDoc({
  name: 'Mara', isUser: false, content: 'A quiet <room>.', color: '#7cc', vars, index: 0,
  treatment: { css: 'body{background:#000}' }, fullFrame: true,
});
ok(/min-height:100vh/.test(view), 'fullFrame makes the card fill the viewport');
ok(/overflow:hidden!important/.test(view) && /max-height:100vh!important/.test(view),
  'fullFrame locks the page + caps the stage so a scene cannot leak off-screen');
ok(view.indexOf('body{background:#000}') < view.indexOf('overflow:hidden!important'),
  'containment is appended AFTER the AI css so it wins');
ok(/\.card \*\{max-width:100%/.test(view),
  'fullFrame caps every stage descendant so a scene child cannot outgrow the frame');
// …but NOT with !important. That forced every descendant to exactly 100% and
// discarded any narrower value, so no scene could hold a readable text column —
// a paragraph ran the full width of the frame however the stylesheet was written.
// Containment still holds: the page is clamped and `.card` clips and scrolls.
ok(!/\.card \*\{max-width:100%!important/.test(view),
  'the descendant cap does not override a scene’s own narrower column');
ok(/\.card\{max-height:100vh!important;max-width:100vw!important;overflow:auto!important\}/.test(view),
  'the stage itself still clips and scrolls, which is what actually contains a scene');
ok(view.includes('function tail(') && view.includes('r();tail();'),
  'runtime scrolls the reveal edge into view after each live body swap');
ok(view.includes('A quiet &lt;room&gt;.') && view.includes('id="aura-body"'), 'view slots escaped verbatim text into the live body');
ok(view.includes('aura-sandbox-set'), 'view body can be live-swapped (streaming)');
ok(!buildDoc({ name: 'A', isUser: false, content: 'hi', color: '#7cc', vars, index: 0 }).includes('min-height:100vh'),
  'no fullFrame → no viewport override');

// forceText makes the reader's --text win over an AI body colour.
const forced = buildDoc({ name: 'A', isUser: false, content: 'hi', color: '#7cc', vars, index: 0,
  treatment: { css: 'body{color:#123}' }, forceText: true });
ok(/body\{color:var\(--text\)!important\}/.test(forced), 'forceText appends an !important text colour');
ok(!buildDoc({ name: 'A', isUser: false, content: 'hi', color: '#7cc', vars, index: 0 }).includes('var(--text)!important'),
  'no forceText → no override rule');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
