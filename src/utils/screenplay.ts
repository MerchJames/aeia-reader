/**
 * The Script view — an RP log read as a screenplay.
 *
 * ── Why this is a view and not a gimmick ───────────────────────────────────
 *
 * Every other view here presents the story. This one presents its STRUCTURE.
 * Screenplay format is the only widely-agreed notation for "what happens, where,
 * who says it", and it is the format an editor actually works in: sluglines make
 * scene boundaries impossible to miss, character cues make it obvious when one
 * person has been talking for two pages, and page count is a running estimate of
 * screen time. An improvised RP log has all of that in it and no way to see it.
 *
 * So this is the natural companion to the v3 thesis — Aeia as post-production.
 * You cannot cut a scene you cannot find.
 *
 * ── The format, exactly ────────────────────────────────────────────────────
 *
 * Standard US screenplay: 12pt Courier on US Letter, 1.5" left margin, 1" right,
 * giving a 6" text block. In 12pt Courier one inch is exactly ten characters, so
 * the whole format is a character grid and scales with the font:
 *
 *   slugline / action   0ch   width 60ch
 *   dialogue           10ch   width 35ch
 *   parenthetical      16ch   width 20ch
 *   character cue      22ch
 *
 * A page is ~55 lines, and one page is ~one minute of screen time. Scene length
 * is quoted in EIGHTHS of a page, which is how scenes are actually scheduled.
 *
 * ── What it will not do ────────────────────────────────────────────────────
 *
 * It will not invent. A slugline says INT. only where the prose names an
 * interior, and where nothing is known the scene is marked CONTINUOUS — the real
 * screenplay term for "we have not moved", and the truth. Transitions are not
 * emitted: CUT TO: and DISSOLVE TO: are directorial decisions nobody in this
 * story made, and typing them in would be putting words in a director's mouth to
 * make the page look more like a script. The single exception is `FADE IN:` on
 * an opening scene with no known place — see `slugFor` for why that one is not a
 * claim about anything.
 *
 * Pure: no DOM, no store, no React.
 */

import { Message, SceneDescriptor } from '../types';
import { Scene } from './sceneSegment';
import { attributeSpeaker, aiSpeakerFor } from './dialogueSegments';

export type LineKind = 'slug' | 'action' | 'character' | 'parenthetical' | 'dialogue';

export interface ScriptLine {
  kind: LineKind;
  text: string;
  /** The passage this line came from — clicking it jumps the reader there. */
  messageId: string;
}

export interface ScriptScene {
  id: string;
  /** 1-based, as scenes are numbered on a shooting script. */
  number: number;
  slug: string;
  lines: ScriptLine[];
  messageIds: string[];
  /** Length in eighths of a page — how scenes are actually scheduled. */
  eighths: number;
}

/** Lines of 12pt Courier on a US Letter page, between 1" margins. */
export const LINES_PER_PAGE = 55;
/** Characters across the 6" text block (12pt Courier is exactly 10 per inch). */
export const ACTION_COLS = 60;
export const DIALOGUE_COLS = 35;

/**
 * Words that place a scene indoors or out.
 *
 * Deliberately short. A long list guesses more often, and every wrong guess
 * prints INT. over a scene in a forest — which reads as a formatting bug in a
 * format whose whole value is that it is precise.
 */
/* The leading `[a-z]*` is load-bearing: English builds place names by gluing
 * words together, and `guardroom`, `bedchamber`, `farmhouse` and `bathhouse`
 * all failed a plain word-boundary list — so a scene in a guardroom printed no
 * prefix at all, which reads as the feature not working. */
const INTERIOR = /\b[a-z]*(?:room|hall|hallway|kitchen|office|cabin|tavern|inn|church|temple|cellar|attic|corridor|library|shop|store|chamber|apartment|house|lab|laboratory|carriage|cockpit|elevator|lift|basement|vault|study|parlou?r|lounge|infirmary|ward|cell|dungeon|bath|foyer|lobby|studio|bar)\b/i;
const EXTERIOR = /\b[a-z]*(?:street|road|forest|woods|field|beach|shore|mountain|garden|courtyard|rooftop|roof|alley|bridge|river|lake|sea|ocean|desert|plain|hill|valley|park|market|square|yard|dock|harbou?r|clearing|path|trail|ridge|cliff|graveyard|cemetery|battlefield|sky|orbit|wasteland|ruins?)\b/i;

