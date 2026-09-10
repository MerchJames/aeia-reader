/**
 * Chatter Blend — weaving a turn and its reply into one passage.
 *
 * ── The problem ────────────────────────────────────────────────────────────
 *
 * Roleplay chat has a shape that prose does not. You write three things — you
 * cross the room, you ask a question, you put your hand on the door — and the
 * character answers all three in one block, in order, like a form being filled
 * in. Nothing in a novel reads that way. A reply comes between the acts, not
 * after all of them, and the two people's actions interleave.
 *
 * The information is all there. Only the arrangement is wrong. So this takes a
 * chain — which in Aeia is exactly one user turn and the reply to it — and asks
 * for the same events, rewritten as one continuous passage.
 *
 * ── Why it is a whole alternate chain and not an override ──────────────────
 *
 * `MessageOverride` replaces the CONTENT of one message. A blend is not that:
 * two messages become one, so the chain's shape changes and no per-message
 * layer can express it. Hence `LensChain` — an alternate set of messages for
 * one chain, which the reader swaps to and away from in the Overview, leaving
 * the original entirely untouched underneath.
 *
 * That is also the safety story. Nothing here edits a story. The worst a bad
 * blend can do is sit unselected in a list.
 *
 * ── What gets refused ──────────────────────────────────────────────────────
 *
 * A model asked to merge two passages will, given the chance:
 *
 *   - **summarise them**, which is the failure that looks most like success —
 *     the result is coherent, well written, and half the story is gone;
 *   - **drop the reader's turn**, keeping the character's reply and narrating
 *     around it, because the reply is longer and reads as the "real" content;
 *   - **write a third scene**, inventing a room, a gesture, a line of dialogue
 *     that neither message contained.
 *
 * None of those throw and none of them look wrong in isolation. So `readBlend`
 * measures: how much of each source survived, and how much appeared that was
 * in neither. A blend that fails is refused with a reason, and the reader is
 * shown the diff before anything is kept regardless.
 *
 * Pure: no store, no React, no fetch.
 */

import type { Chain, Message } from '../types';
import { diffWords } from './textDiff';

/* ------------------------------------------------------------------ */
/* Shapes                                                              */
/* ------------------------------------------------------------------ */

/** What a blend is built from: one chain, flattened into two voices. */
export interface BlendSource {
  chainId: string;
  userName: string;
  userText: string;
  aiName: string;
  aiText: string;
  /** Every message id the blend stands in for. */
  messageIds: string[];
}

/**
 * An alternate set of messages for one chain.
 *
 * `kind` is here for the ones that will follow — a blend is the first of these,
 * not the only conceivable one.
 */
export interface LensChain {
  id: string;
  /** The chain it is an alternate of. */
  chainId: string;
  kind: 'blend';
  /** Shown in the Overview's switcher. */
  label: string;
  messages: Message[];
  /** The message ids it was built from, so a changed chain can be detected. */
  sourceIds: string[];
  createdAt: number;
}

/* ------------------------------------------------------------------ */
/* Caps                                                                */
/* ------------------------------------------------------------------ */

/** Below this there is nothing in a turn worth weaving. "ok", "continue". */
export const MIN_TURN_CHARS = 12;
/** A chain this long is a scene, and blending it is a rewrite of the story. */
export const MAX_SOURCE_CHARS = 12_000;

/**
 * How much of the source's distinctive words must survive.
 *
 * Not high, and it cannot be: blending paraphrases by design — "*I set the cup
 * down*" becomes "She set the cup down" — so exact retention is never near 1.
 * What this catches is the summary, where whole clauses stop existing. Measured
 * separately per voice, because the failure is asymmetric: the reply is longer
 * and survives on its own while the reader's turn quietly evaporates.
 */
export const MIN_RETENTION = 0.35;
export const MIN_USER_RETENTION = 0.25;

/** Shorter than this share of the two sources together and it summarised. */
export const MIN_LENGTH_RATIO = 0.55;
/** Longer than this and it wrote a new scene. */
export const MAX_LENGTH_RATIO = 1.6;

