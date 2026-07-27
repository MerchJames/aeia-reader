/**
 * Split a message into an ordered read plan of narration vs. dialogue spans, and
 * attribute each quoted line to the character who actually speaks it. This lets
 * multi-voice TTS narrate the prose in the narrator's voice and voice each
 * character's dialogue distinctly — the fix for "it reads everything in one tone".
 *
 * Heuristic, source-safe (never rewrites text): it finds quote spans and looks at
 * the adjacent narration for a cast name near a speech verb ("said Kara", "Kara
 * whispered"). Unattributed dialogue and all narration fall back to the message's
 * own author, so with no quotes this yields exactly one narrator segment.
 */

export interface SpeechSegment {
  /** Clean text to speak (dialogue has its surrounding quote marks stripped). */
  text: string;
  /** Whose voice reads it — an attributed speaker, else the message author. */
  speaker: string;
  /** True for a quoted line, false for narration. */
  isDialogue: boolean;
}

const CTX = 72; // how much adjacent narration to scan for an attribution
const VERB =
  'said|asked|replied|whispered|shouted|murmured|called|answered|cried|muttered|'
  + 'hissed|growled|snapped|breathed|added|continued|began|exclaimed|demanded|'
  + 'responded|remarked|declared|yelled|screamed|sighed|laughed|spoke|says|asks|'
  + 'replies|whispers|shouts|mutters|growls|snaps';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Capitalized-token words that look like names but never are, so a generic
// "said X" guess doesn't attribute a line to "The" or "She".
const NOT_A_NAME = new Set([
  'the', 'he', 'she', 'they', 'i', 'you', 'it', 'we', 'his', 'her', 'their',
  'our', 'your', 'my', 'a', 'an', 'and', 'but', 'then', 'so', 'there', 'this',
  'that', 'these', 'those', 'who', 'what', 'when', 'where', 'why', 'how',
  'note', 'chapter', 'warning', 'system', 'ooc', 'author',
]);
const PROPER = "([A-Z][A-Za-z'’-]+)";
// Markdown emphasis / punctuation that can sit BETWEEN an attribution and its
// quote — e.g. "styleQuotes" wraps dialogue as `Kaelen (grim): *"..."*`, so the
// tag no longer butts straight up to the quote. Tolerate these at the boundary.
const LEAD = "[\\s,*_~]*"; // right after a closing quote, before "said X"
const TRAIL = "[\\s,:—–\\-*_~]*$"; // right before an opening quote, after "X said"
// A screenplay-style attribution right before a quote: "Kaelen:" or, with a
// delivery note, "Kaelen (Low, grim):" — markers may trail before the quote.
const SCRIPT_TAIL = "\\s*(?:\\([^)]*\\))?\\s*:[\\s*_~]*$";

/**
 * Guess a speaker by the proper noun sitting next to a speech verb OR in the
 * "Name:"/"Name (tone):" script format — even when the name isn't in the known
 * cast. This is what catches an NPC the author voices in a single message
 * ("...," Kara said / Kaelen (grim): "...") so it isn't read as the message's
 * own character.
 */
const guessSpeaker = (before: string, after: string): string | undefined => {
  const hit =
    after.match(new RegExp(`^${LEAD}(?:${VERB})\\s+${PROPER}`)) // "..." said Kara
    ?? after.match(new RegExp(`^${LEAD}${PROPER}\\b\\s+(?:${VERB})`)) // "...", Kara said
    ?? before.match(new RegExp(`${PROPER}\\b\\s+(?:${VERB})${TRAIL}`)) // Kara said, "..."
    ?? before.match(new RegExp(`${PROPER}${SCRIPT_TAIL}`)); // Kaelen (Low, grim): "..."
  const name = hit?.[1];
  return name && !NOT_A_NAME.has(name.toLowerCase()) ? name : undefined;
};

