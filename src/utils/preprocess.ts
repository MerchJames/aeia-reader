/**
 * A second pass over a reply, before the reader sees it.
 *
 * ── Why a second call rather than a bigger first one ───────────────────────
 *
 * The obvious fix for "the model forgot the anatomy pin" is to put the anatomy
 * pin in the prompt. It does not work, and the reason is structural: a single
 * forward pass has a fixed attention budget, and everything added to the
 * context competes with the generation for it. Past a point more context makes
 * output worse, not better — the middle of a long prompt is attended to poorly,
 * and instruction count trades against instruction-following. On a 7B running
 * locally this is not a subtle effect.
 *
 * So a single-pass limitation cannot be fixed by enlarging the single pass.
 *
 * What a second call buys is not more of the same work. It is a DIFFERENT KIND
 * of work: "does this reply contradict this one fact — quote the sentence or
 * say NONE" is close to a classification task, and small models are decent at
 * those. "Write well, using all of this" is open-ended, and they are not.
 * Narrow verification is reliable exactly where broad generation is not.
 *
 * The cost is time, and the time is the point. This is test-time compute spent
 * on a specific, checkable question.
 *
 * ── The four rules that keep it from making things worse ───────────────────
 *
 * A critique pass can absolutely damage a good reply. These are the guards.
 *
 * **NONE is the expected answer.** Most replies contradict nothing. A verdict
 * parser that resolves ambiguity toward "contradicts" would rewrite every
 * message in the chat, so this one resolves ambiguity toward leaving things
 * alone, and only acts on an unambiguous quoted span.
 *
 * **Repairs are surgical.** One sentence, replaced in place, told to keep the
 * voice and the length. Whole-reply rewrites are where prose flattens into
 * house style, and that is the failure that would make somebody switch this
 * off for good.
 *
 * **A repair that changes too much is refused.** If a "fix this sentence" call
 * comes back with three paragraphs, the model has misunderstood the job.
 * Measured with the same word diff the Lens preview uses.
 *
 * **The original is never lost.** This module produces a revision and the
 * ORIGINAL beside it; what applies them keeps both. Nothing here can silently
 * replace what the model wrote.
 *
 * Pure: no fetch, no store, no React. The calls are made by the runner.
 */

import { changeRatio, diffWords } from './textDiff';

/** Something the reply is checked against. */
export interface CheckFact {
  id: string;
  /** Where it came from, so the reader can see why a change was suggested. */
  source: 'pin' | 'sheet' | 'summary' | 'note';
  title: string;
  text: string;
}

export type StageKind =
  /** Deterministic reshaping. No model, no cost. */
  | 'format'
  /** One narrow question about one fact. */
  | 'check'
  /** Rewriting one sentence that failed a check. */
  | 'repair';

export interface Stage {
  kind: StageKind;
  /** Shown on the extension's status line, so it says what is happening. */
  label: string;
  factId?: string;
}

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

/**
 * How many facts one reply is checked against.
 *
 * Each is a model call, and they are serial, so this number IS the latency.
 * Six is roughly the point where a local model's round trip stops feeling like
 * a pause and starts feeling like a hang.
 */
export const MAX_CHECKS = 6;

/** How many sentences may be repaired in one reply. */
export const MAX_REPAIRS = 3;

/** A fact longer than this is truncated — a whole chapter is not a check. */
export const MAX_FACT_CHARS = 1200;

/**
 * How much a "fix this one sentence" call may change the reply.
 *
 * A surgical edit moves a few words. Anything past this means the model
 * rewrote more than it was asked to, and the reply is left alone instead.
 */
export const MAX_REPAIR_RATIO = 0.4;

/* ------------------------------------------------------------------ */
/* Which facts are worth spending a call on                            */
/* ------------------------------------------------------------------ */

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for',
  'with', 'from', 'by', 'is', 'was', 'are', 'were', 'be', 'been', 'it', 'its',
  'he', 'she', 'they', 'them', 'his', 'her', 'their', 'you', 'your', 'i', 'me',
  'my', 'we', 'us', 'our', 'that', 'this', 'these', 'those', 'as', 'if', 'not',
  'no', 'so', 'than', 'then', 'there', 'here', 'what', 'when', 'who', 'how',
]);

