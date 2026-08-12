/**
 * Run: npx tsx src/utils/sceneQuality.test.ts
 * Pure checks for the scene critic (no network).
 *
 * A note on what these prove. The composed floor scores 100 because it was
 * written to satisfy this critic — that is circular by construction and only
 * shows the two agree. What the critic is really for is ORDERING: a placeholder
 * must score far below a designed shot, the notes must name a fixable thing,
 * and the same stylesheet must always score the same. Those are the properties
 * tested here; whether the accepted scenes are beautiful is a question for the
 * live harness and the reader's eyes, not for a regex.
 */
import { heuristicPacket } from './stylePacket';
import { ACCEPT_SCORE, REPAIRABLE_SCORE, repairNotes, scoreScene, usesColor } from './sceneQuality';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };

const packet = heuristicPacket('hard-boiled detective'); // → noir, motion 'drift'
const { bg, ink, accent, glow } = packet.palette;

/** A stylesheet that does everything the brief asks. */
const goodCss =
  `body{background:radial-gradient(80% 60% at 50% 110%, ${glow} 0%, transparent 60%),`
  + `linear-gradient(168deg, ${bg} 0%, #101216 100%);color:${ink};`
  + `font-family:"Times New Roman", Times, serif;overflow:hidden;margin:0;min-height:100vh}`
  + `body::after{content:"";position:absolute;inset:0;box-shadow:inset 0 0 20vmin 6vmin rgba(0,0,0,.7)}`
  + `.card{display:flex;flex-direction:column;justify-content:center;padding:4vw;min-height:100vh}`
  + `.who{color:${accent};letter-spacing:.28em;text-transform:uppercase;font-weight:300;font-size:.72rem}`
  + `.body{font-size:clamp(1.2rem,2.2vw,1.6rem);font-weight:800;line-height:1.5;max-width:46ch;letter-spacing:.02em}`
  + `body::before{content:"";position:absolute;inset:0;animation:drift 20s ease-in-out infinite alternate}`
  + `@keyframes drift{from{opacity:.8}to{opacity:1}}`
  + `@media (prefers-reduced-motion:reduce){body::before{animation:none}}`;

/* ---- ordering: the whole point ---- */

const good = scoreScene(goodCss, packet, 260);
const weak = scoreScene('.card{background:#111;color:#eee;padding:2rem}', packet, 260);
ok(good.score >= ACCEPT_SCORE, `a composed shot clears the bar (got ${good.score}): ${good.failures.join('; ')}`);
ok(weak.score < REPAIRABLE_SCORE, `a placeholder falls below the floor (got ${weak.score})`);
ok(good.score - weak.score > 40, 'the gap between the two is decisive, not marginal');
ok(!good.fatal && !weak.fatal, 'neither is structurally fatal');

/* ---- determinism ---- */

ok(scoreScene(goodCss, packet, 260).score === good.score, 'the same sheet always scores the same');

/* ---- each check earns its keep ---- */

const drop = (css: string, name: string) => {
  const s = scoreScene(css, packet, 260);
  ok(s.score < good.score, `${name} costs points`);
  ok(s.failures.some(f => f.length > 20), `${name} produces a usable note`);
  return s;
};

// Flat fill instead of layered light.
drop(goodCss.replace(/radial-gradient[^,]+,[^;]+;/, `background:${bg};`), 'a flat backdrop');
// The packet's palette ignored entirely.
drop(goodCss.replace(new RegExp(accent, 'g'), '#888888').replace(new RegExp(glow, 'g'), '#777777')
  .replace(new RegExp(bg, 'g'), '#222222').replace(new RegExp(ink, 'g'), '#dddddd'), 'an ignored palette');
// No depth.
drop(goodCss.replace(/body::after\{[^}]*\}/, ''), 'no vignette');
// No motion when the packet asked for drift.
drop(goodCss.replace(/@keyframes drift\{[^}]*\}/, '').replace(/animation:[^;}]*/g, ''), 'a static frame under a drift packet');

/* ---- motion is binding in BOTH directions ---- */