/** Attribute a quote from the narration just before/after it. */
const attribute = (before: string, after: string, cast: string[]): string | undefined => {
  for (const name of cast) {
    const n = escapeRe(name);
    // "..." said Kara   /   "...", Kara replied
    if (new RegExp(`^${LEAD}(?:${VERB})\\s+${n}\\b`, 'i').test(after)) return name;
    if (new RegExp(`^${LEAD}${n}\\b\\s+(?:${VERB})`, 'i').test(after)) return name;
    // Kara said, "..."
    if (new RegExp(`\\b${n}\\b\\s+(?:${VERB})${TRAIL}`, 'i').test(before)) return name;
    // Script format: Kara:  /  Kara (softly):  right before the quote.
    if (new RegExp(`\\b${n}\\b${SCRIPT_TAIL}`, 'i').test(before)) return name;
  }
  // A named speaker by the verb/script tag, even one not in the roster (voiced
  // NPC). Otherwise UNDEFINED → the caller uses the message's own speaker. We do
  // NOT grab a bare nearby name: that mis-reads a vocative/addressee ("turned to
  // Elara", `"User," she says`) as the speaker. Precise attribution of those
  // ambiguous lines is the enrichment pass's job, not this heuristic.
  return guessSpeaker(before, after);
};

/**
 * The speaker a quoted line is attributed to from the narration on either side
 * of it, or undefined when no name is found (callers fall back to the message's
 * own author). Shared by the multi-voice plan, the Stage/VN bubble, and the
 * phone dialogue-only view so they all attribute the same way.
 */
export const attributeSpeaker = (
  before: string, after: string, cast: string[] = [],
): string | undefined =>
  attribute(before, after, [...new Set(cast.map(c => c.trim()).filter(Boolean))]);

/** Per-quote speaker attributed by the enrichment (the AI), preferred over the
 *  heuristic. Matches a quote to an enrichment entry leniently (markdown
 *  stripped, either contains the other — tolerates streaming truncation). */
