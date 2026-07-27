/**
 * Run: npx tsx src/utils/narrativeDirector.test.ts
 * Pure checks for the refinement prompt build + reply parsing (no network).
 */
import { buildRefineMessages, modeBrief, parseRefinement } from './narrativeDirector';
import { extract, buildGrounding } from './narrativeExtractor';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };

// Briefs say what each mode may change.
ok(/style of Cormac McCarthy/i.test(modeBrief('restyle', 'Cormac McCarthy')), 'restyle brief names the author');
ok(/grammar/i.test(modeBrief('grammar')), 'grammar brief mentions grammar');
ok(/tighten/i.test(modeBrief('tighten')), 'tighten brief mentions tightening');
ok(modeBrief('custom', 'make it funnier') === 'make it funnier', 'custom brief passes the instruction through');

// The prompt carries the source-sacred rules, the grounding, and the passage.
const text = 'Captain Mira gripped the old revolver. She would not open the door.';
const grounding = buildGrounding(extract(text));
const msgs = buildRefineMessages({ text, mode: 'restyle', target: 'Hemingway', grounding });
ok(/ONLY the rewritten/i.test(msgs[0].content) && /spelled EXACTLY/i.test(msgs[0].content), 'system forbids drift + demands prose-only');
ok(msgs[1].content.includes('Hemingway') && msgs[1].content.includes(text), 'user carries target + passage');
ok(msgs[1].content.includes('Mira'), 'user carries the grounding constraints');

// Parsing peels fences, preambles, and wrapping quotes; keeps the prose.
ok(parseRefinement('Here is the rewrite:\nMira held the pistol.') === 'Mira held the pistol.', 'strips a leading preamble line');
ok(parseRefinement('```\nMira held the pistol.\n```') === 'Mira held the pistol.', 'unwraps a stray code fence');
ok(parseRefinement('"Mira held the pistol."') === 'Mira held the pistol.', 'peels whole-text wrapping quotes');
ok(parseRefinement('<think>plan</think>\nMira held the pistol.') === 'Mira held the pistol.', 'drops reasoning block');
ok(parseRefinement('   ') === null, 'blank reply → null (keep original)');
// A quoted line of dialogue is NOT mistaken for a wrapping quote when it stands alone.
ok(parseRefinement('"Don\'t," she said.') === '"Don\'t," she said.', 'dialogue-only line is left intact');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
