/**
 * The tool surface the reading assistant is allowed to act through.
 *
 * Until now every AI feature that CHANGED something was driven by a button —
 * the Lens rewrite, the cowrite, the visitor's turn, the pin update. The
 * assistant itself could only ever answer: `runAssistant` builds a system
 * prompt, sends the thread, and renders the text that comes back. So "update
 * that pin with what we just worked out" was a thing the reader could say and
 * the assistant could only agree with.
 *
 * This is the smallest surface that fixes that, and the reasoning behind its
 * shape is worth keeping:
 *
 * **It reads widely and writes in exactly one place.** Ten read tools, two
 * write tools, and both writes go through a pin's version history. A pin that
 * gains a version has lost nothing — the ◀ ▶ stepper in `PinDock` is already
 * the undo, and it was built before any of this existed. That is the whole
 * reason the write surface is pins: it is the only structure in the app where
 * a wrong answer is a keystroke away from being reverted, so the agent needs no
 * confirmation dialog and the reader needs no vigilance.
 *
 * **No tool calls the model.** Every tool here is a read or a store write over
 * data the caller already has. The temptation is `pins.revise` — hand the tool
 * an instruction and let it run `buildPinUpdateMessages` internally — and it is
 * a trap: it puts a model call inside a module that is otherwise pure, hides a
 * second generation behind what reads as a function call, and gives the agent
 * no way to see what it just wrote. The agent reads the pin, writes the new
 * text ITSELF, and calls `pins.newVersion` with it. One generation, visible.
 *
 * **A failed call answers with what would have worked.** A model that names a
 * pin that isn't there gets the list of pins back, not "error". Recoverable
 * errors are the difference between an agent that fixes its own typo and one
 * that apologises for three turns.
 *
 * Pure: no store, no React, no fetch. Everything it touches arrives in a
 * `ToolContext`, which is what makes the whole surface testable with `tsx`.
 */

import { salvageObject, stripReasoning } from './aiCall';

/* ------------------------------------------------------------------ */
/* Calls                                                               */
/* ------------------------------------------------------------------ */

export interface ToolCall {
  tool: string;
  /** Everything in the directive except `tool` — arguments are flat. */
  args: Record<string, unknown>;
}

/**
 * The reply to one call.
 *
 * `ok: false` is an ordinary outcome, not an exception: a model that asks for
 * message 900 of an 80-message story is having a normal day. Every failure
 * carries `error` plus, wherever there is one, a `hint` naming what it could
 * have asked for instead.
 */
export interface ToolResult {
  ok: boolean;
  [key: string]: unknown;
}

/** A call and what came back, kept together so the thread can show both. */
export interface AgentStep {
  call: ToolCall;
  result: ToolResult;
}

/**
 * How many directives one reply may carry.
 *
 * A model that has understood the protocol emits one or two. A model that has
 * not sometimes emits the entire catalogue as an example of what it COULD do,
 * and executing that is a page of tool output for a question nobody asked.
 */
export const MAX_CALLS_PER_STEP = 4;

/**
 * Ceiling on one tool's output, in characters.
 *
 * `zones.build` over a large zone is tens of thousands of characters, and it
 * lands in the history where it is re-sent on every subsequent step. Uncapped,
 * one generous read costs the rest of the conversation its room.
 */
export const TOOL_OUTPUT_CHARS = 6000;

/**
 * Trim from the MIDDLE, not the end.
 *
 * The end of a tool result is where the answer usually is — the last messages
 * of a range, the tail of a document. Cutting the tail off leaves the model
 * confidently reading a truncated document as a whole one; cutting the middle
 * out and saying so leaves it knowing there is a gap. Borrowed from the
 * `truncate_middle` policy in Codex's own tool-output layer, for the same
 * reason it exists there.
 */
export const truncateMiddle = (text: string, cap = TOOL_OUTPUT_CHARS): string => {
  if (text.length <= cap) return text;
  const keep = Math.max(200, Math.floor((cap - 80) / 2));
  const head = text.slice(0, keep);
  const tail = text.slice(text.length - keep);
  const cut = text.length - head.length - tail.length;
  return `${head}\n\n…[${cut} characters elided from the middle of ${text.length}]…\n\n${tail}`;
};

