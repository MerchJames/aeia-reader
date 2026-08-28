import { AutoFormatRule, OocHandling, Role } from '../types';

export interface ProcessOptions {
  hideMetadata?: boolean;
  /** How to treat [OOC: ...] / (OOC: ...) out-of-character asides. */
  oocHandling?: OocHandling;
  autoFormat?: boolean;
  autoFormatRules?: AutoFormatRule[];
  /** Auto-format sub-features; default on except dialogueOwnLine/smartTypography. */
  paragraphSpacing?: boolean;
  dialogueOwnLine?: boolean;
  smartTypography?: boolean;
  styleQuotes?: boolean;
  /** Close dangling quotes / emphasis so misformatted prose renders cleanly.
   *  Presentation-only; defaults on (pass false to skip, e.g. for speech). */
  repairFormatting?: boolean;
  substituteNames?: boolean;
  characterName?: string;
  userName?: string;
  /** Role of the message, for role-targeted rules. */
  role?: Role;
}

export const ruleAppliesTo = (rule: AutoFormatRule, role?: Role): boolean =>
  !rule.appliesTo || rule.appliesTo === 'all' || !role || rule.appliesTo === role;

/** Compile a rule's regex; returns null (and no crash) for invalid patterns. */
export const compileRule = (rule: AutoFormatRule): RegExp | null => {
  try {
    return new RegExp(rule.pattern, rule.flags || 'g');
  } catch {
    return null;
  }
};

/** Validation message for the rule editor, or null when the rule is valid. */
export const ruleError = (rule: AutoFormatRule): string | null => {
  if (!rule.pattern) return 'Pattern is empty';
  try {
    new RegExp(rule.pattern, rule.flags || 'g');
    return null;
  } catch (e: any) {
    return e?.message ?? 'Invalid regular expression';
  }
};

/**
 * Verbs that mark an attribution, so a quote beside one is being SPOKEN even
 * without its own punctuation: `She said "nothing at all" and left.`
 */
const SPEECH_VERB =
  /\b(said|says|saying|asked|asks|replied|replies|answered|answers|murmur\w*|whisper\w*|mutter\w*|shout\w*|yell\w*|cried|cries|breath\w*|add\w*|offer\w*|snap\w*|hiss\w*|growl\w*|purr\w*|laugh\w*|sigh\w*|tell\w*|told|repeat\w*|insist\w*|admit\w*|confess\w*|declar\w*|announc\w*|read aloud|quot\w*)\b/i;

/**
 * Is this quoted span SPEECH, or scare quotes in narration?
 *
 * `She fell inside the chasm. Of course, the "charming" rope was not enough` —
 * `"charming"` is ironic emphasis, not a line of dialogue, and styling it as
 * speech (and reading it aloud in the character's voice) is wrong in a way the
 * reader notices immediately. Quoted words are used for scare quotes, titles,
 * jargon and nicknames all through ordinary prose.
 *
 * The reliable signal is punctuation POSITION. Speech carries its terminal mark
 * INSIDE the closing quote — `"Hello," she said.` / `"Hello."` / `"Wait—"` —
 * because that is simply how dialogue is typeset. Scare quotes carry none: the
 * sentence's punctuation is outside, and the phrase sits mid-clause.
 *
 * The one common exception is an attributed fragment with no internal mark
 * (`She said "nothing at all" and left`), which the speech verb beside it
 * catches. Anything else is left as narration — a false negative costs a line
 * of colour, a false positive puts narration in a character's mouth.
 *
 * `call` is deliberately NOT an attribution verb here. It usually means naming
 * rather than speaking — `he called it "a mistake"`, `the so-called "expert"` —
 * and the genuinely spoken use (`"Wait!" she called`) already has its
 * punctuation inside the quote.
 */
