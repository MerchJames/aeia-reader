/**
 * Remembrance — the companion who got stuck on something and never got off it.
 *
 * ── The failure this is for ────────────────────────────────────────────────
 *
 * A reaction is generated against the passage and a short memory of the
 * companion's own earlier lines. That memory is what stops them gasping twice
 * at the same revelation, and it has one hole in it: a QUESTION. "Wait, who is
 * that at the door?" goes into the memory as a thing they said, so they know
 * they said it — and nothing ever tells them whether the story answered it. The
 * question is the most salient thing in their own history, so it keeps coming
 * back, and three passages later the companion is still asking about the door
 * while the reader has long since met the person behind it. It reads exactly
 * like someone who has stopped paying attention.
 *
 * ── Why this is not a model call ───────────────────────────────────────────
 *
 * "Has the story answered this yet" is a semantic question, and the obvious
 * build is to ask the model. That is a second call on every beat, per companion
 * — five watchers on a `dynamic` read would double the cost of the feature to
 * fix a wrinkle in it.
 *
 * So this does not answer the question. It finds the LINE that bears on it —
 * word overlap against the text the companion is already allowed to see — and
 * hands both to the model with the reaction it was making anyway. The model
 * does the understanding, which it is good at and free; this does the
 * retrieval, which it is bad at and expensive. When nothing scores, the thread
 * still travels, marked unanswered, and the instruction is simply to let it go.
 *
 * ── Deliberately invisible ─────────────────────────────────────────────────
 *
 * The reader must never watch this happen. A companion who announces "oh, I see
 * — it was Mara at the door all along" is worse than one who repeats himself:
 * he has become a mechanism apologising for itself. The correction is meant to
 * show up only as an absence — the thing that would have been asked a fourth
 * time simply is not.
 *
 * Only ever their OWN lines and text they have already been shown. Nothing here
 * widens what a companion knows; it can only stop them forgetting.
 */

/** Words too common to identify anything. */
const STOP = new Set([
  'about', 'after', 'again', 'against', 'all', 'and', 'any', 'anyone', 'are',
  'because', 'been', 'before', 'being', 'but', 'can', 'could', 'did', 'does', 'doing',
  'done', 'even', 'ever', 'for', 'from', 'get', 'going', 'got', 'had', 'has', 'have',
  'her', 'here', 'him', 'his', 'how', 'into', 'its', 'just', 'know', 'let', 'like',
  'made', 'make', 'more', 'much', 'need', 'not', 'nothing', 'now', 'off', 'one',
  'out', 'over', 'own', 'really', 'said', 'same', 'saw', 'say', 'says', 'see', 'she',
  'should', 'some', 'someone', 'something', 'still', 'such', 'sure', 'take', 'tell',
  'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'thing',
  'things', 'think', 'this', 'those', 'through', 'time', 'too', 'two', 'very', 'want',
  'was', 'way', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom',
  'whose', 'why', 'will', 'with', 'would', 'yes', 'yet', 'you', 'your',
]);