/* ------------------------------------------------------------------ */
/* Parsing a reply                                                     */
/* ------------------------------------------------------------------ */

/** The fence a directive travels in. */
const FENCE = /```aura-tool\s*\n?([\s\S]*?)```/g;

/**
 * Pull the directives out of a reply.
 *
 * The protocol is a fenced block rather than the OpenAI `tools` parameter
 * because this app talks to KoboldCpp, llama.cpp, Ollama and LM Studio as
 * first-class endpoints, and native function calling on those ranges from
 * unreliable to a 400. A fence is just text: every endpoint can emit one, the
 * reader can read it, and the existing `salvageObject` already knows how to get
 * an object out of a model that closed a brace in the wrong place.
 *
 * Fails soft in the direction that keeps talking. A malformed directive is
 * skipped rather than thrown, and a reply with no directive at all is not an
 * error — it is the answer, which is how the loop knows it is finished.
 */
export const parseToolCalls = (reply: string): ToolCall[] => {
  const text = stripReasoning(reply ?? '');
  const calls: ToolCall[] = [];

  const take = (body: string) => {
    if (calls.length >= MAX_CALLS_PER_STEP) return;
    const obj = salvageObject<Record<string, unknown>>(body);
    const tool = obj && typeof obj.tool === 'string' ? obj.tool.trim() : '';
    if (!tool) return;
    const { tool: _drop, ...args } = obj as Record<string, unknown>;
    calls.push({ tool, args });
  };

  FENCE.lastIndex = 0;
  for (let m = FENCE.exec(text); m; m = FENCE.exec(text)) take(m[1]);
  if (calls.length) return calls;

  // A model that answers in bare JSON rather than a fence. Accepted ONLY when
  // the whole reply is that object: scanning loose prose for anything with a
  // "tool" key would let a sentence ABOUT a tool execute one.
  const bare = text.trim();
  if (bare.startsWith('{') && bare.endsWith('}')) take(bare);
  return calls;
};

/**
 * The reply with its directives taken out — what the reader should see.
 *
 * A model usually writes a line of prose around the block ("Let me look at
 * that pin."). That line is worth showing; the JSON is not.
 */
export const stripToolCalls = (reply: string): string =>
  (reply ?? '').replace(FENCE, '').replace(/\n{3,}/g, '\n\n').trim();

/* ------------------------------------------------------------------ */
/* What a tool is given                                                */
/* ------------------------------------------------------------------ */

/**
 * Narrow row shapes, declared here rather than imported from the store.
 *
 * `utils/` does not import `stores/` anywhere in this app and this module is
 * not going to be the first: the dependency runs stores → utils, and closing
 * that loop would make module init order load-bearing for the same reason
 * `AppV2` explains for the app store. The adapter in the component maps the
 * real records onto these.
 */
export interface PinRow {
  id: string;
  title: string;
  format: 'html' | 'markdown';
  content: string;
  versionCount: number;
  activeVersion: number;
  inContext: boolean;
}

export interface ZoneRow {
  id: string;
  name: string;
  /** `zoneSummary`'s one-liner — "msg 6–10, 14 · branchlines 12". */
  summary: string;
}

export interface MessageRow {
  /** 1-based flat reading index, the same number `buildZoneBody` prints as #N. */
  index: number;
  name: string;
  content: string;
}

export interface CodexRow {
  name: string;
  kind: string;
  aliases: string[];
  summary: string;
  mentions: number;
}

export interface SheetRow {
  id: string;
  title: string;
  columns: string[];
  rowCount: number;
  rows: Record<string, string>[];
}

/** A zone rendered for the prompt — `buildZoneBody`'s output, passed through. */
export interface ZoneBody {
  name: string;
  body: string;
  messageCount: number;
  branchlineCount: number;
  empty: boolean;
}

/**
 * Everything the tools may touch, injected.
 *
 * Reads are functions rather than data so a big one (the whole transcript) is
 * only paid for when a tool actually asks. Writes return what happened rather
 * than void, because the result is what the model reads next.
 */