export const looksLikeSpeech = (body: string, before = '', after = ''): boolean => {
  const inner = body.trim();
  if (!inner) return false;
  // Terminal punctuation inside the quote: how dialogue is typeset.
  if (/[.,!?;:…—–]["'’”]?$/.test(inner)) return true;
  // An attribution next to it, either side.
  if (SPEECH_VERB.test(before) || SPEECH_VERB.test(after)) return true;
  // A long capitalised span with no internal punctuation is still far more
  // likely a spoken fragment than a nickname. Six words is deliberately high:
  // titles and jargon are short, sentences are not.
  const words = inner.split(/\s+/).length;
  return words >= 6 && /^["'“‘]?[\p{Lu}]/u.test(inner);
};

/** Matches an OOC aside: [OOC: ...] or (OOC: ...), case-insensitive. */
const OOC_RE = /([[(])\s*OOC\b[^\])]*[\])]/gi;

/** Apply the reader's OOC preference: leave, dim (italic-muted), or remove. */
export const applyOoc = (text: string, mode: OocHandling = 'show'): string => {
  if (mode === 'show') return text;
  if (mode === 'hide') {
    // Drop the aside and tidy up the whitespace/blank line it leaves behind.
    return text.replace(OOC_RE, '').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n');
  }
  // dim: wrap in emphasis so it renders muted-italic (strip inner * to stay valid).
  return text.replace(OOC_RE, m => `*${m.replace(/\*/g, '')}*`);
};

/** Convert inline <img> HTML into markdown images so they render natively. */
export const normalizeImages = (text: string): string =>
  text.replace(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi, (_m, src) => `\n\n![](${src})\n\n`);

export const processText = (text: string, opts: ProcessOptions = {}) => {
  let processed = applyOoc(normalizeImages(text), opts.oocHandling);

  if (opts.substituteNames) {
    if (opts.characterName) processed = processed.replace(/\{\{char\}\}/gi, opts.characterName);
    if (opts.userName) processed = processed.replace(/\{\{user\}\}/gi, opts.userName);
  }

  if (opts.hideMetadata) {
    // Removes {{[INPUT]}}, {{[OUTPUT]}}, {{[SYSTEM]}}, and any generic <|tag|>
    processed = processed
      .replace(/\{\{\s*\[?INPUT\]?\s*\}\}/gi, '')
      .replace(/\{\{\s*\[?OUTPUT\]?\s*\}\}/gi, '')
      .replace(/\{\{\s*\[?SYSTEM\]?\s*\}\}/gi, '')
      .replace(/<\|.*?\|>/g, '');
  }

  if (opts.autoFormat) {
    (opts.autoFormatRules ?? [])
      .filter(r => r.enabled && ruleAppliesTo(r, opts.role))
      .forEach(rule => {
        const regex = compileRule(rule);
        if (regex) processed = processed.replace(regex, rule.replacement);
      });

    if (opts.smartTypography) {
      processed = processed
        .replace(/\.{3,}/g, '…')
        .replace(/(\w)\s*--\s*(\w)/g, '$1—$2')
        .replace(/\s+([,.!?;:])(?=\s|$)/g, '$1');
    }

    if (opts.paragraphSpacing ?? true) {
      // Single newlines become paragraph breaks
      processed = processed.replace(/([^\n])\n(?!\n)/g, '$1\n\n');
    }

    if (opts.dialogueOwnLine) {
      // Give quoted dialogue its own paragraph
      processed = processed.replace(/([^\n"“])[ \t]*(["“][^"”\n]+["”])/g, '$1\n\n$2');
      processed = processed.replace(/(["“][^"”\n]+["”])[ \t]*(?=[^\s"“])/g, '$1\n\n');
    }

    processed = processed.replace(/\n{3,}/g, '\n\n');

    // Prevent stray bullet lists: after paragraph-splitting, any line the author
    // began with `*`, `-`, or `+ ` (an action asterisk or a dash — never a real
    // list in prose roleplay) gets parsed by markdown as a list item. Escape a
    // leading marker that is followed by a space so it renders literally.
    // A leading `*word*` action has no space after the `*`, so it's untouched.
    processed = processed.replace(/^([ \t]*)([-+])([ \t]+)/gm, '$1\\$2$3');
    processed = processed.replace(/^([ \t]*)\*([ \t]+)/gm, '$1\\*$2');
  }

  // Close dangling quotes / emphasis so misformatted prose renders cleanly.
  // Runs after paragraph structure is settled but before quotes get wrapped.
  // Default on; speech/streaming callers pass false.
  if (opts.repairFormatting !== false) {
    processed = repairFormatting(processed);
  }

  if (opts.styleQuotes) {
    /**
     * Wrap quoted speech in `* *` so it renders as <em> and themes can style
     * it as dialogue.
     *
     * The body used to exclude `*`, which meant ANY line of dialogue
     * containing emphasis — `"You'd stand behind *my* counter?"` — was skipped
     * entirely and rendered as narration. That is common in roleplay prose, so
     * it looked like the dialogue styling had randomly stopped working.
     *
     * Emphasis can't nest in the same delimiter, so inner `*…*` is rewritten to
     * the equivalent `_…_` form and the wrap goes on the outside. Any leftover
     * lone `*` is escaped — an unbalanced marker would otherwise swallow the
     * wrap and eat the rest of the paragraph.
     */
    const wrapQuote = (open: string, body: string, close: string): string =>
      `*${open}${body
        .replace(/\*\*\*([^*]+)\*\*\*/g, '___$1___')
        .replace(/\*\*([^*]+)\*\*/g, '__$1__')
        .replace(/\*([^*]+)\*/g, '_$1_')
        .replace(/\*/g, '\\*')}${close}*`;

    // Two passes so each quoted span can be judged with the words around it.
    const speechPass = (open: string, close: string) => {
      const re = new RegExp(
        `(^|[\\s({\\[—–-])${open}([^${close}\\n]+)${close}(?=[\\s.,!?;:)}\\]—–-]|$)`,
        'g',
      );
      processed = processed.replace(re, (m, pre: string, body: string, at: number) => {
        const before = processed.slice(Math.max(0, at - 40), at + pre.length);
        const after = processed.slice(at + m.length, at + m.length + 40);
        return looksLikeSpeech(body, before, after)
          ? `${pre}${wrapQuote(open, body, close)}`
          : m;
      });
    };
    speechPass('"', '"');
    speechPass('“', '”');
    /**
     * Single quotes, on what is left OUTSIDE the spans just wrapped.
     *
     * A single-quoted phrase inside speech — `"The 'Silent Observer' becoming
     * the 'Main Attraction'."` — is scare quotes, not a second speaker, and
     * wrapping it put a `*…*` span INSIDE the `*…*` that already covers the
     * whole line. Markdown reads that as three separate emphasis runs, so the
     * first two words styled as dialogue and the rest of the sentence fell out
     * of it; Book's renderer produced crossing tags and mangled the paragraph
     * outright.
     *
     * So the wrapped spans are parked behind sentinels first, exactly as
     * `renderInline` parks generated HTML, and restored after.
     */
    const parked: string[] = [];
    // Private-use delimiters, not bare indices: a bare index would be
    // indistinguishable from "he was 42 years old" on the way back.
    processed = processed.replace(/\*["“][^\n]*?["”]\*/g,
      (m) => `\uE000${parked.push(m) - 1}\uE001`);
    // Single quotes keep the stricter rule on purpose: apostrophes are
    // everywhere in prose, and loosening this starts turning `don't ... can't`
    // into speech.
    /*
     * Every surviving single-quoted span is wrapped, speech or not.
     *
     * It used to run `looksLikeSpeech` here and drop anything that failed, so
     * `'the arrangement'` rendered as bare prose. That was right while single
     * quotes shared the dialogue look — a scare quote is not a second speaker.
     * It stopped being right when `'…'` became its own channel (the ASIDE, see
     * utils/markupStyles): the reader now picks one treatment for the mark
     * itself, and thought, scare quotes and British speech are all it.
     *
     * The BOUNDARY rule is untouched, and is the part that matters: the opening
     * quote must follow whitespace or an opening bracket and the closing one
     * must precede whitespace or punctuation, which is what keeps `don't` and
     * `readin'` out of it.
     */
    processed = processed.replace(
      /(^|[\s({\[—–-])'([^'*\n]+)'(?=[\s.,!?;:)}\]—–-]|$)/g,
      (_m, pre: string, body: string) => `${pre}*'${body}'*`,
    );
    processed = processed.replace(/\uE000(\d+)\uE001/g, (_m, i: string) => parked[Number(i)]);
  }

  return { processedText: processed };
};

/**
 * Close dangling emphasis markers so a partially streamed message renders
 * styled (italic/bold applied live) instead of showing literal asterisks.
 */
export const balanceEmphasis = (text: string): string => {
  // Drop a trailing, content-less marker run (e.g. "he said *" mid-type) so
  // the span's styling doesn't flip on/off — the main cause of "shaking" as
  // characters reveal past an asterisk or quote.
  let out = text.replace(/(?:\*{1,3}|_{1,3}|`+)$/, '');
  const boldCount = (out.match(/\*\*/g) ?? []).length;
  if (boldCount % 2 === 1) out += '**';
  const singleCount = (out.replace(/\*\*/g, '').match(/\*/g) ?? []).length;
  if (singleCount % 2 === 1) out += '*';
  const ticks = (out.match(/`/g) ?? []).length;
  if (ticks % 2 === 1) out += '`';
  return out;
};

/**
 * Repair one paragraph's dangling markup: close an unterminated quote, and
 * balance an italic/bold run that was left open (or closed) — the classic
 * roleplay breakages where dialogue is cut off (`"the razor was a blade`) or an
 * emphasis run got split across a blank line (markdown italics can't cross one).
 * Balanced text is returned unchanged. Placement mirrors the SillyTavern
 * "auto-balance" rule: a run opened at the paragraph start is closed at its end;
 * a stray closer with no opener gets one prepended.
 */
const repairParagraph = (p: string): string => {
  if (!p.trim()) return p;
  let out = p;

  // Unterminated straight double-quote → close it at the paragraph end.
  if (((out.match(/"/g) ?? []).length) % 2 === 1) out = out.replace(/(\s*)$/, '"$1');
  // Smart quotes: add as many closers as there are unmatched openers.
  const opens = (out.match(/“/g) ?? []).length;
  const closes = (out.match(/”/g) ?? []).length;
  if (opens > closes) out = out.replace(/(\s*)$/, '”'.repeat(opens - closes) + '$1');

  // Unbalanced bold → close it.
  if (((out.match(/\*\*/g) ?? []).length) % 2 === 1) out = out.replace(/(\s*)$/, '**$1');
  // Unbalanced single-asterisk italics → balance by where the run sits.
  const singles = (out.replace(/\*\*/g, '').match(/\*/g) ?? []).length;
  if (singles % 2 === 1) {
    if (/^\s*\*(?!\*)/.test(out)) out = out.replace(/(\s*)$/, '*$1'); // opened, not closed
    else out = out.replace(/^(\s*)/, '$1*');                          // closed, not opened
  }
  return out;
};

/**
 * Presentation-only formatting repair for settled prose: fixes unterminated
 * dialogue and split emphasis runs paragraph by paragraph, leaving the source
 * untouched. Code spans/blocks are guarded so their contents are never
 * rebalanced. (The streaming tail uses `balanceEmphasis` instead.)
 */
const CODE_GUARD_OPEN = '';
const CODE_GUARD_CLOSE = '';
const CODE_GUARD_RE = new RegExp(CODE_GUARD_OPEN + '(\\d+)' + CODE_GUARD_CLOSE, 'g');

export const repairFormatting = (text: string): string => {
  const stash: string[] = [];
  const guard = (s: string) => `${CODE_GUARD_OPEN}${stash.push(s) - 1}${CODE_GUARD_CLOSE}`;
  const guarded = text
    .replace(/```[\s\S]*?```/g, guard)
    .replace(/`[^`\n]*`/g, guard);

  // Even indices are paragraphs; odd indices are the \n\n separators (kept as-is).
  const repaired = guarded
    .split(/(\n{2,})/)
    .map((seg, i) => (i % 2 === 0 ? repairParagraph(seg) : seg))
    .join('');

  return repaired.replace(CODE_GUARD_RE, (_m, n) => stash[Number(n)]);
};

/**
 * For the live-streaming message only: drop the trailing in-progress word so
 * the rendered text never contains a partial word that grows and re-wraps at
 * the right margin every frame (the residual "streaming shake"). The hidden
 * final word appears as soon as its terminating space/newline streams in, or
 * when the message commits. Left untouched when there's no whitespace yet.
 */
export const truncateToWord = (text: string): string => {
  // Already ends on a boundary — nothing in progress to hide.
  if (!text || /\s$/.test(text)) return text;
  const lastBreak = Math.max(text.lastIndexOf(' '), text.lastIndexOf('\n'));
  if (lastBreak <= 0) return text; // single unbroken token — show it
  return text.slice(0, lastBreak + 1);
};

/** Strip markdown/markup for text-to-speech. */
export const plainTextForSpeech = (text: string): string =>
  text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`~#]+/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
