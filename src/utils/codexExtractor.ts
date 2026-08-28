import { listModels } from './aiClient';
import { askText, salvageArray } from './aiCall';
import { CodexEntity, EntityKind } from '../stores/useAuraV2Store';
import { CardInfo } from '../types';

/* ------------------------------------------------------------------ */
/* Extractor interface                                                 */
/*                                                                     */
/* An extractor takes a chunk of story text plus what's already known  */
/* and returns new/updated entities. Two implementations ship:         */
/*   - heuristicExtractor: zero-dependency, runs on anything, instant. */
/*   - createLLMExtractor: talks to any OpenAI-compatible endpoint.    */
/* ------------------------------------------------------------------ */

export interface ExtractedEntity {
  name: string;
  kind: EntityKind;
  summary: string;
  aliases: string[];
  mentions: number;
  source: 'heuristic' | 'ai';
}

export interface ExtractorContext {
  /** Names (and aliases) already in the codex — don't re-propose them. */
  knownNames: string[];
  characterName?: string;
  userName?: string;
}

export type EntityExtractor = (
  text: string, ctx: ExtractorContext,
) => Promise<ExtractedEntity[]>;

/* ------------------------------------------------------------------ */
/* Heuristic extractor                                                 */
/* ------------------------------------------------------------------ */

/** Words that look like names at sentence starts but never are. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'hers', 'its', 'our', 'their', 'mine', 'yours', 'theirs',
  'this', 'that', 'these', 'those', 'there', 'here', 'then', 'than', 'when', 'where', 'while',
  'what', 'who', 'whom', 'whose', 'which', 'why', 'how', 'and', 'but', 'or', 'nor', 'so', 'yet',
  'if', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'off', 'on', 'onto', 'out', 'over',
  'to', 'up', 'with', 'not', 'no', 'yes', 'oh', 'ah', 'um', 'hey', 'hello', 'hi', 'okay', 'ok',
  'well', 'now', 'just', 'still', 'even', 'also', 'too', 'very', 'suddenly', 'meanwhile', 'later',
  'finally', 'perhaps', 'maybe', 'please', 'thanks', 'thank', 'sorry', 'wait', 'stop', 'look',
  'listen', 'come', 'go', 'let', 'don', 'didn', 'wasn', 'isn', 'aren', 'can', 'could', 'should',
  'would', 'will', 'shall', 'may', 'might', 'must', 'do', 'does', 'did', 'is', 'was', 'are',
  'were', 'be', 'been', 'being', 'have', 'has', 'had', 'am', 'ooc', 'damn', 'god', 'gods',
  'right', 'left', 'good', 'bad', 'inside', 'outside', 'before', 'after', 'once', 'again',
  'every', 'all', 'some', 'any', 'each', 'both', 'few', 'more', 'most', 'other', 'such',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]);

/** Lowercase connectors allowed inside a multi-word name ("Tower of Dawn"). */
const CONNECTORS = new Set(['of', 'the', 'de', 'da', 'von', 'van', 'del', 'du', 'la', 'le']);

const LOCATION_CUES = new Set([
  'in', 'at', 'into', 'onto', 'toward', 'towards', 'near', 'inside', 'outside', 'within',
  'beneath', 'beyond', 'across', 'through', 'behind', 'above', 'below', 'around', 'past',
  'entered', 'entering', 'enters', 'reached', 'reaches', 'reaching', 'arrived', 'arrives',
  'visited', 'visits', 'leaving', 'leaves', 'approached', 'approaches', 'crossed',
]);

const LOCATION_SUFFIXES = new Set([
  'city', 'town', 'village', 'kingdom', 'empire', 'castle', 'keep', 'tower', 'fortress',
  'temple', 'church', 'cathedral', 'tavern', 'inn', 'forest', 'woods', 'mountain', 'mountains',
  'valley', 'river', 'lake', 'sea', 'ocean', 'island', 'isle', 'desert', 'plains', 'swamp',
  'cave', 'caverns', 'ruins', 'academy', 'guild', 'palace', 'manor', 'estate', 'harbor',
  'port', 'bridge', 'gate', 'gates', 'square', 'market', 'district', 'quarter', 'street',
  'road', 'alley', 'hall', 'hold', 'bay', 'cliffs', 'peak', 'pass', 'grove', 'garden',
]);

const ITEM_CUES = new Set([
  'holds', 'held', 'holding', 'wields', 'wielded', 'wielding', 'carries', 'carried',
  'carrying', 'grabbed', 'grabs', 'clutched', 'clutching', 'clutches', 'drew', 'draws',
  'sheathed', 'unsheathed', 'brandished', 'brandishing', 'raised', 'lifted', 'wearing',
  'wore', 'wears', 'donned', 'gripping', 'gripped', 'grips', 'pocketed', 'retrieves',
  'retrieved', 'produces', 'produced', 'unwrapped', 'presented',
]);