export interface ToolContext {
  /** Total messages in the story, for bounds-checking a range read. */
  messageCount: number;
  listPins: () => PinRow[];
  listZones: () => ZoneRow[];
  buildZone: (zoneId: string) => ZoneBody | null;
  /** Inclusive 1-based range of the flat reading order. */
  readStory: (from: number, to: number) => MessageRow[];
  searchStory: (query: string, limit: number) => MessageRow[];
  listCodex: () => CodexRow[];
  listSheets: () => SheetRow[];
  createPin: (title: string, content: string, format: 'html' | 'markdown') => string;
  /** Returns the new 1-based version number, or null when the pin is gone. */
  addPinVersion: (pinId: string, content: string, instruction: string) => number | null;
  /** Lens edits already in place, so the model can see what it is building on. */
  listLens: () => LensRow[];
  /**
   * Put a rewrite in front of the reader. Explicitly NOT a write — see
   * `lensProposal.ts`. Returns null when the message does not exist.
   */
  proposeLens: (target: number, content: string, note: string) => LensStaged | null;

  /* ---- Guide-only. Absent unless the AI Tour Guide is switched on, and the
   * tools that use them say so rather than pretending to work. ---- */

  /** Where the reader is: screen, view, preset, story, passage. */
  readerPlace?: () => Record<string, unknown>;
  /** Move them. Returns a ToolResult so a refusal can explain itself. */
  goTo?: (to: { view: string; uiMode: string; panel: string }) => ToolResult;
  /** Change one allowlisted display setting. */
  setSetting?: (key: string, value: unknown) => ToolResult;
}

/** A Lens override the reader already has in place. */
export interface LensRow {
  index: number;
  name: string;
  /** The story's own text. */
  original: string;
  /** What the Lens shows instead. */
  content: string;
  note?: string;
}

/** What came of staging a proposal — the model reads this and reports it. */
export interface LensStaged {
  index: number;
  name: string;
  /** The passage as it stands, so a model that guessed wrong can tell. */
  before: string;
  /** True when the rewrite is indistinguishable from the passage it replaces. */
  noop: boolean;
}

/* ------------------------------------------------------------------ */
/* The tools                                                           */
/* ------------------------------------------------------------------ */

export interface AgentTool {
  name: string;
  /** One line, shown to the model. */
  description: string;
  /** Argument spec, in the same one-line form. '' for a tool that takes none. */
  params: string;
  /** True for the two that change something — rendered apart in the catalogue. */
  writes?: boolean;
  /**
   * True for a tool that only PUTS SOMETHING IN FRONT OF THE READER.
   *
   * Deliberately not `writes`. A staging tool has no path to the store at all;
   * the most it can do is add a row to a review queue that a person then
   * approves or throws away. Keeping the flags separate is what lets the
   * "exactly two tools write" tripwire stay true and keep meaning something as
   * the tool surface grows.
   */
  stages?: boolean;
  /**
   * True for a tool that changes WHAT IS ON SCREEN, and nothing else.
   *
   * A fourth category rather than a second kind of write, because the two are
   * not comparable risks. A write changes the reader's story; this changes
   * which view they are looking at, or a cosmetic setting they can see change
   * and change back. Folding these into `writes` would break the "exactly two
   * tools write" tripwire and, worse, would make it stop meaning anything.
   *
   * Everything reachable this way is reversible by the reader in one action.
   */
  navigates?: boolean;
  run: (args: Record<string, unknown>, ctx: ToolContext) => ToolResult | Promise<ToolResult>;
}

import { docById, docIndex, searchDocs } from './guideDocs';

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** How many messages one `story.read` may return, however wide the range asked. */
export const MAX_READ_MESSAGES = 60;
/** Default and ceiling for `story.search`. */
export const DEFAULT_SEARCH_HITS = 8;
export const MAX_SEARCH_HITS = 25;

/**
 * A pin argument resolves by id OR by title, case-insensitively.
 *
 * The model has just been shown a list of pins with both, and which one it
 * reaches for is a coin toss. Accepting either costs four lines and removes an
 * entire category of failed step.
 */
const findPin = (ctx: ToolContext, arg: unknown): PinRow | null => {
  const want = str(arg).toLowerCase();
  if (!want) return null;
  const pins = ctx.listPins();
  return pins.find(p => p.id.toLowerCase() === want)
    ?? pins.find(p => p.title.toLowerCase() === want)
    ?? null;
};