/** `INT.`, `EXT.`, or nothing when the prose does not say. */
export const placePrefix = (location?: string): 'INT.' | 'EXT.' | '' => {
  if (!location) return '';
  // Exterior first: "the road outside the tavern" is outdoors, and the interior
  // word is the landmark, not the place.
  if (EXTERIOR.test(location)) return 'EXT.';
  if (INTERIOR.test(location)) return 'INT.';
  return '';
};

const TIME_LABEL: Record<string, string> = {
  dawn: 'DAWN', day: 'DAY', dusk: 'DUSK', night: 'NIGHT',
};

/**
 * The scene heading.
 *
 * A slugline carries three things — inside or out, where, and when — and prints
 * only the ones the story actually establishes. A scene that establishes none of
 * them is CONTINUOUS: the real term for a scene that carries straight on from
 * the last one, and the honest answer when the prose has not moved us anywhere
 * we can name.
 *
 * `prev` is compared so an unchanged time of day is not restated on every
 * heading, which is how a script is actually written.
 */
export const slugFor = (scene: Scene, prev?: Scene): string => {
  const place = scene.location?.trim();
  const prefix = placePrefix(place);
  const time = scene.timeOfDay && scene.timeOfDay !== 'unknown'
    ? TIME_LABEL[scene.timeOfDay] : undefined;
  const timeChanged = !prev || prev.timeOfDay !== scene.timeOfDay;

  if (!place) {
    /* CONTINUOUS means "we have not moved since the last scene", so the FIRST
     * scene cannot be one — there is nothing behind it to continue from.
     *
     * `FADE IN:` is the one piece of transition vocabulary this file will print,
     * and only here. It is the conventional first line of every screenplay, it
     * claims nothing about where we are or how we got here, and it is simply
     * true: the picture begins. Every other transition is a directorial
     * decision nobody in this story made, and stays unwritten. */
    if (!prev) return time ? `FADE IN: - ${time}` : 'FADE IN:';
    return time && timeChanged ? `CONTINUOUS - ${time}` : 'CONTINUOUS';
  }
  const head = [prefix, place.toUpperCase()].filter(Boolean).join(' ');
  return time && timeChanged ? `${head} - ${time}` : head;
};

/**
 * Markdown out, paragraphs kept.
 *
 * `plainTextForSpeech` collapses all whitespace, which is right for a voice and
 * wrong here: the blank line between paragraphs is what becomes the break
 * between two action blocks, and losing it runs a whole passage into one
 * unreadable slab.
 */
export const plainProse = (text: string): string =>
  text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    // Inline IMAGES go entirely, before links are unwrapped. A picture is not
    // prose: the views that use this render it as art beside the words, and
    // unwrapping it as a link left the alt text behind its `!` — so a comic
    // panel captioned itself `!the guardroom`.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** A quoted line, and the narration around it, in the order they were written. */
interface Span { text: string; spoken: boolean }

const splitQuotes = (text: string): Span[] => {
  const quote = /[“"]([^“”"]+)[”"]/g;
  const out: Span[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = quote.exec(text)) !== null) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), spoken: false });
    out.push({ text: m[1], spoken: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), spoken: false });
  return out;
};

/**
 * An attribution clause that the character cue has already replaced.
 *
 * `"You are late," the captain said.` becomes a cue reading THE CAPTAIN and
 * then, if nothing is done, an action line reading *the captain said.* — the
 * same fact printed twice, once as a claim and once as stage business that does
 * not exist. Script format deletes the clause because the cue IS the clause.
 *
 * Deliberately narrow. It fires only on a whole sentence that is nothing but an
 * attribution, so `she said, and there was nothing warm in it` — which carries
 * real prose after the verb — is left completely alone. Losing a line of a
 * reader's story to be tidy is not a trade worth making.
 */
