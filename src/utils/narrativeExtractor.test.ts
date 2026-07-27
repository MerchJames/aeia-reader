/**
 * Run: npx tsx src/utils/narrativeExtractor.test.ts
 * Pure checks for the narrative extractor (compromise, no network).
 */
import { extract, entitySet, buildGrounding, fidelity } from './narrativeExtractor';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };

const text = 'Captain Mira gripped the old revolver. "Don\'t freeze now," Jun whispered. She would not open the door.';
const ex = extract(text);

// Entities: compromise finds Mira; the rule layer catches Jun (which compromise
// mistags as a month) via the capitalisation heuristic.
ok(ex.people.map(p => p.toLowerCase()).some(p => p.includes('mira')), 'people include Mira');
ok(entitySet(ex).map(p => p.toLowerCase()).some(p => p.includes('jun')), 'entitySet catches Jun (rule layer)');

// Verbs come back as an event spine (infinitive lemmas).
ok(ex.verbs.map(v => v.toLowerCase()).includes('grip'), 'verb spine has grip (lemmatised)');
ok(ex.verbs.map(v => v.toLowerCase()).some(v => v.includes('whisper')), 'verb spine has whisper');

// Descriptors + pronouns.
ok(ex.adjectives.map(a => a.toLowerCase()).includes('old'), 'adjectives include old');
ok(ex.pronouns.includes('she'), 'pronouns include she (lowercased)');

// Dialogue is captured verbatim.
ok(ex.quotes.some(q => q.includes("Don't freeze now")), 'quote captured verbatim');
ok(ex.stats.dialogueRatio > 0 && ex.stats.dialogueRatio <= 1, 'dialogue ratio in (0,1]');
ok(ex.stats.sentences >= 2, 'counts multiple sentences');

// Highlight terms carry offsets that actually index the source text.
const t0 = ex.terms.find(t => t.text === 'Mira');
ok(!!t0 && text.slice(t0.start, t0.start + t0.length) === 'Mira', 'term offset indexes the source');
ok(!!t0 && t0.pos === 'proper', 'Mira classified as proper');
ok(ex.terms.some(t => t.pos === 'verb'), 'some term classified verb');

// entitySet + grounding.
const es = entitySet(ex);
ok(es.some(e => e.toLowerCase().includes('mira')) && es.some(e => e.toLowerCase().includes('jun')), 'entitySet merges Mira + Jun');
const g = buildGrounding(ex);
ok(/Mira/.test(g) && /keep/i.test(g), 'grounding lists entities to keep');
ok(/spine/i.test(g), 'grounding states the event spine');

// Fidelity: a faithful paraphrase keeps entities; a drift is flagged.
const faithful = 'Mira held the ancient pistol. "Stay calm," Jun murmured. She refused to open the door.';
const f1 = fidelity(text, faithful);
ok(f1.kept.some(k => k.toLowerCase().includes('mira')) && f1.kept.some(k => k.toLowerCase().includes('jun')), 'faithful rewrite keeps Mira + Jun');

const drift = 'Sarah grabbed the sword. The dragon roared outside.';
const f2 = fidelity(text, drift);
ok(f2.dropped.some(d => d.toLowerCase().includes('mira')), 'drift flags dropped Mira');
ok(!!f2.warning && f2.ok === false, 'drift produces a warning + ok=false');

// Empty input never throws.
ok(extract('').terms.length === 0 && extract('').stats.sentences >= 1, 'empty input is safe');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
