/**
 * Run: npx tsx src/utils/visitor.test.ts
 *
 * Bringing a character in from another chat.
 *
 * The naive version — paste the visitor's transcript into the host's context —
 * fails in a way no amount of prompting fixes: nothing in a transcript states
 * that these two have NEVER MET, so the model assumes they have and invents the
 * occasion. The absence is not in the payload, so the model cannot honour it.
 *
 * A dossier puts the absence IN the payload. Two lines do that work —
 * `WHAT THEY DO NOT KNOW` and the flat statement about whether they have met —
 * and both are asserted here, because losing either would not break a single
 * other test while quietly ruining the feature.
 *
 * The other property worth pinning is the spoiler clamp, inherited from
 * `askCharacter.clampHistory`: a dossier is "them as of message N", and an
 * unknown anchor must yield a character who knows nothing rather than one who
 * has read their own ending.
 */
import type { Message } from '../types';
import {
  DOSSIER_FIELDS, buildDossier, buildDossierMessages, emptyFields, historyFrom, isUsable,
  buildVisitorAskMessages, parseDossier, visitorBlock, visitorsToPromptBlock, type Visitor,
} from './visitor';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (a === b) pass++;
  else { fail++; console.error('✗', msg, `\n    got ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

const msg = (id: string, name: string, content: string, extra: Record<string, unknown> = {}): Message =>
  ({ id, name, role: name === 'You' ? 'user' : 'ai', content, ...extra }) as Message;

const MARA_STORY: Message[] = [
  msg('a1', 'Mara', 'The inn at the crossroads had been hers for nine years.'),
  msg('a2', 'You', 'I ask her about the road east.'),
  msg('a3', 'Mara', '"Nobody takes the east road now," she said. "Not since the bridge."'),
  msg('a4', 'Mara', 'A hidden note.', { hidden: true }),
  msg('a5', 'Mara', 'That winter the soldiers came, and she learned what the bridge had been for.'),
];

const ANSWER = [
  'WHO: Mara keeps the inn at the crossroads and has for nine years. She counts every coin twice and trusts nobody she has not fed.',
  'WHERE: Snowed in at her own inn, with soldiers on the road.',
  'WANTS: To get through the winter without losing the inn.',
  'FEARS: That the soldiers will not leave.',
  'KNOWS: The east road is closed; the bridge was destroyed deliberately; soldiers arrived that winter',
  'DOESNOTKNOW: She has never left the crossroads; she does not know who ordered the bridge destroyed; she has never heard of any other town',
  'VOICE: Short, flat sentences, and she answers questions with questions.',
  'QUOTE: Nobody takes the east road now.',
  'QUOTE: Not since the bridge.',
].join('\n');

/* ---- parsing the model's answer ---- */

const parsed = parseDossier(ANSWER);
ok(parsed.fields.who.startsWith('Mara keeps the inn'), 'WHO is read');
eq(parsed.fields.wants, 'To get through the winter without losing the inn.', 'WANTS is read');
ok(parsed.fields.doesNotKnow.includes('never left the crossroads'), 'DOESNOTKNOW is read');
eq(parsed.quotes.length, 2, 'both quotes are kept');
eq(parsed.quotes[0], 'Nobody takes the east road now.', 'verbatim');

// Models dress their answers. None of these should cost the reader a retry.
const messy = parseDossier('```\n**WHO:** Someone.\n- DOES NOT KNOW: nothing about the sea\n```');
eq(messy.fields.who, 'Someone.', 'code fences and bold labels are tolerated');
ok(messy.fields.doesNotKnow.includes('sea'), 'a spaced-out DOES NOT KNOW label is tolerated');

eq(parseDossier('I would be happy to help!').fields.who, '', 'a refusal parses to nothing');
ok(!isUsable(parseDossier('I would be happy to help!').fields), 'and is reported as unusable');
ok(!isUsable({ ...emptyFields(), who: 'Someone.' }), 'a brief with no negative space is NOT usable');
ok(isUsable(parsed.fields), 'a complete one is');
// Several quotes, because the VOICE line describes how they talk and the
// quotes are the only place a model can actually hear it.
ok(parseDossier(Array.from({ length: 20 }, (_, i) => `QUOTE: line ${i}`).join('\n')).quotes.length === 8,
  'up to eight quotes are kept, and no more');

/* ---- the prompt the dossier is written from ---- */

const input = {
  characterName: 'Mara',
  storyTitle: 'The Crossroads',
  userName: 'You',
  messages: historyFrom(MARA_STORY),
  anchorMessageId: 'a3',
  hostName: 'Ilex',
};

eq(historyFrom(MARA_STORY).length, 4, 'hidden messages are not part of a visitor’s history');

const built = buildDossierMessages(input);
ok(built[1].content.includes('crossroads had been hers'), 'the visitor’s own story is the source');
ok(built[1].content.includes('east road'), 'up to and including the anchor');

// THE clamp: a dossier written at message 3 must not know about message 5.
ok(!built[1].content.includes('soldiers came'),
  'nothing past the anchor reaches the brief — a visitor cannot know their own ending');

ok(built[1].content.includes('Ilex'), 'the brief is written for the meeting it is for');
ok(/DOESNOTKNOW is the most important line/i.test(built[0].content),
  'the model is told which line matters most');
ok(/Invent nothing/i.test(built[0].content), 'and told not to invent');
ok(/third person/i.test(built[0].content), 'and to write ABOUT them, not AS them');

// Fails closed, exactly like clampHistory: an anchor that is not there yields a
// character who knows nothing, not one who knows everything.
const unknownAnchor = buildDossierMessages({ ...input, anchorMessageId: 'nope' });
ok(!unknownAnchor[1].content.includes('crossroads had been hers'),
  'an unknown anchor yields NO transcript, rather than all of it');
ok(unknownAnchor[1].content.includes('no transcript available'), 'and says so');

/* ---- generating ---- */

const generated = await buildDossier(input, async () => ANSWER);
ok(generated.fields.who.length > 0 && generated.quotes.length === 2, 'a good answer becomes a dossier');

let threw = '';
try { await buildDossier(input, async () => 'Sure! Here you go.'); } catch (e) { threw = (e as Error).message; }
ok(/usable brief/.test(threw),
  'an unusable answer throws — an empty brief in a prompt looks authoritative and says nothing');

/* ---- the block that reaches the host ---- */

const mara: Visitor = {
  id: 'v1',
  name: 'Mara',
  sourceStoryId: 's-crossroads',
  sourceStoryTitle: 'The Crossroads',
  anchorMessageId: 'a3',
  anchorBeat: 56,
  fields: parsed.fields,
  quotes: parsed.quotes,
  met: false,
  active: true,
  createdAt: 1,
};

const block = visitorBlock(mara, 'Ilex');

// The two lines the whole design rests on.
ok(block.includes('WHAT THEY DO NOT KNOW:'), 'the negative space is a labelled line in the payload');
ok(/MARA AND ILEX HAVE NEVER MET/i.test(block), 'and it states outright that they have never met');
ok(/Do not invent one/i.test(block), 'and forbids inventing a history');

ok(block.includes('as of their message 56'), 'the snapshot says WHEN it is from');
ok(block.includes('from another story'), 'and that it is from elsewhere');
ok(block.includes('"Nobody takes the east road now."'), 'verbatim lines travel, so the host can hear them');
ok(block.startsWith('=== VISITOR: Mara') && block.trimEnd().endsWith('=== END VISITOR: Mara ==='),
  'the brief is fenced, so it cannot be read as part of the story');

// Two who HAVE met is a real case and must read as the opposite.
const metBlock = visitorBlock({ ...mara, met: true }, 'Ilex');
ok(/HAVE MET BEFORE/i.test(metBlock) && !/NEVER MET/i.test(metBlock), 'met: true says so, and only so');

// The reader's own note is the escape hatch for everything the model got wrong.
ok(visitorBlock({ ...mara, note: 'She is lying about the bridge.' }, 'Ilex').includes('She is lying'),
  'the reader’s note reaches the prompt verbatim');

/* ---- assembling all visitors ---- */

const all = visitorsToPromptBlock([mara, { ...mara, id: 'v2', name: 'Sable' }], 'Ilex');
ok(all.includes('Mara') && all.includes('Sable'), 'several visitors can travel at once');
// Normalised, because the header is wrapped for readability in the source.
ok(/if a brief does not say it, it did not happen/i.test(all.replace(/\s+/g, ' ')),
  'the header closes the world: no brief, no fact');

eq(visitorsToPromptBlock([], 'Ilex'), '', 'no visitors means no block at all');
eq(visitorsToPromptBlock(undefined, 'Ilex'), '', 'and neither does an absent slice');
eq(visitorsToPromptBlock([{ ...mara, active: false }], 'Ilex'), '',
  'an inactive visitor is not in the payload');
eq(visitorsToPromptBlock([{ ...mara, fields: emptyFields() }], 'Ilex'), '',
  'and neither is an empty brief');

// Size: this rides along with every request, so it has to stay small.
ok(block.length < 2500, `one visitor block is compact (${block.length} chars)`);

// Every field is either rendered or deliberately absent — a field added to the
// type and forgotten here would silently never reach the model.
for (const f of DOSSIER_FIELDS) {
  const only = visitorBlock({ ...mara, fields: { ...emptyFields(), [f]: `MARKER_${f}` } }, 'Ilex');
  ok(only.includes(`MARKER_${f}`), `the ${f} field reaches the prompt`);
}

/* ---- letting them speak ----------------------------------------------------
 *
 * The second stage, and it lives in Ask Character: a character answering in
 * their own voice is what that panel is, and it already has the two things that
 * make it safe — an anchor and a knowledge clamp.
 *
 * Everything above keeps the HOST from inventing a shared history. This keeps
 * the VISITOR from doing it, which is the harder direction: a model writing AS
 * someone is far more willing to remember things. The structural point is that
 * a cast member knows the story because they lived it, while a visitor knows
 * their OWN story from the brief and has only just walked into this one —
 * handing them the host transcript as memory would make them a cast member with
 * amnesia.
 */

const HOST_SCENE = [
  { id: 'h1', name: 'Ilex', content: 'The market had emptied early, and Ilex was still counting.' },
  { id: 'h2', name: 'You', content: 'I ask what the soldiers wanted.' },
  { id: 'h3', name: 'Ilex', content: '"Nothing they said out loud," Ilex answered.' },
];

const turn = buildVisitorAskMessages({
  visitor: mara,
  card: undefined,
  hostTitle: 'The Salt Road',
  hostCharacter: 'Ilex',
  hostUser: 'You',
  scene: HOST_SCENE,
  anchorText: HOST_SCENE[2].content,
  turns: [],
  question: 'What do you make of this place?',
});

ok(turn[0].content.startsWith('You are Mara.'), 'the model is asked to BE them');
ok(turn[0].content.includes('=== VISITOR: Mara'), 'and is given the vetted brief, whole');
ok(/INTERVIEWED, out of scene/i.test(turn[0].content),
  'in the interview frame, not the continue-the-story frame');

// The brief is the ONLY source for their own story. The panel promises the
// reader that nothing but what they can see and edit is sent.
ok(!turn[0].content.includes('crossroads had been hers'),
  'the visitor\u2019s original TRANSCRIPT is never sent \u2014 only the brief and the card');
ok(/answer from the brief above and/i.test(turn[0].content.replace(/\s+/g, ' ')),
  'and told to answer about their own story from the brief alone');

// The direction that actually goes wrong: a model writing AS someone will
// happily remember meeting people it has never met.
ok(/never met anyone here/i.test(turn[0].content),
  'a stranger is told outright that they are a stranger');
ok(/do not refer to a shared past/i.test(turn[0].content), 'and what that means concretely');

// The host story is a scene they WALKED INTO, not memory. Framing it as
// "everything you know" would make them a cast member with amnesia.
ok(/SCENE YOU HAVE WALKED INTO/i.test(turn[1].content), 'the host story is framed as arrival');
ok(turn[1].content.includes('market had emptied'), 'and it is what they react to');
ok(/only just got here/i.test(turn[0].content),
  'with an instruction for what to say when asked beyond it');
ok(turn[0].content.includes('The Salt Road'), 'the host story is named');
ok(/NOT You\b/.test(turn[0].content), 'and the reader is distinguished from the persona');

// The card is how they SOUND; the brief is what they KNOW. The brief alone
// produced characters who were factually right and generically voiced.
const withCard = buildVisitorAskMessages({
  visitor: mara, hostTitle: 'x', hostCharacter: 'Ilex', scene: HOST_SCENE,
  anchorText: 'x', turns: [], question: 'hi',
  card: { name: 'Mara', description: 'She never finishes a sentence she can end with a look.' } as never,
});
ok(withCard[0].content.includes('never finishes a sentence'), 'the card travels when it is on');
ok(!turn[0].content.includes('never finishes a sentence'), 'and not when it is off');

// The entrance gives the interview its footing.
const arriving = buildVisitorAskMessages({
  visitor: { ...mara, entrance: 'she comes in out of the rain and does not sit down' },
  hostTitle: 'x', scene: HOST_SCENE, anchorText: 'x', turns: [], question: 'hi',
});
ok(arriving[0].content.includes('out of the rain'), 'a chosen entrance reaches the model');

// Someone who HAS met them must not be told they are a stranger.
const met = buildVisitorAskMessages({
  visitor: { ...mara, met: true }, hostTitle: 'x', hostCharacter: 'Ilex',
  scene: HOST_SCENE, anchorText: 'x', turns: [], question: 'hi',
});
ok(!/never met anyone here/i.test(met[0].content),
  'a visitor who HAS met them is not written as a stranger');

// The thread replays, with other voices attributed rather than put in this
// one\u2019s mouth \u2014 the same discipline the host interview uses.
const replayed = buildVisitorAskMessages({
  visitor: mara, hostTitle: 'x', scene: HOST_SCENE, anchorText: 'x', question: 'and now?',
  turns: [
    { id: 't1', role: 'reader', text: 'first question', at: 1, speaker: 'Mara' },
    { id: 't2', role: 'character', text: 'Mara answered this.', at: 2, speaker: 'Mara' },
    { id: 't3', role: 'character', text: 'Ilex answered that.', at: 3, speaker: 'Ilex' },
  ] as never,
});
ok(replayed.some(m => m.role === 'assistant' && m.content === 'Mara answered this.'),
  'their own prior answers come back as theirs');
ok(replayed.some(m => m.role === 'user' && /\[Ilex, asked the same thing/.test(m.content)),
  'and another voice is handed over attributed, not put in their mouth');
ok(replayed[replayed.length - 1].content === 'and now?', 'the question is last');

const noScene = buildVisitorAskMessages({
  visitor: mara, hostTitle: 'x', scene: [], anchorText: '', turns: [], question: 'hi',
});
ok(noScene[1].content.includes('arrived early'),
  'an empty host story says so rather than sending a blank scene');

ok(/\[FEELING: one word\]/.test(turn[0].content),
  'and the expression sidecar is asked for, so the portrait reacts like anyone else\u2019s');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