const terms = (s: string): Set<string> => {
  const out = new Set<string>();
  for (const w of s.toLowerCase().split(/[^a-z0-9']+/)) {
    if (w.length > 3 && !STOP.has(w)) out.add(w);
  }
  return out;
};

/**
 * Score a fact's relevance to a reply, by shared vocabulary.
 *
 * Deliberately crude, and deliberately not a model call — working out whether
 * to spend a call must not itself cost a call. The job is only to keep an
 * anatomy chart from being checked against a conversation in a tavern, and
 * word overlap does that well enough.
 *
 * Proper nouns are the strongest signal in practice, and they survive this
 * because they are long and not stopwords.
 */
export const relevance = (reply: string, fact: CheckFact): number => {
  const a = terms(reply);
  const b = terms(`${fact.title} ${fact.text}`);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of b) if (a.has(w)) shared++;
  // Normalised by the FACT's vocabulary, not the union: a long pin that shares
  // six words with the reply is less relevant than a short one that shares six.
  return shared / Math.min(b.size, 40);
};

/** The facts worth checking, most relevant first. */
export const relevantFacts = (
  reply: string, facts: readonly CheckFact[], limit = MAX_CHECKS, floor = 0.06,
): CheckFact[] =>
  facts
    .map(fact => ({ fact, score: relevance(reply, fact) }))
    .filter(r => r.score >= floor)
    .sort((a, b) => b.score - a.score || a.fact.id.localeCompare(b.fact.id))
    .slice(0, Math.max(0, limit))
    .map(r => r.fact);

/* ------------------------------------------------------------------ */
/* The narrow question                                                 */
/* ------------------------------------------------------------------ */

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * One check, as a prompt.
 *
 * Everything about the wording is aimed at making NONE easy to say. The
 * instruction leads with it, the examples lead with it, and the model is told
 * explicitly that most replies are fine — because a model that believes it is
 * looking for problems will find them.
 *
 * It is also told to quote VERBATIM, because the quote is the only thing that
 * makes a surgical repair possible: a paraphrase cannot be located in the text.
 */
export const buildCheckPrompt = (reply: string, fact: CheckFact): string => [
  'You are checking one reply against one established fact. This is a narrow',
  'question, not an edit — do not rewrite anything.',
  '',
  `ESTABLISHED FACT (${fact.source}: ${fact.title}):`,
  clip(fact.text, MAX_FACT_CHARS),
  '',
  'THE REPLY:',
  reply,
  '',
  'Does any sentence in the reply CONTRADICT the established fact?',
  '',
  'Most replies do not. A reply that simply does not mention the fact is fine —',
  'that is not a contradiction. Only an actual conflict counts.',
  '',
  'Answer with exactly one of:',
  '  NONE',
  '  CONTRADICTS: "<the one sentence, copied word for word from the reply>"',
  '',
  'Copy the sentence exactly. Do not paraphrase it, do not correct it, and do',
  'not explain. If you are unsure, answer NONE.',
].join('\n');

export interface Verdict {
  contradicts: boolean;
  /** The quoted sentence, when there is one. */
  sentence: string;
  /** Why a claimed contradiction was not acted on. */
  rejected?: string;
}

const NONE_RE = /\bnone\b|\bno contradiction\b|\bdoes not contradict\b|\bno conflict\b/i;

/**
 * Read a verdict, biased hard toward doing nothing.
 *
 * Four ways this returns "no": the model said none, the model said nothing
 * parseable, the model quoted something that is not in the reply, or the quote
 * is so short it could match anywhere. Only an exact, locatable, substantial
 * span counts as a finding.
 *
 * The "not in the reply" case is the one that matters most. A model that
 * paraphrases the offending sentence has given us something we cannot splice,
 * and splicing an approximate match would corrupt the reply in a way nobody
 * would catch until they reread it.
 */
export const readVerdict = (raw: string, reply: string): Verdict => {
  const text = (raw ?? '').trim();
  if (!text) return { contradicts: false, sentence: '' };

  // NONE anywhere before a claim wins. Models like to preamble.
  const claim = text.match(/contradicts?\s*:\s*(.+)/is);
  if (!claim) {
    return { contradicts: false, sentence: '' };
  }
  if (NONE_RE.test(text.slice(0, text.indexOf(claim[0])))) {
    return { contradicts: false, sentence: '' };
  }

  // The first line only, BEFORE unquoting. A model that explains itself after
  // the quote is common, and stripping quotes first would fail to match the
  // closing mark and leave both marks embedded in the span — which then never
  // matches the reply, so a real finding is silently discarded.
  let quoted = claim[1].split('\n')[0].trim();
  // Strip one layer of quoting, in any of the marks a model might reach for.
  const m = quoted.match(/^["'“”‘’«»](.+?)["'“”‘’«»]\s*$/s);
  if (m) quoted = m[1].trim();
  if (!quoted) return { contradicts: false, sentence: '' };

  if (quoted.length < 12) {
    return {
      contradicts: false, sentence: '',
      rejected: 'the quoted span was too short to locate safely',
    };
  }
  if (!reply.includes(quoted)) {
    return {
      contradicts: false, sentence: '',
      rejected: 'the quoted sentence is not in the reply word for word',
    };
  }
  return { contradicts: true, sentence: quoted };
};

/* ------------------------------------------------------------------ */
/* The surgical fix                                                    */
/* ------------------------------------------------------------------ */

export const buildRepairPrompt = (
  reply: string, sentence: string, fact: CheckFact,
): string => [
  'Rewrite ONE sentence so that it agrees with an established fact.',
  '',
  `ESTABLISHED FACT (${fact.source}: ${fact.title}):`,
  clip(fact.text, MAX_FACT_CHARS),
  '',
  'THE SENTENCE TO REWRITE:',
  sentence,
  '',
  'It appears in this passage, for context only:',
  clip(reply, 2000),
  '',
  'Rewrite the sentence so it no longer conflicts with the fact. Keep the same',
  'voice, the same tense, and roughly the same length. Change as little as you',
  'can — usually a few words. Do not add new events, do not explain, and do not',
  'write anything except the rewritten sentence.',
].join('\n');

export interface Repair {
  ok: boolean;
  /** The whole reply with the sentence replaced. */
  text: string;
  /** Why a repair was refused. */
  refused?: string;
}

/**
 * Put a rewritten sentence back, or refuse to.
 *
 * Three refusals, and each is a real thing models do when asked to rewrite one
 * sentence: return the whole passage, return an explanation, or return
 * something so different that it is a new sentence rather than a corrected one.
 * A refusal leaves the reply exactly as the model wrote it, which is always a
 * safe outcome.
 */
export const applyRepair = (
  reply: string, sentence: string, rewritten: string,
): Repair => {
  const clean = (rewritten ?? '').trim().replace(/^["'“”]|["'“”]$/g, '').trim();
  if (!clean) return { ok: false, text: reply, refused: 'the rewrite came back empty' };
  if (!reply.includes(sentence)) {
    return { ok: false, text: reply, refused: 'the sentence is no longer in the reply' };
  }
  if (clean === sentence) {
    return { ok: false, text: reply, refused: 'the rewrite was identical' };
  }
  // A "sentence" several times longer than the original is the model having
  // rewritten the passage, or having explained itself instead. The floor is low
  // on purpose: with a high one, a short sentence swapped for three paragraphs
  // slips past here and is caught by the ratio guard instead, which then
  // reports a percentage where the honest answer is "that is not a sentence".
  if (clean.length > Math.max(200, sentence.length * 3)) {
    return { ok: false, text: reply, refused: 'the rewrite was far longer than the sentence' };
  }

  const next = reply.replace(sentence, clean);
  const moved = changeRatio(diffWords(reply, next));
  if (moved > MAX_REPAIR_RATIO) {
    return {
      ok: false, text: reply,
      refused: `the rewrite changed ${Math.round(moved * 100)}% of the reply, which is not a repair`,
    };
  }
  return { ok: true, text: next };
};

/* ------------------------------------------------------------------ */
/* A run, start to finish                                              */
/* ------------------------------------------------------------------ */

export interface RunFinding {
  factId: string;
  factTitle: string;
  sentence: string;
  /** True when the sentence was actually rewritten. */
  repaired: boolean;
  /** Present when a finding or a repair was declined, with the reason. */
  skipped?: string;
}

export interface PreprocessRun {
  /** What the model originally wrote. Always kept. */
  original: string;
  /** What the reader should see, which equals `original` when nothing changed. */
  text: string;
  /** True when the deterministic format pass alone changed something. */
  reformatted: boolean;
  findings: RunFinding[];
  /** Model calls actually made, for the status line and for judging the cost. */
  calls: number;
  /** Wall time in ms. */
  ms: number;
}

export const emptyRun = (original: string): PreprocessRun => ({
  original, text: original, reformatted: false, findings: [], calls: 0, ms: 0,
});

export const changedAnything = (run: PreprocessRun): boolean =>
  run.text !== run.original;

/**
 * What the run did, for the extension's status line and the reader's log.
 *
 * Says nothing happened when nothing happened, in those words. A pre-processor
 * that reports activity on every turn teaches people to ignore it, and the one
 * turn it caught something real would scroll past unread.
 */
export const summarizeRun = (run: PreprocessRun): string => {
  const parts: string[] = [];
  if (run.reformatted) parts.push('reformatted');
  const fixed = run.findings.filter(f => f.repaired).length;
  if (fixed) parts.push(`fixed ${fixed} contradiction${fixed === 1 ? '' : 's'}`);
  const found = run.findings.length - fixed;
  if (found) parts.push(`flagged ${found} it could not repair`);

  if (!parts.length) {
    return run.calls
      ? `Checked against ${run.calls} fact${run.calls === 1 ? '' : 's'} — nothing to change.`
      : 'Nothing to check.';
  }
  return `${parts.join(', ')} in ${(run.ms / 1000).toFixed(1)}s.`;
};

/** One line per stage, so the extension can show progress as it happens. */
export const stagesFor = (facts: readonly CheckFact[]): Stage[] => [
  { kind: 'format', label: 'Tidying the shape' },
  ...facts.map(f => ({
    kind: 'check' as const, label: `Checking against ${f.title}`, factId: f.id,
  })),
];
