/**
 * What the app is, written down so an assistant can answer questions about it.
 *
 * ── Why the docs live in code ──────────────────────────────────────────────
 *
 * A model asked "how do I make the text read itself aloud" has three ways to
 * answer. It can guess, which produces confident instructions for buttons that
 * do not exist. It can be given the whole manual every turn, which costs more
 * context than the story does. Or it can look things up — which needs the
 * manual to be structured, searchable, and near enough to the code that it
 * rots visibly rather than quietly.
 *
 * So: data, in the repository, with a test that every documented view and
 * setting is a real one. A doc entry naming a view that has been removed fails
 * the suite, which is the only way a manual stays true across a year of
 * changes.
 *
 * ── What an entry is for ───────────────────────────────────────────────────
 *
 * Each entry answers ONE question a person actually has, in their words rather
 * than the app's. `keywords` carry the words they would use — "read aloud",
 * "voice", "tts" all reach the same entry — because a reader does not know
 * this app calls it Performance mode, and that is precisely why they are
 * asking.
 *
 * `where` is the part that makes the guide more than a chatbot: it names the
 * exact place to go, so the assistant can take them there instead of
 * describing a journey.
 *
 * Pure: no store, no React. Just text and a search over it.
 */

import type { UiMode, ViewMode } from '../types';

/** Where an answer lives, so the assistant can move the reader to it. */
export interface DocPlace {
  /** Switch to this view. */
  view?: ViewMode;
  /** Switch the workspace preset first — some views are hidden in others. */
  uiMode?: UiMode;
  /** Open this panel: a tool in the header, or a settings section. */
  panel?: GuidePanel;
  /** The settings section to scroll to, when the answer is a setting. */
  settingsSection?: string;
}

/** Panels the guide is allowed to open. Nothing destructive is on this list. */
export type GuidePanel =
  | 'settings' | 'codex' | 'sheets' | 'ai' | 'frame' | 'multiverse' | 'branching'
  | 'backup' | 'sync' | 'tour' | 'library';

export interface DocEntry {
  id: string;
  /** The question, as a person would ask it. */
  title: string;
  /** The answer. Two or three sentences; the assistant expands if asked. */
  body: string;
  /** Words a reader would search for, including the ones the app does not use. */
  keywords: string[];
  where?: DocPlace;
  /** Related entries, so the assistant can offer the obvious next question. */
  see?: string[];
}

/**
 * The manual.
 *
 * Ordered roughly by when someone needs it: getting text in, reading it,
 * marking it up, the optional AI, then the things only a returning reader
 * wants. Order is not load-bearing — search is — but it makes the file
 * readable by a person, which is the other audience.
 */