/* ------------------------------------------------------------------ */
/* Reading a chain                                                     */
/* ------------------------------------------------------------------ */

const textOf = (messages: readonly Message[]): string =>
  messages.map(m => m.content.trim()).filter(Boolean).join('\n\n');

/**
 * Flatten a chain into the two voices, or null when there is nothing to blend.
 *
 * Hidden messages are excluded: they are `/hide`-den narrator notes the reader
 * has already said they do not want in the story, and folding one into a
 * passage would put it back permanently.
 */
export const blendSource = (chain: Chain): BlendSource | null => {
  // The story's own messages, never a blend already being shown. Blending a
  // blend would weave a passage with itself and lose whatever the first pass
  // dropped, permanently as far as the reader can tell.
  const visible = (chain.sourceMessages ?? chain.messages).filter(m => !m.hidden);
  const user = visible.filter(m => m.role === 'user');
  const ai = visible.filter(m => m.role !== 'user');
  if (!user.length || !ai.length) return null;
  return {
    chainId: chain.id,
    userName: user[0].name || 'You',
    userText: textOf(user),
    aiName: ai[0].name || 'Them',
    aiText: textOf(ai),
    messageIds: visible.map(m => m.id),
  };
};

/**
 * Why this chain cannot be blended, or null when it can.
 *
 * Each of these is a case where the feature would run, cost a call, and return
 * something worse than what was there.
 */
export const blendProblem = (chain: Chain): string | null => {
  const source = blendSource(chain);
  if (!source) {
    return 'A blend needs both halves — your turn and the reply to it. This passage only has one.';
  }
  if (source.userText.trim().length < MIN_TURN_CHARS) {
    return 'There is nothing in your turn to weave in — it is barely a word.';
  }
  if (source.aiText.trim().length < MIN_TURN_CHARS) {
    return 'The reply is too short to blend with anything.';
  }
  if (source.userText.length + source.aiText.length > MAX_SOURCE_CHARS) {
    return 'That passage is long enough to be a chapter. Blending it would be a rewrite rather'
      + ' than a rearrangement.';
  }
  return null;
};

/* ------------------------------------------------------------------ */
/* The prompt                                                          */
/* ------------------------------------------------------------------ */

/**
 * The instruction.
 *
 * The order is deliberate. What NOT to do comes before the material, because a
 * model that reads two passages first begins improving them; the material comes
 * before the final restatement, because the last thing said is the thing most
 * obeyed, and the thing most worth repeating is "add nothing".
 */
export const buildBlendPrompt = (source: BlendSource): string => [
  'Below are two halves of one moment in a story: what one person did and said,'
  + ' and the other person’s reply to all of it at once.',
  '',
  'Rewrite them as ONE passage of continuous prose, in which the two interleave the'
  + ' way they would in a novel — each reply landing next to the thing it answers,'
  + ' rather than all of one and then all of the other.',
  '',
  'Rules, all of which matter more than the writing:',
  '- Every action, every line of dialogue and every detail in both halves must survive.'
  + ' You are rearranging, not editing.',
  '- Add nothing. No new dialogue, no new gestures, no new room, no scene-setting'
  + ' that was not already there.',
  '- Keep the voice and tense of the reply.',
  `- Keep both people distinct. ${source.userName} is one of them; ${source.aiName} is the other.`,
  '- Keep roughly the same length. A shorter passage means you cut something.',
  '',
  `WHAT ${source.userName.toUpperCase()} DID:`,
  source.userText.trim(),
  '',
  `WHAT ${source.aiName.toUpperCase()} REPLIED:`,
  source.aiText.trim(),
  '',
  'Reply with the woven passage and nothing else. Do not summarise it, do not explain'
  + ' what you changed, and do not leave anything out.',
].join('\n');

/* ------------------------------------------------------------------ */
/* Reading the answer                                                  */
/* ------------------------------------------------------------------ */