const pinMiss = (ctx: ToolContext, arg: unknown): ToolResult => ({
  ok: false,
  error: `No pin matches ${JSON.stringify(str(arg))}.`,
  hint: 'Use one of these ids, or call pins.list first.',
  pins: ctx.listPins().map(p => ({ id: p.id, title: p.title })),
});

const findZone = (ctx: ToolContext, arg: unknown): ZoneRow | null => {
  const want = str(arg).toLowerCase();
  if (!want) return null;
  const zones = ctx.listZones();
  return zones.find(z => z.id.toLowerCase() === want)
    ?? zones.find(z => z.name.toLowerCase() === want)
    ?? null;
};


/**
 * Settings the guide may change on the reader's behalf.
 *
 * An allowlist, not a denylist, and short on purpose. Everything here is
 * cosmetic, instantly visible, and undone by changing it back — a reader who
 * says "make the text bigger" gets bigger text and can see it happen.
 *
 * What is deliberately absent is more informative than what is present: no AI
 * endpoint or key, no sync toggles, nothing that spends money, nothing about
 * storage, and nothing whose effect the reader would not immediately notice. A
 * guide that can quietly repoint the assistant at another endpoint is not a
 * guide. When the answer involves one of those, the guide opens the settings
 * panel and lets the reader do it.
 */
export const GUIDE_SETTINGS: readonly {
  key: string; label: string; values: string; kind: 'enum' | 'number' | 'boolean';
}[] = [
  { key: 'readingMode', label: 'How much the app performs the text', kind: 'enum', values: 'plain | lit | cinema | performance' },
  { key: 'uiMode', label: 'Workspace preset', kind: 'enum', values: 'read | cowrite | scenes | all' },
  { key: 'theme', label: 'Colour theme', kind: 'enum', values: 'any theme name, e.g. dark, sepia, book, terminal' },
  { key: 'fontSize', label: 'Text size in pixels', kind: 'number', values: '12–32' },
  { key: 'fontFamily', label: 'Typeface', kind: 'enum', values: 'theme | sans | serif | mono | handwriting | typewriter | dyslexic' },
  { key: 'contentWidth', label: 'Reading column width', kind: 'number', values: '480–1400' },
  { key: 'paragraphSpacing', label: 'Space between paragraphs', kind: 'number', values: '0–3' },
  { key: 'playbackSpeed', label: 'Reveal speed', kind: 'number', values: '0.25–4' },
  { key: 'autoStream', label: 'Reveal text as it is read', kind: 'boolean', values: 'true | false' },
  { key: 'showHiddenMessages', label: 'Show narrator and hidden entries', kind: 'boolean', values: 'true | false' },
  { key: 'showImages', label: 'Show images from the chat', kind: 'boolean', values: 'true | false' },
  { key: 'dropCaps', label: 'Large opening letters', kind: 'boolean', values: 'true | false' },
  { key: 'smartTypography', label: 'Curly quotes and dashes', kind: 'boolean', values: 'true | false' },
];

const GUIDE_SETTING_KEYS = new Set(GUIDE_SETTINGS.map(s => s.key));