export const GUIDE_DOCS: readonly DocEntry[] = [
  /* ---- Getting started ---- */
  {
    id: 'import',
    title: 'How do I get a chat into Aeia?',
    body:
      'Drop files anywhere on the library screen, or press Import. SillyTavern '
      + 'chats are .jsonl, Kobold saves are .json, character cards are .png, and '
      + 'plain documents can be .txt, .md or .docx. Branch exports are recognised '
      + 'and attached to the story they came from instead of landing as duplicates.',
    keywords: ['import', 'add', 'open', 'load', 'file', 'jsonl', 'json', 'docx', 'drop', 'upload'],
    where: { panel: 'library' },
    see: ['formats', 'rename'],
  },
  {
    id: 'formats',
    title: 'What file types can I use?',
    body:
      'SillyTavern .jsonl chats, KoboldAI/KoboldCpp .json saves, character cards '
      + 'as .png (V1, V2 and V3), and documents as .txt, .md or .docx. A character '
      + 'card with no chat behind it can still be imported as a companion.',
    keywords: ['format', 'file type', 'supported', 'png', 'card', 'kobold', 'sillytavern', 'txt', 'markdown'],
    see: ['import'],
  },
  {
    id: 'rename',
    title: 'How do I rename a chat?',
    body:
      'Double-click its name on the library card, type, and press Enter. In the '
      + 'reader, click the title in the top bar. Recent SillyTavern exports write '
      + '"unused" where the character name should be, so a freshly imported chat '
      + 'is sometimes named after its file or after nothing at all — renaming is '
      + 'expected, not a sign anything went wrong.',
    keywords: ['rename', 'name', 'title', 'unused', 'change name', 'call it'],
    where: { panel: 'library' },
  },
  {
    id: 'folders',
    title: 'How do I organise my chats?',
    body:
      'Two ways, and they do different jobs. Folders are exclusive — a chat is in '
      + 'one folder or none — and appear as chips above the library; make one with '
      + '"New folder" and file a chat with the dropdown on its card. Tags are the '
      + 'opposite: a chat can carry as many as you like, and you filter by any '
      + 'combination. Use folders for where something lives, tags for what it is.',
    keywords: ['folder', 'organise', 'organize', 'sort', 'tag', 'group', 'category', 'filter'],
    where: { panel: 'library' },
  },

  /* ---- Reading ---- */
  {
    id: 'reading-modes',
    title: 'What are the reading modes?',
    body:
      'One switch for how much the app performs the text. Plain is nothing but '
      + 'the words. Lit lets the page take the scene\'s mood. Cinema adds motion, '
      + 'weather and emphasis. Performance also reads it aloud. Everything above '
      + 'Plain is optional and can be turned off individually in Settings.',
    keywords: ['reading mode', 'plain', 'lit', 'cinema', 'performance', 'atmosphere', 'immersion'],
    where: { panel: 'settings', settingsSection: 'Reading mode' },
    see: ['tts', 'views'],
  },
  {
    id: 'playback',
    title: 'How do I control the reveal?',
    body:
      'Space plays and pauses. Q and E change the speed. The words arrive at '
      + 'reading pace rather than all at once; if you would rather see everything '
      + 'immediately, turn off Autoreader in Settings.',
    keywords: ['play', 'pause', 'speed', 'space', 'stream', 'reveal', 'slow', 'fast', 'autoreader'],
    where: { panel: 'settings', settingsSection: 'Autoreader' },
  },
  {
    id: 'views',
    title: 'What are the different views?',
    body:
      'The same log, presented differently. Storybook is continuous prose; Chat is '
      + 'the original transcript; Book is a two-page spread; Stage and Visual Novel '
      + 'are game-like presentations; RPG is a full game interface; Sandbox lets '
      + 'the AI design each beat. Script, Panels and Atlas show the story\'s SHAPE '
      + '— a screenplay, a comic page, a map. Workspace is for editing. Three more '
      + 'are lists ABOUT the story rather than the story: Overview shows the whole '
      + 'thing at a glance, Highlights collects everything you have marked, and '
      + 'Branches holds the roads not taken. Only the views you pin sit on the top '
      + 'bar; the rest are one click deeper.',
    keywords: ['view', 'views', 'storybook', 'book', 'chat view', 'stage', 'visual novel', 'vn',
      'rpg', 'sandbox', 'script', 'panels', 'atlas', 'layout', 'presentation',
      'overview', 'highlights', 'branches', 'at a glance'],
    see: ['workspace', 'ui-modes'],
  },
  {
    id: 'ui-modes',
    title: 'What do Read, Cowrite and Scenes do?',
    body:
      'They narrow the whole app to one kind of work, so you are not looking at '
      + 'fourteen buttons you do not need. Read keeps the Codex, Autofocus and '
      + 'Settings. Cowrite hides the presentation views and keeps the writing '
      + 'tools. Scenes shows every way of PRESENTING the story and hides the lists '
      + 'about it. All puts everything back, and is where to go if something you '
      + 'expect is missing.',
    keywords: ['read mode', 'cowrite', 'scenes', 'all', 'preset', 'workspace preset', 'missing button',
      'where did it go', 'hidden'],
    see: ['views'],
  },
  {
    id: 'autofocus',
    title: 'What is Autofocus?',
    body:
      'Everything except the passage in hand falls away, and the page follows the '
      + 'text as it arrives. Turn on the magnifier and a light tracks the newest '
      + 'words. It is for hands-free reading.',
    keywords: ['autofocus', 'focus', 'magnifier', 'dim', 'hands free', 'distraction'],
    where: { panel: 'settings', settingsSection: 'Reading' },
  },
  {
    id: 'tts',
    title: 'How do I make it read aloud?',
    body:
      'Set the reading mode to Performance, or turn on text-to-speech directly in '
      + 'Settings. Your browser\'s built-in voices work with no setup; Kokoro gives '
      + 'better ones if you run it. Voices can be assigned per character.',
    keywords: ['read aloud', 'voice', 'tts', 'speech', 'narrate', 'audiobook', 'listen',
      'kokoro', 'speak', 'hear', 'hear it', 'make it talk', 'say it out loud', 'out loud',
      'sound', 'audio'],
    where: { panel: 'settings', settingsSection: 'Reading mode' },
    see: ['reading-modes'],
  },
  {
    id: 'hidden-messages',
    title: 'Some messages are missing or greyed out.',
    body:
      'SillyTavern marks narrator lines and /hide-den messages as system entries. '
      + 'Aeia keeps them but does not play them by default. Turn on "Show hidden '
      + 'messages" in Settings to read them.',
    keywords: ['hidden', 'missing', 'system message', 'narrator', 'greyed', 'not showing', 'skipped'],
    where: { panel: 'settings', settingsSection: 'From the chat file' },
  },

  /* ---- Marking it up ---- */
  {
    id: 'highlights',
    title: 'How do I highlight and take notes?',
    body:
      'Hold F and select text to highlight it. Select any span to colour it, '
      + 'underline it, strike it through, or direct how it performs as it streams. '
      + 'Notes attach to a passage and live in the Codex panel. Everything you '
      + 'mark is collected in the Highlights view.',
    keywords: ['highlight', 'note', 'annotate', 'mark', 'colour', 'color', 'underline', 'comment'],
    where: { view: 'highlights' },
    see: ['pins'],
  },
  {
    id: 'pins',
    title: 'What are pins?',
    body:
      'A pin is a document you keep beside the story — a passage, a table, a '
      + 'character sheet, a summary. Pins hold versions, so a pin updated by the '
      + 'assistant keeps the earlier one. Sets group pins that belong together, '
      + 'and the active set is what the assistant sees.',
    keywords: ['pin', 'pins', 'set', 'sets', 'document', 'keep', 'save passage', 'dock'],
    see: ['sheets', 'zones'],
  },
  {
    id: 'sheets',
    title: 'What are sheets?',
    body:
      'Tables you keep beside a story — inventory, relationships, a stat block. '
      + 'They are editable by hand and can be filled in by the assistant.',
    keywords: ['sheet', 'sheets', 'table', 'stats', 'inventory', 'tracker', 'spreadsheet'],
    where: { panel: 'sheets' },
    see: ['pins'],
  },
  {
    id: 'codex',
    title: 'What is the Codex?',
    body:
      'A wiki the app builds as you read: people, places and things, with where '
      + 'each first appeared. It works without AI by extracting names; with an '
      + 'endpoint connected it writes short descriptions too. Your notes live here '
      + 'as well.',
    keywords: ['codex', 'wiki', 'glossary', 'characters', 'entities', 'who is', 'lore'],
    where: { panel: 'codex' },
  },
  {
    id: 'lens',
    title: 'How do I edit the text of a message?',
    body:
      'The Lens is an overlay: your version sits on top, and the imported text is '
      + 'never overwritten. Turn the Lens off to read the original again at any '
      + 'time. In the Workspace view you can double-click a passage to edit it '
      + 'directly; the assistant can also suggest rewrites, which arrive as '
      + 'proposals you approve or reject.',
    keywords: ['edit', 'lens', 'rewrite', 'change text', 'fix typo', 'revise', 'correct'],
    where: { view: 'workspace' },
    see: ['workspace', 'ai-lens'],
  },
  {
    id: 'branches',
    title: 'What happened to my swipes and alternates?',
    body:
      'They are readable as branches: follow a different version and keep reading '
      + 'from there. Separate branch files exported from SillyTavern are stitched '
      + 'back onto their parent story when you import them.',
    keywords: ['branch', 'swipe', 'alternate', 'variation', 'timeline', 'fork', 'other version'],
    where: { view: 'branches' },
  },

  /* ---- Working on it ---- */
  {
    id: 'workspace',
    title: 'What is the Workspace view?',
    body:
      'A text-editor posture for working on the story. Move the text column '
      + 'wherever you like, change its width and spacing, double-click a passage '
      + 'to edit it in place, and keep pins, sets, sheets and branchlines on a rail '
      + 'beside it. Press [ and ] to shuffle through the rail.',
    keywords: ['workspace', 'edit', 'write', 'draft', 'cowrite', 'text editor', 'spacing', 'column'],
    where: { view: 'workspace', uiMode: 'cowrite' },
    see: ['lens', 'zones'],
  },
  {
    id: 'zones',
    title: 'What are context zones and pockets?',
    body:
      'A zone is a saved selection of messages — "the whole first act", "every '
      + 'line she speaks" — that you can hand to the assistant instead of the '
      + 'entire chat. A pocket is a zone with a job attached, so the same '
      + 'selection can be run again later. Both keep the assistant\'s attention on '
      + 'the part you mean.',
    keywords: ['zone', 'zones', 'pocket', 'pockets', 'context', 'selection', 'scope', 'attention'],
    see: ['tasks', 'pins'],
  },
  {
    id: 'tasks',
    title: 'What are tasks?',
    body:
      'A recipe the assistant runs over your zones: an order of sections, a shape '
      + 'for the document, and the pin it writes into. Use one for anything you '
      + 'will want again — a running summary, a character sheet that keeps up with '
      + 'the story, a timeline.',
    keywords: ['task', 'tasks', 'recipe', 'automate', 'summary', 'run', 'generate document'],
    see: ['zones', 'summarize'],
  },
  {
    id: 'summarize',
    title: 'How do I summarise a long story?',
    body:
      'The Summarize panel in the assistant chunks the story and works through it. '
      + 'There are four shapes plus a custom one, where you paste a format you want '
      + 'the output to follow — a template, some JSON, an outline, or just labelled '
      + 'lines. The result becomes a pin.',
    keywords: ['summary', 'summarise', 'summarize', 'recap', 'condense', 'long', 'catch up', 'timeline'],
    where: { panel: 'ai' },
    see: ['tasks', 'pins'],
  },

  /* ---- The optional AI ---- */
  {
    id: 'ai-connect',
    title: 'How do I connect an AI?',
    body:
      'Open the assistant and paste the base URL of any OpenAI-compatible endpoint '
      + '— OpenAI, OpenRouter, LM Studio, Ollama, KoboldCpp. Do not include /v1; it '
      + 'is added for you. Press Connect & load models, or type a model name and '
      + 'press Test connection. Every AI feature is optional and everything has a '
      + 'working AI-free path.',
    keywords: ['ai', 'connect', 'endpoint', 'api', 'model', 'openai', 'ollama', 'lm studio',
      'koboldcpp', 'openrouter', 'local', 'setup'],
    where: { panel: 'ai' },
    see: ['ai-trouble', 'ai-lens'],
  },
  {
    id: 'ai-trouble',
    title: 'The AI will not connect.',
    body:
      'Press Test connection — it sends one real request and says what actually '
      + 'went wrong. The most common cause with a local server is CORS: the server '
      + 'is running fine but refusing requests from a web page. LM Studio has a '
      + 'toggle in Developer settings, Ollama needs OLLAMA_ORIGINS=*, KoboldCpp '
      + 'works as-is. Use http:// for a local server, not https://.',
    keywords: ['not working', 'cannot connect', 'failed to fetch', 'cors', 'error', 'refused',
      'broken', 'no response', 'troubleshoot'],
    where: { panel: 'ai' },
    see: ['ai-connect'],
  },
  {
    id: 'ai-lens',
    title: 'Can the AI change my story?',
    body:
      'Only with your approval, and never on its own. A rewrite arrives as a '
      + 'proposal shown against the original with every changed word marked; accept '
      + 'and the story reads differently, reject and nothing happened. Your '
      + 'imported text is never overwritten either way — the Lens is an overlay.',
    keywords: ['ai edit', 'rewrite', 'lens edit', 'change story', 'safe', 'approve', 'proposal'],
    see: ['lens'],
  },
  {
    id: 'ask-character',
    title: 'Can I talk to a character?',
    body:
      'Yes — interview anyone in the cast about the beat you just read, or invite '
      + 'a character in from another story in your library. They can also read '
      + 'along and react as it happens. Nothing they say joins the story unless you '
      + 'put it there.',
    keywords: ['ask', 'talk', 'interview', 'character', 'companion', 'react', 'visitor', 'chat with'],
    see: ['ai-connect'],
  },
  {
    id: 'scene-art',
    title: 'How do I get pictures?',
    body:
      'Connect an image endpoint in Settings and a beat can be turned into a '
      + 'picture. The prompt is shown before it fires, so nothing is generated '
      + 'without you seeing what was asked for.',
    keywords: ['image', 'picture', 'art', 'scene art', 'illustration', 'comfyui', 'stable diffusion',
      'generate image'],
    where: { panel: 'settings', settingsSection: 'Scene images' },
  },

  /* ---- Keeping it ---- */
  {
    id: 'backup',
    title: 'How do I back up my library?',
    body:
      'Settings → Your library → Back up & restore. It writes one file with every '
      + 'story and all the notes, pins, sheets and edits attached. This is also '
      + 'where you can ask the browser to keep your data permanently — by default '
      + 'a browser may clear stored data when the device runs low on space. The '
      + 'per-story exports are for reading elsewhere; they cannot restore anything.',
    keywords: ['backup', 'back up', 'restore', 'save', 'lose', 'lost', 'data', 'safe', 'export all',
      'transfer', 'move to another computer'],
    where: { panel: 'backup' },
    see: ['export'],
  },
  {
    id: 'export',
    title: 'How do I export a story?',
    body:
      'Any story exports as one self-contained HTML file — theme, fonts, pictures '
      + 'and reveal all baked in — that opens in any browser with nothing '
      + 'installed. Markdown and plain text are there too, and an audiobook if you '
      + 'have a voice set up. Smart Export lets you choose what goes in first.',
    keywords: ['export', 'share', 'html', 'markdown', 'pdf', 'send', 'save as', 'audiobook'],
    where: { panel: 'settings', settingsSection: 'Export' },
    see: ['backup'],
  },
  {
    id: 'sync',
    title: 'Can I sync with SillyTavern?',
    body:
      'Yes, in both directions. Turn on SillyTavern sync in Settings, then drop the '
      + 'chat\'s .jsonl into the sync panel: new messages come in, your Lens edits '
      + 'go back out, and anything both sides changed is put to you. Install the '
      + 'Aeia Bridge extension in SillyTavern to skip the file handling entirely. '
      + 'Nothing is written on either side without you approving it.',
    keywords: ['sync', 'sillytavern', 'st', 'two way', 'bridge', 'extension', 'update', 'jsonl'],
    where: { panel: 'sync' },
  },
  {
    id: 'privacy',
    title: 'Where does my data go?',
    body:
      'Nowhere. Everything stays in this browser — no account, no server, nothing '
      + 'uploaded. The only things that leave are requests to an AI endpoint you '
      + 'configured yourself, and only when you use an AI feature.',
    keywords: ['privacy', 'data', 'server', 'account', 'upload', 'cloud', 'private', 'local', 'offline'],
    see: ['backup'],
  },
];