const stillPacket = heuristicPacket('storybook'); // motion: 'still'
const stillGood = scoreScene(goodCss.replace(/animation:[^;}]*infinite[^;}]*/, 'opacity:.9'), stillPacket, 260);
const stillLoop = scoreScene(goodCss, stillPacket, 260);
ok(stillGood.score > stillLoop.score, 'an ambient loop is penalised when the packet says still');

/* ---- fit: the ways a scene escapes the stage ---- */

const fits = (css: string) => scoreScene(css, packet, 260).checks.find(c => c.name === 'fit')!.got;
ok(fits(goodCss) === 20, 'a well-behaved sheet loses no fit points');
ok(fits(goodCss + '.x{position:fixed}') < 20, 'position:fixed is penalised');
ok(fits(goodCss + '.x{width:180vw}') < 20, 'an over-100 viewport unit is penalised');
ok(fits(goodCss + '.x{width:1600px}') < 20, 'a fixed width wider than the frame is penalised');
ok(fits(goodCss + '.tiny{font-size:9px}') < 20, 'sub-readable text is penalised');
ok(fits(goodCss + '.x{width:80vw}') === 20, 'a legal viewport width is fine');

// Hiding the words is fatal — no repair can save a scene with nothing in it.
const hidden = scoreScene(goodCss + '.body{display:none}', packet, 260);
ok(hidden.fatal, 'hiding .body is fatal');
ok(hidden.checks.find(c => c.name === 'fit')!.got === 0, 'hiding .body zeroes the fit check');

/* ---- typography is judged against what the shot has to show ---- */

const heroCss = goodCss.replace(/max-width:46ch;/, '');
ok(scoreScene(heroCss, packet, 40).checks.find(c => c.name === 'typography')!.got >= 9,
  'a hero line is judged on its type scale, not on a column width');
const paraNoColumn = goodCss.replace(/max-width:46ch;/, '').replace(/line-height:1\.5;/, '');
ok(scoreScene(paraNoColumn, packet, 900).checks.find(c => c.name === 'typography')!.got
  < scoreScene(goodCss, packet, 900).checks.find(c => c.name === 'typography')!.got,
  'a paragraph without a readable column loses typography points');

/* ---- structurally unusable input ---- */

for (const junk of ['', '   ', 'I am sorry, I cannot do that.', '.a{}']) {
  const s = scoreScene(junk, packet, 260);
  ok(s.score === 0 && s.fatal, `junk input is fatal: ${JSON.stringify(junk.slice(0, 20))}`);
}

/* ---- colour detection handles both notations ---- */

ok(usesColor('.a{color:#C9A227}', '#c9a227'), 'hex is detected case-insensitively');
ok(usesColor('.a{color:rgba(201, 162, 39, .4)}', '#c9a227'), 'the rgba() form of the same colour is detected');
ok(usesColor('.a{color:rgb(201,162,39)}', '#c9a227'), 'the rgb() form is detected');
ok(!usesColor('.a{color:#c9a228}', '#c9a227'), 'a near-miss colour is not counted');
ok(!usesColor('.a{color:rgba(201,162,3,.4)}', '#c9a227'), 'a prefix-matching triplet is not counted');

/* ---- the repair note is a correction, not a re-roll ---- */

const notes = repairNotes(weak);
ok(notes.includes(String(weak.score)), 'the repair quotes the score it has to beat');
ok(notes.includes(accent), 'the repair names the exact colours to use');
ok(/^\d+\./m.test(notes), 'the repair is an enumerated list of specific fixes');
ok(!/try again|be better|more creative/i.test(notes), 'the repair never just asks for another sample');

// Notes are ordered by how much they cost, so a truncated list still leads with
// the thing most worth fixing. (`checks` keeps declaration order; `failures` is
// the ranked view — this asserts the ranking, not the declaration order.)
const lossOf = (note: string) => {
  const c = weak.checks.find(x => x.note === note)!;
  return c.max - c.got;
};
const ranked = weak.failures.map(lossOf);
ok(ranked.length >= 3 && ranked.every((n, i) => i === 0 || ranked[i - 1] >= n),
  `failures are ordered worst-first (got ${ranked.join(' > ')})`);

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