export const AGENT_TOOLS: readonly AgentTool[] = [
  {
    name: 'guide.docs',
    description:
      'Look up how this app works. Search in the READER\'S words, not the app\'s — '
      + '"read aloud" and "voice" both find the same answer. Use this before '
      + 'explaining any feature; never describe a button from memory.',
    params: 'query: string, id?: string (fetch one entry outright)',
    run: (args) => {
      const id = str(args.id);
      if (id) {
        const doc = docById(id);
        return doc
          ? { ok: true, doc }
          : { ok: false, error: `No entry called ${JSON.stringify(id)}.`, index: docIndex() };
      }
      const query = str(args.query);
      if (!query) return { ok: false, error: 'Give a query, or an id.', index: docIndex() };
      const hits = searchDocs(query);
      return hits.length
        ? { ok: true, hits }
        : {
          ok: false,
          error: `Nothing in the manual matches ${JSON.stringify(query)}.`,
          hint: 'Say so plainly rather than guessing. These are every subject covered:',
          index: docIndex(),
        };
    },
  },
  {
    name: 'guide.where',
    description:
      'Where the reader is right now: screen, view, workspace preset, the story '
      + 'they have open and the passage they are on. Call this first when they say '
      + '"this", "here" or "the current one".',
    params: '',
    run: (_args, ctx) => (ctx.readerPlace
      ? { ok: true, ...ctx.readerPlace() }
      : { ok: false, error: 'The guide is not switched on for this session.' }),
  },
  {
    name: 'app.goto',
    description:
      'Take the reader somewhere: a view, a workspace preset, or a panel. Say what '
      + 'you are about to do first — a screen that changes without warning is '
      + 'disorienting. Nothing here alters the story.',
    params: 'view?: string, uiMode?: read|cowrite|scenes|all, panel?: string',
    navigates: true,
    run: (args, ctx) => {
      if (!ctx.goTo) return { ok: false, error: 'The guide is not switched on for this session.' };
      const view = str(args.view).toLowerCase();
      const uiMode = str(args.uiMode).toLowerCase();
      const panel = str(args.panel).toLowerCase();
      if (!view && !uiMode && !panel) {
        return { ok: false, error: 'Name a view, a uiMode, or a panel.' };
      }
      return ctx.goTo({ view, uiMode, panel });
    },
  },
  {
    name: 'app.setting',
    description:
      'Change one of the reader\'s display settings. Only the cosmetic ones are '
      + 'reachable; anything about the AI endpoint, syncing or their data is not, '
      + 'and for those you should open the settings panel instead. Call with no '
      + 'arguments to see what is available.',
    params: 'key: string, value: string | number | boolean',
    navigates: true,
    run: (args, ctx) => {
      if (!ctx.setSetting) return { ok: false, error: 'The guide is not switched on for this session.' };
      const key = str(args.key);
      if (!key) return { ok: true, settings: GUIDE_SETTINGS };
      if (!GUIDE_SETTING_KEYS.has(key)) {
        return {
          ok: false,
          error: `“${key}” is not a setting the guide may change.`,
          hint: 'Open the settings panel with app.goto instead, and tell the reader where to look.',
          settings: GUIDE_SETTINGS,
        };
      }
      if (args.value === undefined) return { ok: false, error: 'Give a value.', settings: GUIDE_SETTINGS };
      return ctx.setSetting(key, args.value);
    },
  },
  {
    name: 'pins.list',
    description: 'Every pin beside this story: id, title, size and how many versions it has.',
    params: '',
    run: (_args, ctx) => ({
      ok: true,
      pins: ctx.listPins().map(p => ({
        id: p.id,
        title: p.title,
        format: p.format,
        chars: p.content.length,
        versions: p.versionCount,
        activeVersion: p.activeVersion + 1,
        inContext: p.inContext,
      })),
    }),
  },
  {
    name: 'pins.read',
    description: 'The full current text of one pin. Read before you rewrite.',
    params: '"pin": id or title',
    run: (args, ctx) => {
      const pin = findPin(ctx, args.pin ?? args.id ?? args.title);
      if (!pin) return pinMiss(ctx, args.pin ?? args.id ?? args.title);
      return {
        ok: true,
        id: pin.id,
        title: pin.title,
        format: pin.format,
        version: pin.activeVersion + 1,
        of: pin.versionCount,
        content: truncateMiddle(pin.content),
      };
    },
  },
  {
    name: 'zones.list',
    description: "The reader's saved context zones — named selections of the story.",
    params: '',
    run: (_args, ctx) => ({ ok: true, zones: ctx.listZones() }),
  },
  {
    name: 'zones.build',
    description: 'The full text of one context zone, formatted as it would be sent.',
    params: '"zone": id or name',
    run: (args, ctx) => {
      const zone = findZone(ctx, args.zone ?? args.id ?? args.name);
      if (!zone) {
        return {
          ok: false,
          error: `No context zone matches ${JSON.stringify(str(args.zone ?? args.id ?? args.name))}.`,
          hint: 'Use one of these, or call zones.list first.',
          zones: ctx.listZones().map(z => ({ id: z.id, name: z.name })),
        };
      }
      const built = ctx.buildZone(zone.id);
      if (!built) return { ok: false, error: 'That zone could not be built.' };
      if (built.empty) {
        return {
          ok: true, empty: true, name: built.name,
          note: 'This zone selects nothing that is still in the story.',
        };
      }
      return {
        ok: true,
        name: built.name,
        messages: built.messageCount,
        branchlines: built.branchlineCount,
        body: truncateMiddle(built.body),
      };
    },
  },
  {
    name: 'story.read',
    description: `Messages by reading position, inclusive. At most ${MAX_READ_MESSAGES} at a time.`,
    params: '"from": number, "to": number  (1-based, the #N numbers zones use)',
    run: (args, ctx) => {
      const from = num(args.from) ?? num(args.start) ?? 1;
      const to = num(args.to) ?? num(args.end) ?? from;
      if (from < 1 || from > ctx.messageCount) {
        return {
          ok: false,
          error: `"from" is ${from}; this story has messages 1–${ctx.messageCount}.`,
        };
      }
      const lo = Math.floor(from);
      const hi = Math.min(Math.floor(Math.max(to, from)), ctx.messageCount, lo + MAX_READ_MESSAGES - 1);
      const rows = ctx.readStory(lo, hi);
      return {
        ok: true,
        from: lo,
        to: hi,
        of: ctx.messageCount,
        truncated: hi < Math.floor(Math.max(to, from)),
        messages: rows.map(r => `#${r.index} ${r.name}: ${truncateMiddle(r.content, 2000)}`),
      };
    },
  },
  {
    name: 'story.search',
    description: 'Find where something is said. Returns matching messages with their #N.',
    params: `"query": text, "limit": number (default ${DEFAULT_SEARCH_HITS})`,
    run: (args, ctx) => {
      const query = str(args.query ?? args.q ?? args.text);
      if (!query) return { ok: false, error: 'story.search needs a "query".' };
      const limit = Math.max(1, Math.min(num(args.limit) ?? DEFAULT_SEARCH_HITS, MAX_SEARCH_HITS));
      const hits = ctx.searchStory(query, limit);
      return {
        ok: true,
        query,
        hits: hits.length,
        matches: hits.map(r => `#${r.index} ${r.name}: ${truncateMiddle(r.content, 600)}`),
      };
    },
  },
  {
    name: 'codex.list',
    description: 'The people, places and things extracted from the story so far.',
    params: '"kind": character | location | item  (optional)',
    run: (args, ctx) => {
      const kind = str(args.kind).toLowerCase();
      const rows = ctx.listCodex().filter(e => !kind || e.kind === kind);
      return { ok: true, entities: rows };
    },
  },
  {
    name: 'sheets.read',
    description: "The reader's tracking tables.",
    params: '"sheet": id or title (optional; omit for all)',
    run: (args, ctx) => {
      const want = str(args.sheet ?? args.id ?? args.title).toLowerCase();
      const all = ctx.listSheets();
      const rows = want
        ? all.filter(s => s.id.toLowerCase() === want || s.title.toLowerCase() === want)
        : all;
      if (want && !rows.length) {
        return {
          ok: false,
          error: `No sheet matches ${JSON.stringify(str(args.sheet ?? args.id ?? args.title))}.`,
          sheets: all.map(s => ({ id: s.id, title: s.title })),
        };
      }
      return { ok: true, sheets: rows };
    },
  },
  {
    name: 'pins.create',
    description: 'Start a new pin. Use only when no existing pin is the right home.',
    params: '"title": text, "content": the full text, "format": markdown | html',
    writes: true,
    run: (args, ctx) => {
      const title = str(args.title ?? args.name);
      const content = str(args.content ?? args.text ?? args.body);
      if (!title) return { ok: false, error: 'pins.create needs a "title".' };
      if (!content) return { ok: false, error: 'pins.create needs "content".' };
      const format = str(args.format).toLowerCase() === 'html' ? 'html' : 'markdown';
      const id = ctx.createPin(title, content, format);
      if (!id) {
        return {
          ok: false,
          error: 'This story has as many pins as it can hold, so none was made.',
          hint: 'Write into an existing pin with pins.newVersion instead.',
          pins: ctx.listPins().map(p => ({ id: p.id, title: p.title })),
        };
      }
      return { ok: true, pinId: id, title, chars: content.length, version: 1 };
    },
  },
  {
    name: 'pins.newVersion',
    description:
      'Save new text for a pin AS A NEW VERSION. Send the complete replacement text, '
      + 'never a diff or a fragment — this becomes the whole pin.',
    params: '"pin": id or title, "content": the full new text, "instruction": why (short)',
    writes: true,
    run: (args, ctx) => {
      const pin = findPin(ctx, args.pin ?? args.id ?? args.title);
      if (!pin) return pinMiss(ctx, args.pin ?? args.id ?? args.title);
      const content = str(args.content ?? args.text ?? args.body);
      if (!content) {
        return {
          ok: false,
          error: 'pins.newVersion needs "content" — the complete new text of the pin.',
          hint: 'An empty version would blank the pin, so it is refused.',
        };
      }
      const instruction = str(args.instruction ?? args.note ?? args.why);
      const version = ctx.addPinVersion(pin.id, content, instruction);
      if (version === null) return pinMiss(ctx, pin.id);
      return {
        ok: true,
        pinId: pin.id,
        title: pin.title,
        version,
        chars: content.length,
        note: 'Saved as a new version. The reader can step back to the previous one.',
      };
    },
  },
  {
    name: 'lens.list',
    description:
      'Lens edits the reader already has on this story — the passages that show '
      + 'rewritten text instead of the original.',
    params: '',
    run: (_args, ctx) => {
      const rows = ctx.listLens();
      if (!rows.length) {
        return { ok: true, edits: [], note: 'This story has no Lens edits yet.' };
      }
      return {
        ok: true,
        edits: rows.map(r => ({
          message: r.index,
          name: r.name,
          note: r.note,
          shows: truncateMiddle(r.content, 600),
          instead_of: truncateMiddle(r.original, 300),
        })),
      };
    },
  },
  {
    name: 'lens.propose',
    description:
      'Offer the reader a rewrite of one message. This does NOT change the story — '
      + 'it shows them the change and they accept or reject it. Read the message first.',
    params:
      '"message": the reading number, "content": the complete rewritten passage, '
      + '"note": what you changed and why (one line)',
    stages: true,
    run: (args, ctx) => {
      const target = num(args.message ?? args.index ?? args.id ?? args.n);
      if (target === null) {
        return {
          ok: false,
          error: 'lens.propose needs "message" — the reading number of the message to rewrite.',
          hint: 'Use story.search or story.read to find it first.',
        };
      }
      if (target < 1 || target > ctx.messageCount) {
        return {
          ok: false,
          error: `There is no message ${target}. This story has ${ctx.messageCount}.`,
        };
      }
      const content = str(args.content ?? args.text ?? args.rewrite ?? args.body);
      if (!content) {
        return {
          ok: false,
          error: 'lens.propose needs "content" — the complete rewritten passage.',
          hint: 'Send the whole passage, not a diff or a fragment. It replaces the message.',
        };
      }
      const note = str(args.note ?? args.instruction ?? args.why);
      const staged = ctx.proposeLens(target, content, note);
      if (!staged) return { ok: false, error: `Message ${target} could not be read.` };
      if (staged.noop) {
        return {
          ok: false,
          error: 'That rewrite is the same as the passage it would replace, so nothing was staged.',
          hint: 'Either make the change the reader asked for, or say that the passage already does it.',
          passage: truncateMiddle(staged.before, 1200),
        };
      }
      return {
        ok: true,
        staged: true,
        message: staged.index,
        name: staged.name,
        chars: content.length,
        note:
          'Waiting for the reader. They can see your rewrite next to the original and will '
          + 'accept or reject it — you cannot apply it yourself. Tell them what you changed, '
          + 'briefly, and stop.',
      };
    },
  },
];