/* ------------------------------------------------------------------ */
/* Finding an answer                                                   */
/* ------------------------------------------------------------------ */

/** How many entries a search returns. Enough to be useful, few enough to read. */
export const MAX_DOC_HITS = 5;

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');

const words = (s: string) => normalize(s).split(/\s+/).filter(w => w.length > 1);

/**
 * Score one entry against a query.
 *
 * Keywords are weighted far above body text because they are the reader's
 * vocabulary rather than ours: someone types "voice", the entry is titled
 * "How do I make it read aloud", and the only thing connecting the two is the
 * keyword list. A body-text match is a weak signal by comparison — the word
 * "voice" appears in four entries — so it breaks ties rather than deciding.
 */
const score = (entry: DocEntry, query: string): number => {
  const q = normalize(query).trim();
  if (!q) return 0;
  const terms = words(q);
  if (!terms.length) return 0;

  let total = 0;
  const keywords = entry.keywords.map(k => normalize(k));
  const title = normalize(entry.title);
  const body = normalize(entry.body);

  // A whole-phrase keyword hit is the strongest signal there is: the reader
  // typed the exact thing somebody anticipated them typing.
  if (keywords.some(k => k === q || q.includes(k) && k.includes(' '))) total += 12;

  for (const term of terms) {
    if (keywords.some(k => k === term)) total += 6;
    else if (keywords.some(k => k.includes(term))) total += 3;
    if (title.includes(term)) total += 2;
    if (body.includes(term)) total += 1;
  }
  return total;
};

/** Entries matching a question, best first. Empty when nothing is close. */
export const searchDocs = (query: string, limit = MAX_DOC_HITS): DocEntry[] =>
  GUIDE_DOCS
    .map(entry => ({ entry, s: score(entry, query) }))
    .filter(r => r.s > 0)
    .sort((a, b) => b.s - a.s || a.entry.id.localeCompare(b.entry.id))
    .slice(0, Math.max(1, limit))
    .map(r => r.entry);

export const docById = (id: string): DocEntry | undefined =>
  GUIDE_DOCS.find(d => d.id === id.trim().toLowerCase());

/**
 * A compact index of everything, for the system prompt.
 *
 * Titles and ids only. The guide is told what questions it can answer without
 * being told every answer, which is the difference between a few hundred tokens
 * per turn and several thousand — and it can fetch any of them in one step.
 */
export const docIndex = (): string =>
  GUIDE_DOCS.map(d => `${d.id} — ${d.title}`).join('\n');