const ITEM_SUFFIXES = new Set([
  'sword', 'blade', 'dagger', 'knife', 'bow', 'staff', 'wand', 'ring', 'amulet', 'pendant',
  'necklace', 'cloak', 'shield', 'helm', 'helmet', 'armor', 'armour', 'gauntlet', 'tome',
  'grimoire', 'scroll', 'key', 'orb', 'crystal', 'stone', 'gem', 'crown', 'chalice', 'goblet',
  'potion', 'elixir', 'vial', 'map', 'letter', 'locket', 'lantern', 'compass', 'coin', 'medallion',
  'spear', 'axe', 'hammer', 'mask', 'banner', 'sigil', 'relic', 'artifact', 'artefact',
]);

const SPEECH_VERBS = new Set([
  'said', 'says', 'asked', 'asks', 'replied', 'replies', 'whispered', 'whispers', 'shouted',
  'shouts', 'murmured', 'murmurs', 'muttered', 'mutters', 'laughed', 'laughs', 'smiled',
  'smiles', 'nodded', 'nods', 'sighed', 'sighs', 'grinned', 'grins', 'growled', 'growls',
  'exclaimed', 'called', 'calls', 'answered', 'answers', 'spoke', 'speaks', 'gasped', 'gasps',
  'chuckled', 'snapped', 'hissed', 'yelled', 'continued', 'added', 'began', 'paused',
]);

const TITLES = new Set([
  'mr', 'mrs', 'ms', 'dr', 'lord', 'lady', 'sir', 'dame', 'king', 'queen', 'prince',
  'princess', 'captain', 'commander', 'general', 'professor', 'master', 'mistress',
  'duke', 'duchess', 'baron', 'count', 'countess', 'father', 'mother', 'brother', 'sister',
  'saint', 'elder', 'chief', 'sergeant', 'doctor', 'aunt', 'uncle',
]);

interface Candidate {
  name: string;
  kind: EntityKind;
  /** Higher = more evidence. Cue-confirmed candidates surface first. */
  score: number;
  sentence: string;
  count: number;
  /** Ever seen away from a sentence start (strong "real name" signal). */
  midSentence: boolean;
}