const VERB = '(?:said|says|asked|asks|replied|replies|answered|whispered|whispers|murmured|'
  + 'muttered|mutters|shouted|shouts|called|added|continued|repeated|breathed|growled|'
  + 'snapped|hissed|sighed|laughed|began|exclaimed|declared|responded|remarked|demanded)';
const ATTRIBUTION_ONLY = new RegExp(
  `^[,\\s]*(?:[A-Z][A-Za-z'’-]+|he|she|they|it|the\\s+[a-z]+)\\s+${VERB}\\s*[.!?]?$`,
);

/** Drop a paragraph that is only "he said." — nothing else is ever removed. */
export const stripAttribution = (para: string): string =>
  ATTRIBUTION_ONLY.test(para.trim()) ? '' : para;

export interface ScriptOptions {
  /** Everyone who might speak — the same roster the bubbles and TTS use. */
  cast?: string[];
  characterName?: string;
  userName?: string;
}

/**
 * One passage as script lines.
 *
 * Attribution is not re-invented here: it comes from the Director's read where
 * there is one and from `attributeSpeaker` where there is not — the same engine
 * behind the multi-voice TTS and the Stage/VN bubbles. A character cue that
 * disagreed with the voice reading the line would be worse than no cue.
 *
 * Consecutive lines from one speaker merge into a single dialogue block, because
 * a cue repeated over every sentence is how a script tells you the speaker
 * CHANGED, and printing it otherwise is a lie about the rhythm of the scene.
 */
export const linesForMessage = (
  msg: Pick<Message, 'id' | 'name' | 'role' | 'content'>,
  descriptor: SceneDescriptor | undefined,
  opts: ScriptOptions = {},
): ScriptLine[] => {
  const author = (msg.name || '').trim() || (msg.role === 'user' ? 'YOU' : 'NARRATOR');
  const cast = [...new Set((opts.cast ?? []).map(c => c.trim()).filter(Boolean))];
  const out: ScriptLine[] = [];
  const prose = plainProse(msg.content);
  if (!prose) return out;

  // The Director's per-passage emotion becomes a parenthetical, once — on the
  // first line its named speaker actually says. A parenthetical over every line
  // is the classic amateur tell, and it is also wrong: an emotion read for the
  // passage is not a note on every sentence in it.
  const emotionFor = descriptor?.speaker?.emotion?.trim();
  const emotionOwner = descriptor?.speaker?.name?.trim();
  let emotionSpent = false;

  const spans = splitQuotes(prose);
  let pendingSpeaker: string | null = null;
  let pendingLines: string[] = [];

  const flushDialogue = () => {
    if (!pendingSpeaker || !pendingLines.length) { pendingLines = []; pendingSpeaker = null; return; }
    const speaker = pendingSpeaker;
    out.push({ kind: 'character', text: speaker.toUpperCase(), messageId: msg.id });
    if (emotionFor && !emotionSpent
      && (!emotionOwner || emotionOwner.toLowerCase() === speaker.toLowerCase())) {
      out.push({ kind: 'parenthetical', text: emotionFor.toLowerCase(), messageId: msg.id });
      emotionSpent = true;
    }
    /* The comma at the end of a quoted line exists only to attach the "she
     * said" that follows it — and script format has just deleted that clause and
     * replaced it with the cue above. Left in, every second line of dialogue
     * ends in a comma that leads nowhere. Only a comma is stripped: a full stop,
     * a question mark and a dash all still mean what they meant. */
    const spoken = pendingLines.join(' ').replace(/,\s*$/, '');
    out.push({ kind: 'dialogue', text: spoken, messageId: msg.id });
    pendingLines = [];
    pendingSpeaker = null;
  };

  spans.forEach((span, i) => {
    if (span.spoken) {
      const line = span.text.trim();
      if (!line) return;
      const before = spans[i - 1] && !spans[i - 1].spoken ? spans[i - 1].text.slice(-160) : '';
      const after = spans[i + 1] && !spans[i + 1].spoken ? spans[i + 1].text.slice(0, 160) : '';
      const speaker = aiSpeakerFor(line, descriptor?.dialogue, opts)
        ?? attributeSpeaker(before, after, cast)
        ?? author;
      if (pendingSpeaker && pendingSpeaker !== speaker) flushDialogue();
      pendingSpeaker = speaker;
      pendingLines.push(line);
      return;
    }
    // Narration. Anything with words in it ends the dialogue block, because
    // stage business between two lines is a beat, not a continuation.
    //
    // The first paragraph after a quote is the one that may be a bare "she
    // said." — the cue above has already printed that, so it goes.
    const followsSpeech = !!spans[i - 1]?.spoken;
    const paras = span.text.split(/\n{2,}/)
      .map((p, k) => (followsSpeech && k === 0 ? stripAttribution(p) : p).trim())
      .filter(Boolean);
    if (!paras.length) return;
    flushDialogue();
    for (const p of paras) out.push({ kind: 'action', text: p, messageId: msg.id });
  });
  flushDialogue();

  return out;
};

