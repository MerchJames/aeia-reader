/**
 * Narrative extractor — the objective layer of a passage, in-browser and local.
 *
 * Built on `compromise` (MIT, dependency-free) — NO Python sidecar (see the
 * decision in memory: a sidecar fights Aura's simple, local, single-runtime
 * ethos). This module is deliberately NOT a rewrite engine: deterministic
 * thesaurus/word-swapping makes bad prose. Its job is to EXTRACT structure
 * (entities, verbs, descriptors, dialogue), which then (a) grounds an LLM
 * restyle as hard constraints and (b) VERIFIES the rewrite kept those facts —
 * the same source-sacred discipline the reader lives by, applied to editing.
 */

import nlp from 'compromise';

export type PosClass = 'proper' | 'pronoun' | 'verb' | 'adjective' | 'adverb' | 'noun' | 'other';

/** One tagged token with its source offset — the unit the UI highlights. */
export interface TaggedTerm {
  text: string;
  start: number;
  length: number;
  pos: PosClass;
}

export interface Extraction {
  people: string[];
  places: string[];
  properNouns: string[];
  nouns: string[];
  verbs: string[]; // infinitive lemmas — the event spine
  adjectives: string[];
  adverbs: string[];
  pronouns: string[];
  quotes: string[]; // dialogue spans, verbatim
  terms: TaggedTerm[];
  stats: { sentences: number; words: number; avgSentenceLen: number; dialogueRatio: number };
}