/** The words in a line that could identify what it is about. */
export const contentWords = (line: string): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of line.toLowerCase().split(/[^a-z0-9'’-]+/)) {
    const w = raw.replace(/^['’-]+|['’-]+$/g, '');
    if (w.length < 3 || STOP.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
};

/** Sentences, near enough — the unit an answer arrives in. */
export const sentences = (text: string): string[] =>
  text
    .split(/(?<=[.!?…])["'”’]?\s+|\n+/)
    .map(s => s.trim())
    .filter(Boolean);

/**
 * Something they said that is still hanging.
 *
 * A question mark, or the one phrasing that is a question without one — "I
 * wonder what he meant" is asked exactly as often and gets stuck exactly as
 * hard. A question with no content words ("What?", "Really?") is not a thread;
 * it is punctuation, and carrying it would only crowd out a real one.
 */
export const askedIn = (line: string): string[] =>
  sentences(line)
    .filter(s => /\?["'”’]?$/.test(s) || /\bi wonder\b/i.test(s))
    .filter(s => contentWords(s).length >= 1);

/** A question's exact subject matter — used only to recognise it quoted back. */
const signature = (q: string): string => contentWords(q).sort().join(' ');

/**
 * Whether two questions are the same question.
 *
 * Not string equality and not a shared signature: someone stuck on a thing asks
 * it again in different words — "who is that at the door?" then "seriously,
 * who's at the door?" — and an exact match would file those as two threads and
 * so never notice the loop, which is the entire point of counting them. Half
 * the shorter question's subject matter, at least one word.
 */
const sameQuestion = (a: readonly string[], b: readonly string[]): boolean => {
  if (!a.length || !b.length) return false;
  const setB = new Set(b);
  const shared = a.filter(w => setB.has(w)).length;
  return shared >= Math.max(1, Math.ceil(Math.min(a.length, b.length) / 2));
};

/** Longest a quoted answer may be — a line from the page, not the page. */
export const MAX_ANSWER_CHARS = 220;

/** A word specific enough to be worth matching on its own. */
const DISTINCTIVE = 4;

/**
 * The line in `source` that most bears on the question, or nothing.
 *
 * One shared word carries it when the word is specific — "Corvin" is the whole
 * subject of "who is Corvin?" — and otherwise it takes two. Scaling the bar
 * with the length of the question was the obvious rule and the wrong one: it
 * punished the companion for phrasing ("seriously though, who is at the door?"
 * asks less than "who is at the door?" by that measure), and phrasing is
 * exactly what varies when someone is stuck on something.
 *
 * The bar is for topicality, not for truth. This does not decide whether the
 * line answers the question — the model does, with both in front of it, and it
 * is free to conclude nothing was settled. What must never happen is an
 * unrelated line arriving labelled as bearing on the matter, because a
 * companion confidently wrong is a worse failure than the one being fixed.
 */
export const answerFor = (question: string, source: string): string | undefined => {
  const want = contentWords(question);
  if (!want.length) return undefined;
  let best: string | undefined;
  let bestScore = 0;
  for (const s of sentences(source)) {
    if (s.length > MAX_ANSWER_CHARS) continue;
    // The question itself, quoted back out of the transcript, settles nothing.
    if (signature(s) === signature(question)) continue;
    const has = new Set(contentWords(s));
    const shared = want.filter(w => has.has(w));
    if (!shared.length) continue;
    const strong = shared.filter(w => w.length >= DISTINCTIVE).length;
    if (!strong && shared.length < 2) continue;
    const score = shared.length + strong;
    if (score > bestScore) { best = s; bestScore = score; }
  }
  return best;
};

export interface OpenThread {
  /** Their own words, as they asked them. */
  question: string;
  /** A line from the page that bears on it, when one scores. */
  answer?: string;
  /** How many times they have asked it. Two is a person; three is a loop. */
  asked: number;
}

/** How many threads travel with a reaction. Two is a memory; five is a briefing. */
export const MAX_THREADS = 2;

/**
 * What is still on their mind, newest last.
 *
 * Repeats are collapsed and counted, and a thread that has been asked more than
 * once beats a newer one for the slot: the loop is the thing worth breaking.
 */
export const openThreads = (
  earlier: readonly string[], source: string, limit = MAX_THREADS,
): OpenThread[] => {
  const found: { question: string; words: string[]; asked: number; at: number }[] = [];
  earlier.forEach((line, at) => {
    for (const q of askedIn(line)) {
      const words = contentWords(q);
      const prev = found.find(f => sameQuestion(f.words, words));
      if (prev) {
        prev.asked++;
        // Keep the LATEST phrasing: it is the one they are stuck on now.
        prev.question = q;
        prev.words = words;
        prev.at = at;
      } else found.push({ question: q, words, asked: 1, at });
    }
  });
  return found
    .sort((a, b) => (b.asked - a.asked) || (b.at - a.at))
    .slice(0, Math.max(0, limit))
    .sort((a, b) => a.at - b.at)
    .map(({ question, asked }) => ({ question, asked, answer: answerFor(question, source) }));
};

/**
 * The prompt fragment, or '' when they are not stuck on anything.
 *
 * Phrased as remembering rather than as being told, and it says outright not to
 * perform the realisation — a model handed an answer wants to show its working,
 * and showing its working is the one thing that would expose the whole
 * mechanism to the reader.
 */
export const recallBlock = (threads: readonly OpenThread[]): string => {
  if (!threads.length) return '';
  const lines = threads.map(t => {
    const asked = t.asked > 1 ? ` (you have asked this ${t.asked} times now)` : '';
    return t.answer
      ? `  You asked: "${t.question}"${asked}\n    And the page has said, somewhere you have already read:`
        + ` "${t.answer}"`
      : `  You asked: "${t.question}"${asked}\n    Nothing has answered it yet.`;
  });
  return [
    '',
    'STILL ON YOUR MIND — things you said out loud and never closed:',
    ...lines,
    'You have been carrying these. Where the page has answered one, you already',
    'know it and you do not ask again — and you do NOT announce that you worked it',
    'out, or mention having wondered. Where nothing has answered one, let it sit:',
    'asking a third time is not a reaction. Either way this is background. React to',
    'the moment in front of you.',
  ].join('\n');
};