export const toolByName = (name: string): AgentTool | undefined =>
  AGENT_TOOLS.find(t => t.name === name.trim());

/* ------------------------------------------------------------------ */
/* Running one                                                         */
/* ------------------------------------------------------------------ */

/**
 * Execute a call. Never throws — a tool that blows up returns a failed result,
 * because the loop's job is to hand the model something it can respond to and
 * an exception here would take down a conversation the reader is sitting in.
 */
export const runToolCall = async (call: ToolCall, ctx: ToolContext): Promise<ToolResult> => {
  const tool = toolByName(call.tool);
  if (!tool) {
    return {
      ok: false,
      error: `There is no tool called ${JSON.stringify(call.tool)}.`,
      tools: AGENT_TOOLS.map(t => t.name),
    };
  }
  try {
    return await tool.run(call.args, ctx);
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? 'The tool failed.' };
  }
};

/** One step's result, rendered for the model to read on the next pass. */
export const renderToolResult = (step: AgentStep): string =>
  truncateMiddle(
    `TOOL RESULT (${step.call.tool}):\n${JSON.stringify(step.result, null, 1)}`,
    TOOL_OUTPUT_CHARS + 500,
  );

/* ------------------------------------------------------------------ */
/* Teaching the protocol                                               */
/* ------------------------------------------------------------------ */