/** Case-insensitive unique, preserving first-seen surface form; trims junk. */
const uniq = (arr: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of arr) {
    const s = raw.replace(/[.,;:!?"'”’)\]]+$/g, '').replace(/^['"“‘([]+/g, '').trim();
    const k = s.toLowerCase();
    if (s && !seen.has(k)) { seen.add(k); out.push(s); }
  }
  return out;
};

/** Pick the most specific POS class from a compromise term's tag set. */
const classify = (tags: string[]): PosClass => {
  const t = new Set(tags);
  if (t.has('ProperNoun') || t.has('Person') || t.has('Place') || t.has('Organization')) return 'proper';
  if (t.has('Pronoun')) return 'pronoun';
  if (t.has('Verb')) return 'verb';
  if (t.has('Adjective')) return 'adjective';
  if (t.has('Adverb')) return 'adverb';
  if (t.has('Noun')) return 'noun';
  return 'other';
};

/**
 * Rule layer over compromise's statistical tags: capitalised words that aren't
 * sentence-initial and read as nouns are almost certainly names/places — even
 * when compromise mis-tags them (it calls "Jun" a month). Fiction leans on
 * invented and uncommon names, so this catches the entities NER misses.
 */
const properLike = (terms: TaggedTerm[]): string[] => {
  const out: string[] = [];
  let atStart = true;
  for (const t of terms) {
    if (t.pos === 'proper') out.push(t.text);
    else if (!atStart && (t.pos === 'noun' || t.pos === 'other') && /^[A-Z][A-Za-z'’\-]+$/.test(t.text)) {
      out.push(t.text);
    }
    atStart = /[.!?]["”’)]?\s*$/.test(t.text); // next term begins a sentence
  }
  return out;
};

/** Verbatim double-quoted dialogue spans (straight or curly quotes). */
const dialogueSpans = (text: string): string[] => {
  const out: string[] = [];
  const re = /[“"]([^“”"]{1,600}?)[”"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1].trim());
  return out.filter(Boolean);
};

/** Extract the objective narrative layer from a passage. Pure + deterministic. */
export const extract = (text: string): Extraction => {
  const doc: any = nlp(text || '');

  const terms: TaggedTerm[] = [];
  for (const item of doc.terms().json({ offset: true }) as any[]) {
    const off = item.offset ?? item.terms?.[0]?.offset;
    const tags: string[] = item.terms?.[0]?.tags ?? item.tags ?? [];
    if (!off) continue;
    terms.push({ text: item.text, start: off.start, length: off.length, pos: classify(tags) });
  }

  const quotes = dialogueSpans(text || '');
  const words = doc.wordCount?.() ?? terms.length;
  const sentences = Math.max(1, doc.sentences().length || 1);
  const quotedChars = quotes.reduce((n, q) => n + q.length, 0);

  return {
    people: uniq(doc.people().out('array')),
    places: uniq(doc.places().out('array')),
    properNouns: uniq([...doc.match('#ProperNoun+').out('array'), ...properLike(terms)]),
    nouns: uniq(terms.filter(t => t.pos === 'noun').map(t => t.text)),
    verbs: uniq(doc.verbs().toInfinitive().out('array')),
    adjectives: uniq(doc.adjectives().out('array')),
    adverbs: uniq(doc.adverbs().out('array')),
    pronouns: uniq(terms.filter(t => t.pos === 'pronoun').map(t => t.text.toLowerCase())),
    quotes,
    terms,
    stats: {
      sentences,
      words,
      avgSentenceLen: Math.round((words / sentences) * 10) / 10,
      dialogueRatio: text ? Math.round((quotedChars / text.length) * 100) / 100 : 0,
    },
  };
};

/** The named things a rewrite must keep, deduped across people/places/propers. */
export const entitySet = (ex: Extraction): string[] =>
  uniq([...ex.people, ...ex.places, ...ex.properNouns]);

/**
 * A constraint block handed to the LLM so a restyle can't drift off the facts:
 * the entities to preserve verbatim, the ordered event spine, and the length.
 */
export const buildGrounding = (ex: Extraction): string => {
  const entities = entitySet(ex).slice(0, 24);
  const spine = ex.verbs.slice(0, 30);
  const lines = [
    entities.length ? `Named things to keep EXACTLY (spelling unchanged): ${entities.join(', ')}` : '',
    spine.length ? `Event spine — keep these actions, in this order: ${spine.join(' → ')}` : '',
    `Keep roughly ${ex.stats.sentences} sentence(s); do not add new events, characters, or places.`,
  ];
  return lines.filter(Boolean).join('\n');
};

export interface Fidelity {
  kept: string[];
  dropped: string[];
  added: string[];
  verbOverlap: number; // 0..1 share of the original event spine still present
  ok: boolean;
  warning?: string;
}

/** Compare a rewrite against the source: did it keep the entities and events? */
export const fidelity = (before: string, after: string): Fidelity => {
  const a = extract(before);
  const b = extract(after);
  const beforeE = entitySet(a);
  const afterE = new Set(entitySet(b).map(s => s.toLowerCase()));
  const beforeEset = new Set(beforeE.map(s => s.toLowerCase()));

  const kept = beforeE.filter(e => afterE.has(e.toLowerCase()));
  const dropped = beforeE.filter(e => !afterE.has(e.toLowerCase()));
  const added = entitySet(b).filter(e => !beforeEset.has(e.toLowerCase()));

  const beforeV = new Set(a.verbs.map(v => v.toLowerCase()));
  const afterV = new Set(b.verbs.map(v => v.toLowerCase()));
  let hit = 0;
  beforeV.forEach(v => { if (afterV.has(v)) hit++; });
  const verbOverlap = beforeV.size ? Math.round((hit / beforeV.size) * 100) / 100 : 1;

  const parts: string[] = [];
  if (dropped.length) parts.push(`dropped ${dropped.join(', ')}`);
  if (added.length) parts.push(`introduced ${added.join(', ')}`);
  if (beforeV.size && verbOverlap < 0.5) parts.push(`only ${Math.round(verbOverlap * 100)}% of the original actions survived`);
  const ok = dropped.length === 0 && added.length === 0;
  return {
    kept, dropped, added, verbOverlap, ok,
    warning: parts.length ? `Fidelity check: ${parts.join('; ')}.` : undefined,
  };
};