const clean = (text: string): string =>
  text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`~#]+/g, '')
    .replace(/\{\{\s*(char|user)\s*\}\}/gi, ' ')
    .replace(/[ \t]+/g, ' ');

const clampSummary = (sentence: string, name: string): string => {
  let s = sentence.replace(/\s+/g, ' ').trim();
  if (s.length > 180) {
    // Keep the window around the first mention of the name.
    const at = s.toLowerCase().indexOf(name.toLowerCase());
    const start = Math.max(0, Math.min(at - 40, s.length - 180));
    s = (start > 0 ? '…' : '') + s.slice(start, start + 178).trim() + '…';
  }
  return s;
};

/**
 * Pattern-based entity mining: finds repeated capitalized name runs and
 * classifies them by the words around them. Deliberately conservative —
 * a codex with a few solid entries beats one full of noise.
 */
export const heuristicExtract = (
  text: string, ctx: ExtractorContext,
): ExtractedEntity[] => {
  const known = new Set(ctx.knownNames.map(n => n.trim().toLowerCase()));
  const candidates = new Map<string, Candidate>();

  const sentences = clean(text).split(/(?<=[.!?])\s+|\n+/);

  for (const sentence of sentences) {
    const tokens = sentence.split(' ').filter(Boolean);

    for (let i = 0; i < tokens.length; i++) {
      const stripped = tokens[i].replace(/^["'“”‘’(]+|["'“”‘’),.:;!?]+$/g, '');
      if (!/^[A-Z][a-zA-Z'-]+$/.test(stripped)) continue;
      if (STOPWORDS.has(stripped.toLowerCase())) continue;

      // Extend the run: "Mira", "Mira Valen", "Tower of Dawn".
      const parts = [stripped];
      let j = i + 1;
      let pendingConnector: string | null = null;
      while (j < tokens.length && parts.length + (pendingConnector ? 1 : 0) < 4) {
        const raw = tokens[j].replace(/^["'“”‘’(]+|["'“”‘’),.:;!?]+$/g, '');
        if (/^[A-Z][a-zA-Z'-]+$/.test(raw) && !STOPWORDS.has(raw.toLowerCase())) {
          if (pendingConnector) { parts.push(pendingConnector); pendingConnector = null; }
          parts.push(raw);
          j++;
        } else if (!pendingConnector && CONNECTORS.has(raw.toLowerCase())) {
          pendingConnector = raw.toLowerCase();
          j++;
        } else break;
      }

      const name = parts.join(' ');
      const key = name.toLowerCase();
      const consumed = j - i - (pendingConnector ? 1 : 0);

      if (known.has(key) || name.length < 3) { i += consumed - 1; continue; }

      // Evidence from the surrounding words.
      const before1 = (tokens[i - 1] ?? '').toLowerCase().replace(/[^a-z]/g, '');
      const before2 = (tokens[i - 2] ?? '').toLowerCase().replace(/[^a-z]/g, '');
      const afterTok = (tokens[j] ?? '').toLowerCase().replace(/[^a-z']/g, '');
      const lastWord = parts[parts.length - 1].toLowerCase();
      const possessive = /['’]s[",.!?]*$/.test(tokens[j - 1] ?? '') || afterTok === "'s";

      let kind: EntityKind = 'character';
      let score = 0;

      if (LOCATION_CUES.has(before1) || (before1 === 'the' && LOCATION_CUES.has(before2))) {
        kind = 'location'; score += 2;
      }
      if (LOCATION_SUFFIXES.has(lastWord)) { kind = 'location'; score += 2; }
      if (ITEM_CUES.has(before1) || (before1 === 'the' && ITEM_CUES.has(before2))) {
        kind = 'item'; score += 2;
      }
      if (ITEM_SUFFIXES.has(lastWord)) { kind = 'item'; score += 2; }
      if (kind === 'character') {
        if (SPEECH_VERBS.has(afterTok) || SPEECH_VERBS.has(before1)) score += 2;
        if (TITLES.has(before1.replace(/\./g, ''))) score += 2;
        if (possessive) score += 1;
      }

      const midSentence = i > 0;
      if (midSentence) score += 1;

      const prev = candidates.get(key);
      if (prev) {
        prev.count += 1;
        prev.score = Math.max(prev.score, score) + 0.5;
        prev.midSentence = prev.midSentence || midSentence;
        if (kind !== 'character' && prev.kind === 'character') prev.kind = kind;
      } else {
        candidates.set(key, { name, kind, score, sentence, count: 1, midSentence });
      }

      i += consumed - 1; // skip over the rest of the run
    }
  }

  return [...candidates.values()]
    .filter(c =>
      // Accept on real evidence: classified by a cue, or a repeated name
      // that also appears mid-sentence (not just capitalized line starts).
      c.score >= 2 || (c.count >= 2 && c.midSentence),
    )
    .sort((a, b) => b.score + b.count - (a.score + a.count))
    .slice(0, 10)
    .map(c => ({
      name: c.name,
      kind: c.kind,
      summary: clampSummary(c.sentence, c.name),
      aliases: c.name.includes(' ') ? [c.name.split(' ')[0]] : [],
      mentions: c.count,
      source: 'heuristic' as const,
    }));
};

export const heuristicExtractor: EntityExtractor = async (text, ctx) =>
  heuristicExtract(text, ctx);

/** Count mentions of known entities in a chunk (case-insensitive, word-bounded). */
export const countMentions = (
  text: string, entities: CodexEntity[],
): Record<string, number> => {
  const out: Record<string, number> = {};
  const hay = text.toLowerCase();
  for (const e of entities) {
    let n = 0;
    for (const name of [e.name, ...e.aliases]) {
      const needle = name.toLowerCase();
      if (needle.length < 3) continue;
      let idx = hay.indexOf(needle);
      while (idx !== -1) {
        const before = hay[idx - 1];
        const after = hay[idx + needle.length];
        if ((!before || !/[\w]/.test(before)) && (!after || !/[\w]/.test(after))) n++;
        idx = hay.indexOf(needle, idx + needle.length);
      }
    }
    if (n > 0) out[e.id] = n;
  }
  return out;
};

/* ------------------------------------------------------------------ */
/* LLM extractor (OpenAI-compatible endpoint)                          */
/* ------------------------------------------------------------------ */

export interface LLMExtractorConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const EXTRACT_SYSTEM = `You maintain a spoiler-free story codex. From the passage, extract notable entities a reader would want an encyclopedia entry for.
Rules:
- Only include entities explicitly present in the passage.
- "summary" describes the entity using ONLY this passage (1-2 sentences, no speculation, no spoilers beyond it).
- Skip generic words, skip entities already in KNOWN.
Respond with ONLY a JSON array, no prose:
[{"name":"...","type":"character|location|item","summary":"...","aliases":["..."]}]
Return [] if nothing qualifies.`;

/** Tolerant JSON extraction: models love to wrap arrays in fences/prose. */
export const parseExtractionJSON = (raw: string): ExtractedEntity[] => {
  // Shared salvage — a codex scan runs over the whole library in the
  // background, so a reply truncated at the token limit used to lose every
  // entity in that passage silently, with nothing on screen to say so.
  const rows = salvageArray(raw);
  if (!Array.isArray(rows)) return [];
  const kinds = new Set(['character', 'location', 'item']);
  return rows
    .filter((r: any) => r && typeof r.name === 'string' && r.name.trim())
    .map((r: any): ExtractedEntity => ({
      name: String(r.name).trim().slice(0, 60),
      kind: kinds.has(String(r.type ?? r.kind).toLowerCase())
        ? String(r.type ?? r.kind).toLowerCase() as EntityKind
        : 'character',
      summary: String(r.summary ?? '').trim().slice(0, 400),
      aliases: Array.isArray(r.aliases)
        ? r.aliases.filter((a: any) => typeof a === 'string' && a.trim())
            .map((a: string) => a.trim().slice(0, 60)).slice(0, 5)
        : [],
      mentions: 1,
      source: 'ai',
    }))
    .slice(0, 20);
};

/**
 * Build an extractor backed by the user's endpoint. The base URL is probed
 * once (via /models) so pasted URLs work with or without /v1.
 */
export const createLLMExtractor = (cfg: LLMExtractorConfig): EntityExtractor => {
  let resolvedBase: string | null = null;
  return async (text, ctx) => {
    if (!resolvedBase) resolvedBase = (await listModels(cfg.baseUrl, cfg.apiKey)).base;
    const known = ctx.knownNames.slice(0, 80).join(', ') || '(none)';
    const raw = await askText({ base: resolvedBase, key: cfg.apiKey, model: cfg.model }, [
      { role: 'system', content: EXTRACT_SYSTEM },
      { role: 'user', content: `KNOWN: ${known}\n\nPASSAGE:\n${text.slice(0, 7000)}` },
    ], { label: 'Reading for the codex' });
    return parseExtractionJSON(raw);
  };
};

/* ------------------------------------------------------------------ */
/* Character card → codex seeding                                      */
/* ------------------------------------------------------------------ */

/** Best-effort kind guess for a lorebook entry from its name/keys. */
const guessKind = (name: string, content: string): EntityKind => {
  const last = name.trim().split(/\s+/).pop()?.toLowerCase() ?? '';
  if (LOCATION_SUFFIXES.has(last)) return 'location';
  if (ITEM_SUFFIXES.has(last)) return 'item';
  const head = content.slice(0, 160).toLowerCase();
  if (/\b(city|town|village|kingdom|region|place|located|realm|land)\b/.test(head)) return 'location';
  if (/\b(item|weapon|artifact|artefact|object|relic|worn|wielded)\b/.test(head)) return 'item';
  return 'character';
};

/**
 * Turn a card's author-written data into codex entries: the character
 * itself plus every embedded lorebook entry. Seeded with firstSeenIndex
 * -1 so they're available from the very first line (the author intends
 * them as up-front context, not spoilers).
 */
export const cardToEntities = (
  card: CardInfo,
): Omit<CodexEntity, 'id' | 'updatedAt'>[] => {
  const out: Omit<CodexEntity, 'id' | 'updatedAt'>[] = [];
  const base = { firstSeenIndex: -1, firstSeenMessageId: '', mentions: 1, source: 'card' as const };

  if (card.name) {
    const summary = [card.description, card.personality && `Personality: ${card.personality}`]
      .filter(Boolean).join(' — ').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (summary) out.push({ ...base, name: card.name, kind: 'character', aliases: [], summary });
  }

  for (const entry of card.lorebook ?? []) {
    const name = (entry.title || entry.keys[0] || '').trim().slice(0, 60);
    if (!name || name.length < 2) continue;
    const aliases = entry.keys
      .filter(k => k.toLowerCase() !== name.toLowerCase() && k.length >= 3)
      .slice(0, 5);
    out.push({
      ...base,
      name,
      kind: guessKind(name, entry.content),
      aliases,
      summary: entry.content.replace(/\s+/g, ' ').trim().slice(0, 400),
    });
  }
  return out.slice(0, 80);
};

/* ------------------------------------------------------------------ */
/* SillyTavern World Info export                                       */
/* ------------------------------------------------------------------ */

/**
 * Convert a codex to SillyTavern World Info JSON, so the auto-built
 * lorebook can be imported straight back into ST (Worlds → Import).
 */
export const codexToWorldInfo = (entities: CodexEntity[]): string => {
  const entries: Record<string, unknown> = {};
  entities.forEach((e, i) => {
    entries[String(i)] = {
      uid: i,
      key: [e.name, ...e.aliases],
      keysecondary: [],
      comment: `${e.name} (${e.kind})`,
      content: e.summary,
      constant: false,
      selective: true,
      selectiveLogic: 0,
      addMemo: true,
      order: 100,
      position: 0,
      disable: false,
      excludeRecursion: false,
      probability: 100,
      useProbability: true,
    };
  });
  return JSON.stringify({ entries }, null, 2);
};