const STOPWORDS = new Set([
  'the', 'and', 'that', 'with', 'this', 'from', 'they', 'have', 'been', 'were',
  'what', 'when', 'then', 'than', 'them', 'there', 'their', 'would', 'could',
  'about', 'into', 'over', 'just', 'like', 'said', 'says', 'your', 'you', 'her',
  'his', 'him', 'she', 'not', 'but', 'for', 'was', 'are', 'his', 'its', 'had',
]);

/** Words worth checking for: long enough to be distinctive, not furniture. */
export const distinctive = (text: string): string[] => {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z']{4,}/g) ?? []) {
    const word = raw.replace(/'s$/, '');
    if (word.length < 4 || STOPWORDS.has(word)) continue;
    seen.add(word);
  }
  return [...seen];
};

/**
 * What share of a source's distinctive words are still in the blend.
 *
 * A share of the SOURCE's vocabulary, not of the blend's — the question is
 * "what did you lose", and a blend that added a hundred new words should not
 * score better for it.
 */
export const retention = (source: string, blend: string): number => {
  const words = distinctive(source);
  if (!words.length) return 1;
  const inBlend = new Set(distinctive(blend));
  let kept = 0;
  for (const word of words) if (inBlend.has(word)) kept++;
  return kept / words.length;
};

export interface BlendResult {
  /** The woven passage. Empty when refused. */
  text: string;
  rejected: string | null;
  /** Things worth saying that are not refusals. */
  notes: string[];
  /** For the panel: how much of each half survived, 0-1. */
  keptUser: number;
  keptAi: number;
}

const unfence = (raw: string): string => {
  const trimmed = (raw ?? '').trim();
  const match = trimmed.match(/^```[a-z0-9]*\s*\n([\s\S]*?)\n?```$/i);
  return match ? match[1].trim() : trimmed;
};

/**
 * Judge a blend.
 *
 * Everything refused here is something that would otherwise be shown to the
 * reader as a plausible alternate version of their scene.
 */
export const readBlend = (reply: string, source: BlendSource): BlendResult => {
  const text = unfence(reply);
  const no = (rejected: string): BlendResult =>
    ({ text: '', rejected, notes: [], keptUser: 0, keptAi: 0 });

  if (!text) return no('The model sent nothing back.');

  const combined = source.userText.length + source.aiText.length;
  const ratio = text.length / Math.max(1, combined);
  if (ratio < MIN_LENGTH_RATIO) {
    return no(
      `That came back ${Math.round((1 - ratio) * 100)}% shorter than the two passages together,`
      + ' which means it summarised them rather than weaving them.',
    );
  }
  if (ratio > MAX_LENGTH_RATIO) {
    return no(
      `That came back ${Math.round((ratio - 1) * 100)}% longer than the two passages together,`
      + ' so it wrote new material rather than rearranging what was there.',
    );
  }

  const keptUser = retention(source.userText, text);
  const keptAi = retention(source.aiText, text);

  if (keptUser < MIN_USER_RETENTION) {
    return no(
      // The most likely failure, and the least visible one: the reply is longer
      // and reads as the real content, so a model narrating "around" it
      // produces something that looks finished with the reader written out.
      'Almost nothing of your own turn survived that — the model kept the reply and wrote'
      + ' around you.',
    );
  }
  if (keptAi < MIN_RETENTION || keptUser < MIN_RETENTION) {
    return no('Too much of the original wording is missing for that to be a rearrangement.');
  }

  const notes: string[] = [];
  if (keptUser < 0.5) notes.push('Much of your turn is paraphrased rather than kept.');
  if (ratio < 0.8) notes.push('It is noticeably shorter than the two passages together.');

  return { text, rejected: null, notes, keptUser, keptAi };
};

/** The preview the reader sees before merging. Word-level, like the Lens. */
export const blendDiff = (source: BlendSource, blended: string) =>
  diffWords(`${source.userText}\n\n${source.aiText}`, blended);

/* ------------------------------------------------------------------ */
/* Making it a chain                                                   */
/* ------------------------------------------------------------------ */

let seq = 0;
export const lensChainId = (): string =>
  `lch${Date.now().toString(36)}${(seq++).toString(36)}`;