/**
 * The catalogue, appended to the system prompt.
 *
 * Written for a 7B local model rather than a frontier one: the rules that
 * matter are stated as rules ("one block", "wait for the result"), the writes
 * are called out separately from the reads, and the example is a complete
 * directive rather than a schema. Every line here was earned by a way the
 * protocol can be misunderstood.
 */
/**
 * The catalogue the model is given.
 *
 * `guiding` adds the four tools that move the reader around the app. They are
 * off by default and listed only when the AI Tour Guide is switched on: an
 * assistant that is helping cowrite has no business changing which view the
 * reader is looking at, and a tool it can see is a tool it will eventually
 * reach for.
 */
/** The four tools that exist only for the guide. */
const GUIDE_TOOL_NAMES = new Set(['guide.docs', 'guide.where', 'app.goto', 'app.setting']);
export const isGuideTool = (t: AgentTool): boolean => GUIDE_TOOL_NAMES.has(t.name);

export const renderToolCatalog = (guiding = false): string => {
  const line = (t: AgentTool) =>
    `  ${t.name}${t.params ? ` — ${t.params}` : ''}\n      ${t.description}`;
  const offered = AGENT_TOOLS.filter(t => guiding || !isGuideTool(t));
  const reads = offered.filter(t => !t.writes && !t.stages && !t.navigates).map(line).join('\n');
  const moves = offered.filter(t => t.navigates).map(line).join('\n');
  const writes = offered.filter(t => t.writes).map(line).join('\n');
  const stages = offered.filter(t => t.stages).map(line).join('\n');

  return [
    '--- TOOLS ---',
    'You can look things up and update the reader\'s pins. To use a tool, end your',
    'reply with ONE fenced block, exactly like this:',
    '',
    '```aura-tool',
    '{"tool": "pins.read", "pin": "pin-4f2"}',
    '```',
    '',
    'Then STOP. The result comes back as the next message and you continue from it.',
    'Do not imagine a result, and do not write the block unless you want it run.',
    '',
    'LOOKING THINGS UP:',
    reads,
    '',
    'CHANGING A PIN:',
    writes,
    '',
    'SUGGESTING A CHANGE TO THE STORY ITSELF:',
    stages,
    ...(guiding ? [
      '',
      'SHOWING THE READER AROUND:',
      moves,
    ] : []),
    '',
    'RULES:',
    '- One block per reply. Do not chain calls you have not seen the result of.',
    '- Read a pin before you rewrite it. "content" replaces the pin entirely.',
    '- A write always makes a NEW VERSION; nothing is ever overwritten, so you do',
    '  not need permission to save. Say what you changed afterwards.',
    '- Read a message before you propose rewriting it, and send the WHOLE passage.',
    '- A proposed rewrite is not applied. The reader sees it beside the original and',
    '  decides. Never say you have changed the story — say you have suggested it.',
    ...(guiding ? [
      '- Look the answer up with guide.docs before explaining any feature. If it is',
      '  not in the manual, say you are not sure rather than inventing a button.',
      '- Say where you are taking them BEFORE calling app.goto. A screen that changes',
      '  without warning is disorienting.',
      '- You may change the display settings on the allowlist. For anything else —',
      '  the AI endpoint, syncing, their data — open the panel and tell them where to',
      '  look. Do not ask for a setting you cannot reach.',
    ] : []),
    '- When you have the answer, just answer. No block means you are done.',
  ].join('\n');
};