/** How many printed lines a script line takes, wrapped to its column width. */
export const lineHeight = (line: ScriptLine): number => {
  const cols = line.kind === 'dialogue' ? DIALOGUE_COLS
    : line.kind === 'parenthetical' ? 20
      : line.kind === 'character' ? DIALOGUE_COLS
        : ACTION_COLS;
  const rows = Math.max(1, Math.ceil(line.text.length / cols));
  // Everything but a parenthetical and a cue carries a blank line after it.
  const spacer = line.kind === 'character' || line.kind === 'parenthetical' ? 0 : 1;
  return rows + spacer;
};

/** Scene length in eighths of a page, the unit a schedule is built from. */
export const eighthsOf = (lines: ScriptLine[]): number => {
  const rows = lines.reduce((n, l) => n + lineHeight(l), 0);
  return Math.max(1, Math.round((rows / LINES_PER_PAGE) * 8));
};

/** The whole story as numbered scenes. */
export const buildScript = (
  messages: Pick<Message, 'id' | 'name' | 'role' | 'content'>[],
  scenes: Scene[],
  descriptors: Record<string, SceneDescriptor> | undefined,
  opts: ScriptOptions = {},
): ScriptScene[] => {
  const byId = new Map(messages.map(m => [m.id, m]));
  const out: ScriptScene[] = [];
  scenes.forEach((scene, i) => {
    const lines: ScriptLine[] = [];
    const ids: string[] = [];
    for (const id of scene.messageIds) {
      const msg = byId.get(id);
      if (!msg) continue;
      const got = linesForMessage(msg, descriptors?.[id], opts);
      if (!got.length) continue;
      ids.push(id);
      lines.push(...got);
    }
    // A scene with nothing in it is not a scene. It happens when a span is all
    // hidden or all system notes, and printing an empty heading for it makes the
    // sidebar count disagree with the page.
    if (!lines.length) return;
    const slug = slugFor(scene, scenes[i - 1]);
    out.push({
      id: scene.id,
      number: out.length + 1,
      slug,
      lines: [{ kind: 'slug', text: slug, messageId: ids[0] }, ...lines],
      messageIds: ids,
      eighths: eighthsOf(lines),
    });
  });
  return out;
};

export interface ScriptStats {
  scenes: number;
  /** Printed lines, wrapped. */
  rows: number;
  /** Pages, to one decimal. */
  pages: number;
  /** Estimated screen time — one page is one minute, the industry rule. */
  minutes: number;
}

export const scriptStats = (scenes: ScriptScene[]): ScriptStats => {
  const rows = scenes.reduce(
    (n, s) => n + s.lines.reduce((m, l) => m + lineHeight(l), 0), 0);
  const pages = rows / LINES_PER_PAGE;
  return {
    scenes: scenes.length,
    rows,
    pages: Math.round(pages * 10) / 10,
    minutes: Math.max(1, Math.round(pages)),
  };
};

/** `2 3/8` — a page count the way a schedule writes it. */
export const eighthsLabel = (eighths: number): string => {
  const pages = Math.floor(eighths / 8);
  const rest = eighths % 8;
  if (!pages) return `${rest}/8`;
  return rest ? `${pages} ${rest}/8` : `${pages}`;
};
