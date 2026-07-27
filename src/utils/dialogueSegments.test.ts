/** Run: npx tsx src/utils/dialogueSegments.test.ts */
import { buildSpeechPlan, latestSpeech, attributeSpeaker, aiSpeakerFor, dialogueQuotes } from './dialogueSegments';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const cast = ['Elara', 'Kara', 'Kael', 'Mara'];

// No quotes → a single narrator segment in the author's voice.
const n = buildSpeechPlan('The hall was silent and cold.', { author: 'Elara', cast });
ok(n.length === 1 && !n[0].isDialogue && n[0].speaker === 'Elara', 'plain prose → one author segment');

// "Name said," before the quote attributes it.
const a = buildSpeechPlan('Kara said, "We should leave."', { author: 'Elara', cast });
ok(a.some(s => s.isDialogue && s.speaker === 'Kara' && /leave/.test(s.text)), 'name-before attribution');
ok(a.every(s => !/"/.test(s.text)), 'quote marks stripped from spoken text');

// "said Name" after the quote attributes it.
const b = buildSpeechPlan('"Never," said Kael, stepping back.', { author: 'Elara', cast });
ok(b.some(s => s.isDialogue && s.speaker === 'Kael'), 'name-after attribution');

// Unattributed dialogue falls back to the message author.
const c = buildSpeechPlan('"Hello?" The word echoed.', { author: 'Elara', cast });
ok(c.some(s => s.isDialogue && s.speaker === 'Elara'), 'unattributed dialogue → author voice');

// Two speakers in one message get distinct voices (each explicitly attributed).
const d = buildSpeechPlan('"Ready?" asked Kara. "Never," said Kael.', { author: 'Elara', cast });
const voices = new Set(d.filter(s => s.isDialogue).map(s => s.speaker));
ok(voices.has('Kael'), 'second speaker attributed to Kael');
ok(d.filter(s => s.isDialogue).length >= 2 && voices.size >= 2, 'two dialogue voices differentiated');

// Curly quotes are handled too.
const e = buildSpeechPlan('Mara whispered, “Stay close.”', { author: 'Elara', cast });
ok(e.some(s => s.isDialogue && s.speaker === 'Mara'), 'curly-quote dialogue attributed');

// Same-speaker neighbours merge (narration author + unattributed dialogue author).
const f = buildSpeechPlan('She paused. "Fine." She turned away.', { author: 'Elara', cast });
ok(f.length === 1 && f[0].speaker === 'Elara', 'same-voice neighbours merge into one segment');

// An NPC the author only voices in the prose (not in the cast) is still caught
// by the speech-verb guess — the fix for "the bubble shows from the char".
const g = buildSpeechPlan('"Halt!" barked the guard. "Show me Torvin," said Torvin.', { author: 'Elara', cast });
ok(g.some(s => s.isDialogue && s.speaker === 'Torvin'), 'unlisted NPC guessed by speech verb');

// A stopword next to a verb is NOT mistaken for a name.
const h = buildSpeechPlan('"Wait," she said, turning.', { author: 'Elara', cast });
ok(h.every(s => s.speaker !== 'She'), 'pronoun near verb is not treated as a speaker');

// --- latestSpeech: the Stage/VN bubble's speaker -------------------------------
const ls1 = latestSpeech('Kael scowled. "Get back," said Kael.', { author: 'Elara', cast });
ok(!!ls1 && ls1.attributed && ls1.speaker === 'Kael' && /Get back/.test(ls1.line), 'latestSpeech attributes NPC line');

const ls2 = latestSpeech('The wind howled outside the walls.', { author: 'Elara', cast });
ok(ls2 === null, 'latestSpeech is null for pure narration');

const ls3 = latestSpeech('"Where am I?" she wondered aloud.', { author: 'Elara', cast });
ok(!!ls3 && !ls3.attributed && ls3.speaker === 'Elara', 'unattributed line falls back to author, attributed=false');

// A line still open at the reveal edge (mid-stream) still attributes (via its verb).
const ls4 = latestSpeech('Kara whispered, "We have to', { author: 'Elara', cast });
ok(!!ls4 && ls4.speaker === 'Kara' && /We have to/.test(ls4.line), 'open quote at the reveal edge attributes');

// A name that's merely ADDRESSED (vocative / "turned to X") is NOT the speaker.
const voc1 = latestSpeech('He turned to Elara. "It is nice to meet you."', { author: 'Kaelen', cast: ['Elara', 'Kaelen'] });
ok(!!voc1 && voc1.speaker === 'Kaelen', 'a line after "turned to Elara" stays with the author, not the addressee');
const voc2 = latestSpeech('"User," she says, "I\'m glad to meet you."', { author: 'Kaelen', cast: ['User', 'Kaelen'] });
ok(!!voc2 && voc2.speaker === 'Kaelen', 'a quoted vocative name is not treated as the speaker');

// Screenplay format: "Kaelen:" and "Kaelen (Low, grim):" attribute the line to
// the tagged speaker even when they're not in the cast (the reported Stage bug).
const sc1 = latestSpeech('Kaelen (Low, grim): "They didn\'t walk. They hired a guide."', { author: 'Elara', cast: ['Elara'] });
ok(!!sc1 && sc1.attributed && sc1.speaker === 'Kaelen', 'Name (tone): script format attributes to the NPC, not the author');
const sc2 = latestSpeech('Elara paused. Kaelen: "We should turn back."', { author: 'Elara', cast: ['Elara'] });
ok(!!sc2 && sc2.speaker === 'Kaelen', 'bare Name: script format attributes to the NPC');
const sc3 = buildSpeechPlan('Kaelen (grim): "Hold." Elara nodded.', { author: 'Elara', cast: ['Elara'] });
ok(sc3.some(s => s.isDialogue && s.speaker === 'Kaelen'), 'script format flows through the multi-voice plan');
// A colon after a non-name label isn't mistaken for a speaker.
const sc4 = latestSpeech('Note: "the map was wrong."', { author: 'Elara', cast: ['Elara'] });
ok(!!sc4 && !sc4.attributed && sc4.speaker === 'Elara', 'a non-name label before a colon is not a speaker');

// styleQuotes wraps dialogue in *…* markers between the tag and the quote — the
// live-streaming case that showed on the char side until the message committed.
const mk1 = latestSpeech('Kaelen (Low, grim): *"They didn\'t walk."*', { author: 'Elara', cast: ['Elara'] });
ok(!!mk1 && mk1.attributed && mk1.speaker === 'Kaelen', 'script tag attributes across a *…* emphasis wrapper');
const mk2 = latestSpeech('*"Never," said Kael.*', { author: 'Elara', cast: ['Elara', 'Kael'] });
ok(!!mk2 && mk2.speaker === 'Kael', 'verb attribution survives leading/trailing emphasis markers');
const mk3 = buildSpeechPlan('Kara said, *"Run."* _"Now,"_ hissed Kael.', { author: 'Elara', cast: ['Kara', 'Kael'] });
ok(mk3.some(s => s.speaker === 'Kara') && mk3.some(s => s.speaker === 'Kael'), 'both speakers attributed through emphasis markers');

// --- attributeSpeaker: the phone dialogue-only tag ----------------------------
ok(attributeSpeaker('', ' said Kael', cast) === 'Kael', 'attributeSpeaker reads name after verb');
ok(attributeSpeaker('The room fell quiet. ', '', cast) === undefined, 'attributeSpeaker undefined with no speaker');

// --- enrichment attribution wins over the heuristic --------------------------
const attr = [{ text: 'We must flee', speaker: 'Torin' }];
ok(aiSpeakerFor('We must flee', attr) === 'Torin', 'aiSpeakerFor matches a quote to its enrichment speaker');
ok(aiSpeakerFor('“We must flee.”', attr) === 'Torin', 'aiSpeakerFor is lenient about quotes/punctuation');
ok(aiSpeakerFor('unrelated line', attr) === undefined, 'aiSpeakerFor returns undefined on a miss');

// buildSpeechPlan prefers the AI attribution even when the heuristic says otherwise.
const aiPlan = buildSpeechPlan('"We must flee," said Kael.', { author: 'Elara', cast: ['Kael'], dialogue: [{ text: 'We must flee', speaker: 'Torin' }] });
ok(aiPlan.some(s => s.isDialogue && s.speaker === 'Torin'), 'plan uses the enrichment speaker over the heuristic "said Kael"');
// …and falls back to the heuristic when the enrichment has no entry for the line.
const aiPlan2 = buildSpeechPlan('"Halt," said Kael.', { author: 'Elara', cast: ['Kael'], dialogue: [{ text: 'something else', speaker: 'Torin' }] });
ok(aiPlan2.some(s => s.isDialogue && s.speaker === 'Kael'), 'plan falls back to the heuristic when unattributed by the AI');

// latestSpeech uses the enrichment to override a vocative the heuristic can't resolve.
const aiLs = latestSpeech('He turned to Elara. "It is good to see you."', { author: 'Kaelen', cast: ['Elara'], dialogue: [{ text: 'It is good to see you.', speaker: 'Elara' }] });
ok(!!aiLs && aiLs.attributed && aiLs.speaker === 'Elara', 'latestSpeech honours the enrichment attribution');

// --- dialogueQuotes: the merge-independent extractor for dialogue-only TTS ----
// A SOLO character's quotes must survive even though they attribute to the author
// (buildSpeechPlan would merge them into narration and drop isDialogue).
const solo = 'She looked up. "I wondered if you would come." A pause. "Sit with me."';
const sq = dialogueQuotes(solo, { author: 'Elara', cast: [] });
ok(sq.length === 2, 'dialogueQuotes keeps each quote separate for a solo speaker');
ok(sq.every(q => q.speaker === 'Elara'), 'solo quotes attribute to the message author');
// The same input through buildSpeechPlan collapses to zero dialogue segments — the bug we fixed.
ok(buildSpeechPlan(solo, { author: 'Elara', cast: [] }).filter(s => s.isDialogue).length === 0,
  'buildSpeechPlan merges solo quotes away (why dialogue-only needs dialogueQuotes)');
// Narration is excluded; multi-speaker attribution still works.
const multi = dialogueQuotes('"Halt," said Kael. Elara shook her head. "Never."', { author: 'Elara', cast: ['Kael'] });
ok(multi.length === 2 && multi[0].speaker === 'Kael' && multi[1].speaker === 'Elara',
  'dialogueQuotes attributes each line and skips narration');
ok(dialogueQuotes('Just narration, no one speaks.', { author: 'Elara' }).length === 0,
  'dialogueQuotes returns nothing when there is no dialogue');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