/**
 * The blend, as a chain the reader can switch to.
 *
 * One message, because that is what a blend IS — the two turns stopped being
 * two things. It carries the character's name and role so every view downstream
 * treats it as narrative rather than as the reader talking.
 *
 * Images from both halves come along. A picture attached to a turn is part of
 * the moment, and a blend that silently dropped one would be losing content
 * through a feature whose whole promise is that it loses none.
 */
export const makeLensChain = (
  source: BlendSource,
  text: string,
  chain: Chain,
  label = 'Blended',
): LensChain => {
  const images = chain.messages.flatMap(m => m.images ?? []);
  return {
    id: lensChainId(),
    chainId: source.chainId,
    kind: 'blend',
    label,
    messages: [{
      // Derived from the chain, so re-blending replaces rather than accumulates
      // in every map downstream that is keyed by message id.
      id: `${source.chainId}-blend`,
      role: 'ai',
      name: source.aiName,
      content: text,
      images: images.length ? images : undefined,
    }],
    sourceIds: source.messageIds,
    createdAt: Date.now(),
  };
};

/* ------------------------------------------------------------------ */
/* Living with them                                                    */
/* ------------------------------------------------------------------ */

/**
 * The blends to show, by chain id — what `buildChains` takes.
 *
 * Only chains with a live selection appear, and only when the blend behind it
 * still exists and still has something in it. Everything else is absent rather
 * than mapped to the original, so the store can tell "show a blend here" from
 * "there is nothing to do".
 */
export const blendMap = (
  lensChains: readonly LensChain[] | undefined,
  activeByChain: Record<string, string> | undefined,
): Record<string, Message[]> => {
  const out: Record<string, Message[]> = {};
  for (const [chainId, lensId] of Object.entries(activeByChain ?? {})) {
    const found = (lensChains ?? []).find(l => l.id === lensId && l.chainId === chainId);
    if (found?.messages.length) out[chainId] = found.messages;
  }
  return out;
};

/** Do two maps say the same thing? Used to leave the chains alone when so. */
export const sameBlends = (
  a: Record<string, Message[]>, b: Record<string, Message[]>,
): boolean => {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  // Identity on the message arrays, not deep equality: they come out of the
  // store and are replaced wholesale when they change, and a deep compare here
  // would run on every render of the reader.
  return ka.every(k => a[k] === b[k]);
};

/**
 * Has the chain moved since this blend was made?
 *
 * A swipe, an edit, a message arriving from a sync — any of them and the blend
 * describes a moment that no longer happened that way. Not deleted: shown as
 * stale, because the reader may still want it, and throwing away work they
 * asked for is not this feature's call to make.
 */
export const isStale = (lens: LensChain, chain: Chain): boolean => {
  // Against the real messages. A chain showing this very blend has one message
  // in `messages`, so comparing that would report every applied blend as stale.
  const now = (chain.sourceMessages ?? chain.messages).filter(m => !m.hidden).map(m => m.id);
  return now.length !== lens.sourceIds.length
    || now.some((id, i) => id !== lens.sourceIds[i]);
};

/** Blends for one chain, newest first. */
export const chainsFor = (
  lensChains: readonly LensChain[] | undefined, chainId: string,
): LensChain[] =>
  (lensChains ?? []).filter(l => l.chainId === chainId).sort((a, b) => b.createdAt - a.createdAt);

/** Add one, replacing any blend of the same chain with the same label. */
export const addLensChain = (
  existing: readonly LensChain[] | undefined, next: LensChain,
): LensChain[] => [
  ...(existing ?? []).filter(l => !(l.chainId === next.chainId && l.label === next.label)),
  next,
];

export const removeLensChain = (
  existing: readonly LensChain[] | undefined, id: string,
): LensChain[] => (existing ?? []).filter(l => l.id !== id);

/** One line for the switcher. */
export const describeBlend = (result: BlendResult): string => {
  const user = Math.round(result.keptUser * 100);
  const ai = Math.round(result.keptAi * 100);
  return `Kept ${user}% of your turn and ${ai}% of the reply, word for word.`;
};