export interface DialogueAttribution { text: string; speaker: string }
export const aiSpeakerFor = (
  quote: string, dialogue?: DialogueAttribution[],
): string | undefined => {
  if (!dialogue?.length) return undefined;
  const q = quote.replace(/[*_`"“”]/g, '').trim().toLowerCase();
  if (q.length < 2) return undefined;
  for (const d of dialogue) {
    const t = d.text.replace(/[*_`"“”]/g, '').trim().toLowerCase();
    if (t.length < 2) continue;
    if (t === q || t.includes(q) || q.includes(t)) return d.speaker;
  }
  return undefined;
};

/**
 * Build the ordered speech plan. `text` should already be plain (markdown
 * stripped) with quotes intact. Consecutive same-speaker spans are merged to
 * keep playback from getting choppy.
 */
export const buildSpeechPlan = (
  text: string,
  opts: { author: string; cast?: string[]; dialogue?: DialogueAttribution[] },
): SpeechSegment[] => {
  const author = (opts.author || '').trim() || 'Narrator';
  const cast = [...new Set((opts.cast ?? []).map(c => c.trim()).filter(Boolean))];
  const quote = /[“"]([^“”"]+)[”"]/g;

  interface Raw { text: string; isDialogue: boolean }
  const raw: Raw[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = quote.exec(text)) !== null) {
    if (m.index > last) raw.push({ text: text.slice(last, m.index), isDialogue: false });
    raw.push({ text: m[1], isDialogue: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) raw.push({ text: text.slice(last), isDialogue: false });

  const out: SpeechSegment[] = [];
  raw.forEach((r, i) => {
    const t = r.text.trim();
    if (!t) return;
    if (!r.isDialogue) { out.push({ text: t, speaker: author, isDialogue: false }); return; }
    const after = raw[i + 1] && !raw[i + 1].isDialogue ? raw[i + 1].text.slice(0, CTX) : '';
    const before = raw[i - 1] && !raw[i - 1].isDialogue ? raw[i - 1].text.slice(-CTX) : '';
    // Enrichment attribution first, then the heuristic, then the author.
    const speaker = aiSpeakerFor(t, opts.dialogue) ?? attribute(before, after, cast) ?? author;
    out.push({ text: t, speaker, isDialogue: true });
  });

  // Merge neighbours read by the same voice so we don't fire tiny back-to-back clips.
  const merged: SpeechSegment[] = [];
  for (const s of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.speaker === s.speaker) prev.text = `${prev.text} ${s.text}`.trim();
    else merged.push({ ...s });
  }
  return merged;
};

/**
 * The QUOTED lines only, each attributed to a speaker — for dialogue-only TTS.
 * Unlike buildSpeechPlan this never merges quotes into their surrounding
 * narration (a solo character's quotes would otherwise collapse into narration
 * and lose their identity), so every spoken line survives even when the speaker
 * is the message's own character.
 */
export const dialogueQuotes = (
  text: string,
  opts: { author: string; cast?: string[]; dialogue?: DialogueAttribution[] },
): { text: string; speaker: string }[] => {
  const author = (opts.author || '').trim() || 'Narrator';
  const cast = [...new Set((opts.cast ?? []).map(c => c.trim()).filter(Boolean))];
  const quote = /[“"]([^“”"]+)[”"]/g;
  interface Raw { text: string; isDialogue: boolean }
  const raw: Raw[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = quote.exec(text)) !== null) {
    if (m.index > last) raw.push({ text: text.slice(last, m.index), isDialogue: false });
    raw.push({ text: m[1], isDialogue: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) raw.push({ text: text.slice(last), isDialogue: false });

  const out: { text: string; speaker: string }[] = [];
  raw.forEach((r, i) => {
    if (!r.isDialogue) return;
    const t = r.text.trim();
    if (t.length < 2) return;
    const after = raw[i + 1] && !raw[i + 1].isDialogue ? raw[i + 1].text.slice(0, CTX) : '';
    const before = raw[i - 1] && !raw[i - 1].isDialogue ? raw[i - 1].text.slice(-CTX) : '';
    const speaker = aiSpeakerFor(t, opts.dialogue) ?? attribute(before, after, cast) ?? author;
    out.push({ text: t, speaker });
  });
  return out;
};

/**
 * The last quoted span in `text` and who speaks it — the source of truth for the
 * Stage/VN speech bubble. Mirrors the mid-stream open-quote handling (a line
 * still being typed attributes too), then attributes the span from the narration
 * around it exactly like the multi-voice plan. `attributed` is true only when a
 * name was actually found — narration and unattributed lines fall back to the
 * message author, and the caller uses `attributed` to decide whether a line
 * belongs to a *different* speaker than the message's own character.
 */
export const latestSpeech = (
  text: string,
  opts: { author: string; cast?: string[]; dialogue?: DialogueAttribution[] },
): { line: string; speaker: string; attributed: boolean } | null => {
  // Find the last quote span, tolerating one still open at the reveal edge.
  let open = -1;
  let span: { start: number; end: number } | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '“') open = i + 1;
    else if (c === '”' || c === '"') {
      if (c === '"' && open < 0) { open = i + 1; continue; }
      if (open >= 0) { span = { start: open, end: i }; open = -1; }
    }
  }
  if (open >= 0 && open < text.length) span = { start: open, end: text.length };
  if (!span) return null;

  const line = text.slice(span.start, span.end).replace(/[*_`]/g, '').trim();
  if (!line) return null;

  const cast = [...new Set((opts.cast ?? []).map(c => c.trim()).filter(Boolean))];
  const before = text.slice(Math.max(0, span.start - 1 - CTX), Math.max(0, span.start - 1));
  const after = text.slice(span.end + 1, span.end + 1 + CTX);
  // Enrichment attribution wins; else the heuristic.
  const who = aiSpeakerFor(line, opts.dialogue) ?? attribute(before, after, cast);
  return { line, speaker: who ?? ((opts.author || '').trim() || 'Narrator'), attributed: !!who };
};
