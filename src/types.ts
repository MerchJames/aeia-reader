export type Role = 'user' | 'ai';

/** Which image backend the reader points at — see `services/image/`. */
export type ImageAdapterId = 'openai' | 'comfy';

/**
 * One generated picture, filed against the beat it belongs to.
 *
 * Metadata ONLY — the bytes live in their own IndexedDB (`lib/artStorage.ts`),
 * because the v2 slice store rewrites a whole record on every debounced save
 * and a megabyte per image would make that ruinous.
 */
export interface SceneArt {
  id: string;
  /** The prompt actually sent, after the preset and appearance sheet. */
  prompt: string;
  negative?: string;
  preset: string;
  adapter: ImageAdapterId;
  seed?: number;
  width: number;
  height: number;
  createdAt: number;
}

/** Highlight swatch options: key → { label, background }. */
export const HIGHLIGHT_COLORS: { key: string; label: string; bg: string }[] = [
  { key: 'yellow', label: 'Yellow', bg: 'rgba(250, 204, 21, 0.4)' },
  { key: 'green', label: 'Green', bg: 'rgba(74, 222, 128, 0.4)' },
  { key: 'blue', label: 'Blue', bg: 'rgba(96, 165, 250, 0.4)' },
  { key: 'pink', label: 'Pink', bg: 'rgba(244, 114, 182, 0.4)' },
  { key: 'orange', label: 'Orange', bg: 'rgba(251, 146, 60, 0.45)' },
];

export interface Message {
  id: string;
  role: Role;
  name: string;
  content: string;
  avatar?: string;
  /** Images attached to the message (data URLs or resolvable URLs). */
  images?: string[];
  /** Alternate versions of this message (SillyTavern swipes / card greetings). */
  swipes?: string[];
  /** SillyTavern narrator / `/hide`-den entry — shown, but visually marked. */
  hidden?: boolean;
  /** Force a new chain (page) to begin at this message — used for document chapters. */
  startsChain?: boolean;
}

export interface ChainStarSettings {
  speed?: number;
  animationStyle?: AnimationStyle;
  zoom?: boolean;
}

export interface Chain {
  id: string;
  messages: Message[];
  starred: boolean;
  starSettings?: ChainStarSettings;
}

/**
 * An attached branch: a divergent tail forked off the trunk at `forkIndex`.
 * SillyTavern exports each branch as its own chat file; on import, files
 * sharing history are matched by content and stored like this —
 * non-destructively, the trunk is never rewritten.
 */
export interface StoryTimeline {
  id: string;
  /** Human name, usually the branch file's name. */
  name: string;
  /** Number of trunk messages shared before the divergence. */
  forkIndex: number;
  /** The divergent tail (messages after the fork). */
  messages: Message[];
  addedAt: number;
}

export type StoryFormat = 'sillytavern' | 'kobold' | 'card' | 'document';

export interface Highlight {
  id: string;
  text: string;
  messageId?: string;
  timestamp: number;
  /** Optional annotation the reader attaches to the highlight. */
  note?: string;
  /** Highlight color key (see HIGHLIGHT_COLORS). */
  color?: string;
}

export interface StoryProgress {
  chainIndex: number;
  messageIndex: number;
}

/** One entry of a character card's embedded lorebook (character_book). */
export interface CardLoreEntry {
  /** Trigger keywords, e.g. ["Ravenholm", "the city"]. */
  keys: string[];
  /** Entry name/comment when the author gave one. */
  title?: string;
  content: string;
}

/**
 * Author-written companion data from a character card (V1/V2/CCv3).
 * Attached to a story at import; feeds avatars, the codex, and gives the
 * AI assistant richer ground truth for summaries.
 */
export interface CardInfo {
  name?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  creator?: string;
  creatorNotes?: string;
  tags?: string[];
  lorebook?: CardLoreEntry[];
  /** Card spec detected at parse: 'v1' | 'v2' | 'v3'. */
  spec?: string;
}

export interface StoryMeta {
  id: string;
  title: string;
  format: StoryFormat;
  characterName?: string;
  userName?: string;
  /** Data URL so it survives persistence. */
  avatar?: string;
  /** Reader-supplied profile pictures (data URLs), override generated avatars. */
  characterAvatar?: string;
  userAvatar?: string;
  /** Per-character avatars for group chats, keyed by character name. */
  characterAvatars?: Record<string, string>;
  messageCount: number;
  importedAt: number;
  progress?: StoryProgress | null;
  /** 0-100, how far through the story the reader is. */
  progressPct?: number;
  /** Card tags shown in the library (from an attached character card). */
  tags?: string[];
}

export interface Story extends StoryMeta {
  messages: Message[];
  highlights: Highlight[];
  /** Starred chain settings, keyed by chain id. */
  stars?: Record<string, ChainStarSettings>;
  /** Companion character-card data attached at import. */
  card?: CardInfo;
  /** Attached branches (imported branch files), forked off the trunk. */
  timelines?: StoryTimeline[];
  /** Timeline currently being read; null/undefined = the trunk. */
  activeTimeline?: string | null;
}

export type Screen = 'library' | 'reader';
export type ViewMode =
  | 'storybook' | 'chat' | 'book' | 'stage' | 'vn' | 'sandbox'
  | 'overview' | 'highlights' | 'branches';
/**
 * Top-level workspace preset — gates which tools/views are visible so the app
 * can start simple and reveal power on demand. 'read' = just reading; 'cowrite'
 * = AI writing tools; 'scenes' = the Sandbox/Scene Director; 'all' = everything.
 */
export type UiMode = 'read' | 'cowrite' | 'scenes' | 'all';
export type LayoutMode = 'continuous' | 'paginated';
export type Theme =
  | 'light' | 'dark' | 'sepia' | 'notebook' | 'terminal'
  | 'book' | 'phone' | 'essay' | 'hacker' | 'custom'
  | 'win98' | 'vista' | 'parchment' | 'synthwave' | 'amoled'
  | 'ocean' | 'forest' | 'sakura' | 'comic' | 'newspaper'
  | 'grimoire' | 'cyberpunk' | 'eink' | 'gameboy' | 'starlight' | 'manga'
  | 'noir' | 'cozy' | 'aurora' | 'rpg' | 'pixelchat' | 'pixelrpg' | 'snek';
export type FontFamily =
  /** Follow the theme's signature font (terminal→mono, book→serif, ...). */
  | 'theme'
  | 'sans' | 'serif' | 'mono' | 'handwriting' | 'typewriter' | 'dyslexic'
  | 'rounded' | 'slab' | 'medieval' | 'comic'
  /** A user-uploaded font, keyed by its id (see useFontStore). */
  | `custom:${string}`;
/** Accent override; '' means use the theme's own accent. */
export type AccentColor =
  | '' | 'blue' | 'violet' | 'rose' | 'emerald' | 'amber'
  | 'sky' | 'crimson' | 'teal' | 'gold' | 'magenta';
export type AnimationStyle =
  | 'typewriter' | 'smooth' | 'magic' | 'fade'
  // v2 reveals: blur-in, ink-bleed, RGB-split glitch, fade-up rise, and a
  // terminal "decrypt" caret that cycles glyphs ahead of the text.
  | 'blur' | 'ink' | 'glitch' | 'rise' | 'decrypt';
export type TtsEngine = 'browser' | 'kokoro';
/** Built-in Web Audio soundscapes (no assets, synthesized live). */
export type AmbientSound = 'rain' | 'wind' | 'fire' | 'waves' | 'drone';
export type DialogueStyle = 'normal' | 'italic' | 'bold' | 'bold-italic';
export type DialogueAnimation = 'none' | 'zoom' | 'pulse' | 'wave' | 'glow' | 'rise';
export type OocHandling = 'show' | 'dim' | 'hide';

export type RuleTarget = 'all' | 'ai' | 'user';

export interface AutoFormatRule {
  id: string;
  /** Human-readable name shown in the rule list. */
  label?: string;
  pattern: string;
  /** Regex flags, e.g. "gi". Defaults to "g". */
  flags?: string;
  replacement: string;
  /** Which message roles the rule applies to. Defaults to 'all'. */
  appliesTo?: RuleTarget;
  enabled: boolean;
}

export type StatDisplay = 'chips' | 'table' | 'hide';

export interface StatRule {
  id: string;
  label?: string;
  /** Pattern with `{key}` and `{value}` placeholders, e.g. "[{key}] {value}". */
  pattern: string;
  display: StatDisplay;
  enabled: boolean;
}

/** Reader-side override applied to a single message (never mutates source). */
export interface MessageOverride {
  messageId: string;
  kind: 'rewrite' | 'format';
  content: string;
  source: 'user' | 'ai' | 'template';
  note?: string;
  createdAt: number;
}

/** Pinnable table the reader keeps alongside a story. */
export interface Sheet {
  id: string;
  title: string;
  columns: string[];
  rows: Record<string, string>[];
  createdAt: number;
  updatedAt: number;
}

/**
 * A named, saved AI-context selection: specific messages plus, optionally,
 * the full set of alternate versions (branchlines/swipes) for chosen messages.
 * Persisted per story so the reader can reuse a curated context across sessions.
 */
export interface ContextZone {
  id: string;
  name: string;
  /** Messages whose current content is included, kept in reading order at build time. */
  messageIds: string[];
  /** Messages whose ALL alternate versions (swipes) are included. */
  branchlineIds: string[];
  /** Attached branch timelines included WHOLE (their divergent tail). */
  timelineIds?: string[];
  /** Individual messages picked out of branch timeline tails. */
  timelineMessageIds?: string[];
  createdAt: number;
  updatedAt: number;
}

/**
 * One turn in an assistant conversation. Assistant turns can carry several
 * alternate generations (swipes); the reader cycles between them and can
 * regenerate for more. User turns always hold exactly one variant.
 */
export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  /** Alternate generations for this turn (>=1). */
  variants: string[];
  /** Index of the variant currently shown. */
  activeVariant: number;
  createdAt: number;
  /** Context descriptor captured at send time, for display (e.g. "Up to here"). */
  scopeLabel?: string;
  /** When set, this turn is a Lens rewrite of that message; variants are drafts of it. */
  lensTargetId?: string;
  /** The revision instruction that produced a Lens turn (so it can be regenerated). */
  lensInstruction?: string;
  /** When set, this turn was produced by a cowriting preset; the resolved recipe
   *  is kept so it can be regenerated (swiped) with the same placement. */
  cowriteSpec?: CowriteRunSpec;
}

/**
 * What a cowriting preset does with the branches it is handed. Governs the
 * wording of the candidate block and a small system nudge — 'compare' ranks
 * them, 'blend' fuses them, 'freeform' just presents them for the instruction.
 */
export type CowriteKind = 'compare' | 'blend' | 'freeform';

/**
 * A reusable cowriting recipe. It is position-independent — it describes a
 * *policy* (how much prior context to ground on, whether to anchor an earlier
 * passage, what to ask), not fixed message ids. The concrete branches and
 * anchors are chosen at send time and captured in a CowriteRunSpec.
 *
 * Placement follows the "lost in the middle" rule: the reference grounds the
 * model in the system block, the candidate branches ride the high-attention
 * tail inside the final user turn, and the instruction is the very last line.
 */
export interface CowritePreset {
  id: string;
  name: string;
  /** Built-ins ship in code and can't be deleted (only duplicated to customize). */
  builtIn?: boolean;
  kind: CowriteKind;
  /** How many messages before the current one to include as grounding (0 = none). */
  referenceLastN: number;
  /** Whether this preset expects an anchored earlier passage, picked at send time. */
  useAnchor: boolean;
  /** The ask, placed dead last in the payload. */
  instruction: string;
  createdAt: number;
  updatedAt: number;
}

/** One hand-picked candidate branch: a message and which of its versions to include. */
export interface CowriteCandidate {
  messageId: string;
  /** Specific swipe indices to include; empty = all versions of that message. */
  versions: number[];
}

/**
 * The resolved, position-locked inputs to a single cowrite generation, stored
 * on the produced turn so "regenerate" rebuilds the identical payload. Content
 * is resolved live from these ids at build time (so Lens edits stay reflected).
 */
export interface CowriteRunSpec {
  presetName: string;
  kind: CowriteKind;
  /** Reference message ids (anchors + the last-N window), in reading order. */
  referenceIds: string[];
  candidates: CowriteCandidate[];
  instruction: string;
}

/** A saved, named conversation branch with the reading assistant, scoped to a story. */
export interface ChatThread {
  id: string;
  name: string;
  turns: ChatTurn[];
  createdAt: number;
  updatedAt: number;
}

/**
 * Advanced generation controls for the AI assistant. Kept behind a collapsed
 * "Advanced" section — most readers never touch it. `null` on a sampler means
 * "omit it and let the server decide". Extended samplers (top_k / min_p /
 * repetition_penalty) are non-standard: only sent when `extendedSamplers` is on,
 * since strict OpenAI-compatible endpoints reject unknown fields.
 */
export interface AiAdvancedConfig {
  /** Stream tokens as they arrive rather than waiting for the whole reply. */
  streaming: boolean;
  /** Extra system instruction prepended ahead of the story context. */
  systemPrompt: string;
  /** Optional wrapper for the assembled context body; `{{content}}` is substituted. */
  contextTemplate: string;
  /** Target context budget in tokens (0 = only the hard safety ceiling applies). */
  contextSize: number;
  /** Max output tokens (0 = omit, server default). */
  maxTokens: number;
  /** Send top_k / min_p / repetition_penalty (for local backends that accept them). */
  extendedSamplers: boolean;
  temperature: number | null;
  topP: number | null;
  topK: number | null;
  minP: number | null;
  repetitionPenalty: number | null;
  frequencyPenalty: number | null;
  presencePenalty: number | null;
}

/** Per-word streaming text effect, independent of the block reveal animation. */
export type StreamEffect = 'none' | 'fade' | 'blur' | 'ink' | 'glitch' | 'rise';

/** How strongly expressive typography + cinematic pacing are applied. */
export type ExpressiveIntensity = 'subtle' | 'expressive' | 'cinematic';

/* ------------------------------------------------------------------ */
/* Scene Director — cached per-passage AI scene reading (immersion).    */
/* See docs/SCENE_DIRECTOR.md. Non-destructive: annotates, never edits. */
/* ------------------------------------------------------------------ */

export type Mood =
  | 'tense' | 'tender' | 'ominous' | 'joyful' | 'melancholy'
  | 'action' | 'eerie' | 'awe' | 'romantic' | 'neutral';

/** An emphasis span the Director judged worth performing (verbatim substring).
 *  'sfx' is a reader-authored sound-effect mark (visual cue for the span). */
/**
 * How a span is DRESSED.
 *
 * The first four are vocal — how the words sound in the reader's head, which is
 * why shout and whisper follow the expressive-text setting. The last three are
 * typographic: emphasis a printed page could carry, so they follow scene
 * emphasis alone. `color` names one of HIGHLIGHT_COLORS; anything else (or
 * nothing) falls back to the theme accent rather than being dropped, so an
 * invented colour name still produces a mark.
 */
export type SceneEmphasisKind =
  'whisper' | 'shout' | 'beat' | 'sfx' | 'color' | 'underline' | 'strike';

export interface SceneEmphasis {
  text: string;
  kind: SceneEmphasisKind;
  /** For kind 'color' — a HIGHLIGHT_COLORS key. Absent = the theme accent. */
  color?: string;
}

/**
 * How a span should be PERFORMED as it streams in — the Director's text
 * manipulation track. `slow`/`rush` bend the reveal rate, `stagger`/`drop` beat
 * between words, `hold` pauses before the span lands, and `swell`/`tremble`/
 * `fade` add a reveal-synced typographic treatment on top.
 */
export type ScenePerformKind =
  | 'slow' | 'rush' | 'stagger' | 'hold' | 'swell' | 'tremble' | 'drop' | 'fade'
  | 'cut' | 'unwrite';

/** One performance direction over a verbatim substring of the passage. */
export interface ScenePerformCue {
  text: string;
  kind: ScenePerformKind;
  /** 0.25..1.5 — how hard to lean on it. Defaults to 1. */
  strength?: number;
}

/**
 * The Director's cached read of one passage. Tiny (~200 bytes) and keyed by
 * message id per story. `hash` is the fingerprint of the content it was built
 * from — when the passage is edited/swiped the hash changes and the descriptor
 * is treated as stale (re-enriched or dropped).
 */
export interface SceneDescriptor {
  messageId: string;
  hash: string;
  /** Which generation of the Director produced this (see DESCRIPTOR_VERSION).
   *  Absent = version 1, from a build before the performance/weather tracks. */
  v?: number;
  mood: Mood;
  /** 0..1 — drives pacing lean + (later) score intensity. */
  tension: number;
  location?: string;
  timeOfDay?: 'dawn' | 'day' | 'dusk' | 'night' | 'unknown';
  /** Dominant speaker + their emotion, for expressive TTS. */
  speaker?: { name: string; emotion: string };
  /** AI-attributed quoted lines: who ACTUALLY speaks each (the enrichment's read,
   *  preferred over the runtime heuristic for bubbles + multi-voice TTS). `text`
   *  is a verbatim quoted substring (no surrounding quote marks). */
  dialogue?: { text: string; speaker: string }[];
  emphasis?: SceneEmphasis[];
  /** How to PERFORM chosen spans as they stream in — reveal pacing + kinetic
   *  treatment, synced to the reveal (see utils/scenePerform.ts). */
  perform?: ScenePerformCue[];
  /** Particle weather the prose clearly shows (fog, snowfall, floating ash…). */
  fx?: 'smoke' | 'fog' | 'stars' | 'sparkles' | 'rain' | 'embers' | 'snow' | 'petals'
  | 'ash' | 'dust' | 'leaves' | 'fireflies' | 'bubbles' | 'sand' | 'steam' | 'pollen';
  /** 0..1 — how hard it's coming down (a thin haze vs. a whiteout). */
  fxLevel?: number;
  /**
   * The passage's signature framing for the VN camera — the compact form of a
   * "scene builder". One word the Director may emit to override the heuristic
   * shot: an intimate `close`, a sweeping `wide`, or an `establishing` open.
   */
  shot?: 'establishing' | 'close' | 'wide';
  /**
   * A screen-level special effect for a charged beat — the compact form of
   * Fablekin's `vfx:trigger`. Momentary punches (`flash`, `shake`, `glitch`)
   * fire once; washes (`vignette`, `desaturate`, `bloom`) hold across the beat.
   * The reader also derives one heuristically from mood+tension when unset.
   */
  vfx?: 'flash' | 'shake' | 'vignette' | 'desaturate' | 'glitch' | 'bloom';
  createdAt: number;
}

/**
 * Sandbox mode — an AI-authored per-message *treatment*. The model emits only
 * presentation (CSS, and optionally an HTML skeleton with `{{speaker}}`/`{{body}}`
 * placeholders); Aura injects the verbatim source text into the slots, so the
 * words are never touched. Cached per (story, message). See SANDBOX_PLAN.md.
 */
export interface SandboxTreatment {
  /** AI-authored CSS, sanitized (no `<script>`, no `@import`, no url() network). */
  css: string;
  /** Optional skeleton that replaces the card's inner markup; must slot {{body}}. */
  skeleton?: string;
  createdAt: number;
}

/** How wide a Style Config reaches. */
export type SandboxScope = 'message' | 'chain' | 'chat';
/** `theme` restyles the message cards; `shell` is a self-contained view. */
export type SandboxKind = 'theme' | 'shell';
/** Shell layout: one beat at a time (slideshow/doors) or all stacked (scroll). */
export type ShellMode = 'slideshow' | 'scroll';
/** Interactive controls Aura injects into a shell's own control bar. */
export type ShellControl = 'playpause' | 'prev' | 'next' | 'restart' | 'text' | 'fx';

/**
 * Sandbox Studio — a named, saveable, toggleable AI-authored presentation. A
 * `theme` dresses the message cards at some scope; a `shell` takes over the
 * whole chat as its own view (slideshow, walk-through-doors, ASCII dungeon)
 * with interactive widgets that talk back to the app over an allowlisted intent
 * bus. The model authors only presentation — Aura slots the verbatim words —
 * so the chat still works no matter how wild the design. See SANDBOX_PLAN.md.
 */
export interface StyleConfig {
  id: string;
  name: string;
  scope: SandboxScope;
  kind: SandboxKind;
  /** The direction that produced it — shown in the manager, reused on restyle. */
  intent: string;
  /** Sanitized AI CSS. */
  css: string;
  /** theme: the card's inner markup; shell: the whole-view skeleton. */
  skeleton?: string;
  /** shell only — slideshow vs scroll. */
  mode?: ShellMode;
  /** shell only — an optional title-screen line (styled by css). */
  title?: string;
  /** shell only — which controls Aura puts in the always-present bar. */
  controls?: ShellControl[];
  createdAt: number;
  updatedAt: number;
}

/** Which saved config is active at each scope, per story. */
export interface SandboxActive {
  /** Config id for the whole chat. */
  chat?: string;
  /** chainId → config id. */
  chains?: Record<string, string>;
  /** messageId → config id. */
  messages?: Record<string, string>;
}

/** A transient on-screen effect a cue can fire (all CSS-only, motion-gated). */
export type FxKind = 'shake' | 'zoom' | 'flash' | 'pulse' | 'glitch' | 'rumble' | 'fade';
/** A procedural, asset-free sound a cue can play (synthesised in WebAudio). */
export type SoundKind = 'clink' | 'boom' | 'whoosh' | 'chime' | 'heartbeat' | 'thud' | 'shimmer';
/** A generated-audio library category (see aura-audio/ service + manifest). */
export type AudioCategory = 'sfx' | 'ambience' | 'music';
/** How freely anchor-triggered SFX fire while reading (see utils/sfxPlanner). */
export type SfxLevel = 'off' | 'light' | 'medium' | 'immersive';

/**
 * A directed beat *inside a single message* — the AI director's scene layer.
 * Anchored to a short VERBATIM phrase from the message text; Aura resolves the
 * anchor to a character offset and fires the cue just after those words are
 * revealed while streaming. The words are never touched — we search for the
 * offset, we never rewrite — so source stays sacred, in time as well as space.
 */
export interface SceneCue {
  id: string;
  /** A short verbatim substring from the message; the cue fires as it's read. */
  anchor: string;
  kind: 'fx' | 'audio' | 'theme';
  /** fx cue — a transient animation on the current card/frame. */
  fx?: FxKind;
  /** fx cue — how long the animation runs (ms); defaults per-effect. */
  ms?: number;
  /** audio cue — which procedural sound to play. */
  sound?: SoundKind;
  /** audio cue — a generated library asset to play instead of a procedural sound
   *  (id from the aura-audio manifest). Overrides `sound` when present. */
  assetId?: string;
  /** audio cue — which library category the asset is (for playback + labelling). */
  assetCategory?: AudioCategory;
  /** audio cue — loop the asset as a bed (ambience/music) until the scene changes. */
  loop?: boolean;
  /** theme cue — swaps the whole presentation for the rest of the beat (sanitized CSS). */
  css?: string;
  /** theme cue — optional replacement skeleton ({{speaker}}/{{body}}). */
  skeleton?: string;
  /** theme cue — retime the text reveal from here ("time slows" / a rush). */
  pace?: 'slow' | 'normal' | 'fast';
  /** Human label for the cue list. */
  label?: string;
}

export type PinFormat = 'html' | 'markdown';

/**
 * A visual the AI wrote inside the chat (HTML chart, stat table, code
 * block…) that the reader captured to keep beside the text. Docked pins
 * live in the right margin on wide windows; `inContext` feeds the pin
 * back to the AI as reference material.
 */
/** One saved state of a pin's content — the original plus any AI/manual edits. */
export interface PinVersion {
  content: string;
  /** How this version was produced. */
  source: 'original' | 'ai' | 'manual';
  /** The instruction given to the AI, when source === 'ai'. */
  instruction?: string;
  createdAt: number;
}

export interface Pin {
  id: string;
  title: string;
  format: PinFormat;
  /** The currently-shown content — always mirrors `versions[activeVersion]`
   *  when a version history exists (so rendering / AI context need no change). */
  content: string;
  /** Message the visual was captured from, when known. */
  messageId?: string;
  /** Version history — absent until the pin is first updated (then length ≥ 2). */
  versions?: PinVersion[];
  /** Which version `content` currently reflects. */
  activeVersion?: number;
  inContext: boolean;
  docked: boolean;
  collapsed?: boolean;
  /** Locked pins can't be dragged; unlocking pops the card out to float. */
  locked?: boolean;
  /** Absolute float position (px). Once set, the pin floats free of the dock
   *  column and keeps this spot even after being re-locked. */
  x?: number;
  y?: number;
  createdAt: number;
}

/**
 * A named, swappable arrangement of pins ("saved view"). Pins live in one
 * shared pool per story; a set just records which pin ids are docked (shown
 * in the margin) and which are fed to the AI as context. Applying a set
 * re-applies those two flags across the pool — so a set also captures the
 * AI-context choices made with the Bot button. Non-destructive: deleting a
 * set never deletes pins, and a pin can belong to any number of sets.
 */
export interface PinSet {
  id: string;
  name: string;
  /** Pin ids shown in the dock while this set is active. */
  docked: string[];
  /** Pin ids sent to the AI as reference while this set is active. */
  inContext: string[];
  createdAt: number;
  updatedAt: number;
}

/** A reader note anchored to a specific passage (message + optional selected text). */
export interface Annotation {
  id: string;
  messageId: string;
  /** Optional selected passage the note is anchored to. */
  anchorText?: string;
  /** Start/end character offsets within the message content. */
  start?: number;
  end?: number;
  note: string;
  /** Who wrote this entry in the scoped thread; absent means the reader. */
  role?: 'user' | 'ai';
  createdAt: number;
  updatedAt: number;
}

export type RevealMode = 'character' | 'word';

export interface AppConfig {
  /** Workspace preset gating which tools/views show (persisted). */
  uiMode: UiMode;
  /**
   * The reader's last explicitly chosen reading mode — a named bundle that
   * writes the presentation keys (see `utils/readingModes.ts`). Stored as
   * INTENT: whether the config still matches it is derived, so touching an
   * advanced key shows as "Cinema · modified" instead of silently diverging.
   */
  readingMode: import('./utils/readingModes').ReadingMode;
  /**
   * Views pinned to the top bar, in the reader's own order. `null` = follow the
   * workspace preset's seed; any explicit list outranks the preset permanently.
   * Unpinned views are never gone — the overflow always lists all of them.
   */
  visibleViews: ViewMode[] | null;
  theme: Theme;
  accentColor: AccentColor;
  fontFamily: FontFamily;
  fontSize: number;
  textColor: string;
  bgColor: string;
  animationStyle: AnimationStyle;
  /** Per-word effect applied to text as it streams in. */
  streamEffect: StreamEffect;
  /** Kinetic typography — scale shouts, style scene breaks, emphasize key lines. */
  expressiveText: boolean;
  /** Adaptive reveal pacing — linger in dialogue, quicken action, beat on breaks. */
  cinematicPacing: boolean;
  /** Overall strength of the expressive typography + pacing. */
  expressiveIntensity: ExpressiveIntensity;
  /** Drop cap on the opening letter of each AI passage (prose flourish). */
  dropCaps: boolean;
  /** Let the Scene Director's mood/tension tint the reading surface. */
  sceneTheming: boolean;
  /** Let the Scene Director choose the ambient bed from scene mood/location. */
  sceneSoundscapes: boolean;
  /** Shape TTS rate/pitch by the passage's emotion + tension. */
  emotionalTts: boolean;
  /** Style individual whisper/shout words the Director flagged (off by default —
   *  it reads as scattered italics/bold, so it's opt-in). */
  sceneEmphasis: boolean;
  /** Let the Director bend the reveal itself — drag, rush, beat between words,
   *  and swell/tremble spans as they stream in. Falls back to a punctuation
   *  heuristic when a passage has no cues. */
  scenePerformance: boolean;
  /** When the Director rereads a page, also ask the AI to fix passages with
   *  broken quote/emphasis markup (lands as an undoable Lens override). */
  aiRepairFormatting: boolean;
  hideMetadata: boolean;
  /** Show images embedded in messages / attached to them. */
  showImages: boolean;
  /** In autofocus, keep the streaming line auto-zoomed and centered. */
  autofocusAutoZoom: boolean;
  /** In autofocus, light a focus band around the words as they stream in. */
  focusMagnifier: boolean;
  /** True once the reader has seen (or skipped) the first-run tour. */
  onboarded: boolean;
  /** Offer "Ask <character>" — an interview with the character, anchored to the
   *  beat you are reading. AI-only; nothing it produces is canon. */
  askCharacter: boolean;
  playbackSpeed: number;
  autoStream: boolean;
  autoFormat: boolean;
  autoFormatRules: AutoFormatRule[];
  /** Force-formatting stat rules (live render transform, not stored overrides). */
  statRules: StatRule[];
  /** Auto-format sub-features (only active while autoFormat is on). */
  paragraphSpacing: boolean;
  dialogueOwnLine: boolean;
  smartTypography: boolean;
  /** Style "quoted dialogue" distinctly from narration. */
  styleQuotes: boolean;
  /** Replace {{user}} / {{char}} with the story's names. */
  substituteNames: boolean;

  /** Autoreader */
  revealMode: RevealMode;
  /** Pause between messages while auto-streaming, in ms. */
  messagePause: number;
  /** In paginated layout, stop streaming at the end of each page. */
  pauseAtPageEnd: boolean;
  ttsEnabled: boolean;
  ttsVoiceURI: string;
  ttsRate: number;
  ttsPitch: number;
  /** Let the reading-speed slider also drive the TTS voice speed. */
  ttsFollowSpeed: boolean;
  /** Kokoro only: voice narration and each character's dialogue in distinct
   *  voices (segment + attribute per message) instead of one flat voice. */
  ttsMultiVoice: boolean;
  /** Speak ONLY the dialogue (quoted speech), in each speaker's voice, as the
   *  reveal reaches each line — narration stays silent. A conversational read
   *  instead of a narrator reading everything. Forces per-speaker casting. */
  ttsDialogueOnly: boolean;
  /** Which voice engine reads aloud: the OS Web Speech API or a Kokoro server. */
  ttsEngine: TtsEngine;
  /** Kokoro-FastAPI (OpenAI-compatible /v1/audio/speech) base URL. */
  kokoroBaseUrl: string;
  kokoroApiKey: string;
  /** Default Kokoro voice — used for narration and any unassigned speaker. */
  kokoroVoice: string;
  /** Kokoro voice for the reader's own persona (user messages). */
  kokoroUserVoice: string;
  /** Per-character Kokoro voice, keyed by the speaker's display name. */
  ttsVoiceByCharacter: Record<string, string>;
  /** Optional aura-audio generation service (SFX/ambience/music) base URL. */
  audioBaseUrl: string;

  /* --- Scene images (optional, off until an address is set) --------------- */
  /** Image backend base URL — ComfyUI's root, or an OpenAI-compatible host. */
  imageBaseUrl: string;
  imageApiKey: string;
  /** Which dialect of backend `imageBaseUrl` is. */
  imageAdapter: ImageAdapterId;
  /** OpenAI-compatible only: the model to ask for. */
  imageModel: string;
  /** ComfyUI only: the reader's workflow, saved in API format, as JSON text. */
  comfyWorkflow: string;
  /** ComfyUI only: node ids the reader pinned, overriding auto-detection. */
  comfyMapping: Partial<Record<'positive' | 'negative' | 'seed' | 'size' | 'reference', string>>;
  /** Which prompt dialect the AI writes in — see `utils/imagePresets.ts`. */
  imagePreset: string;
  /** Extra negative-prompt terms the reader always wants appended. */
  imageNegativeExtra: string;
  /**
   * Live Reaction — read with someone beside you (opt-in, needs the AI).
   *
   * A scout marks the moments in each passage this person would break in on;
   * the reveal crossing one of those moments is what makes them speak. Nothing
   * they say is canon. See `utils/liveReaction.ts`.
   */
  liveReaction: boolean;
  /** Who is watching with you — a cast name, or a visitor's. Empty = the lead. */
  liveReactor: string;
  /** How much of the passage they can see when they speak: only what you have
   *  uncovered (`upTo`, the frame) or the whole thing (`whole`, knowing). */
  liveReactionVisibility: 'upTo' | 'whole';
  /** Pause the reveal until they have finished speaking. Off by default — the
   *  reading should not stop for a companion unless the reader wants it to. */
  liveReactionFreeze: boolean;
  /** Reading over your shoulder, or a voice on a call. */
  liveReactionFrame: 'room' | 'phone';
  /** Play generated audio-library cues in the Scene Director (opt-in). */
  audioCuesEnabled: boolean;
  /** Offer to live-generate a scene bed when the library has no match (opt-in;
   *  otherwise the reader only ever REUSES existing clips). */
  audioLiveGen: boolean;
  /** Layer generated MUSIC over ambience on scenes that earn it (opt-in). */
  sceneMusic: boolean;
  /** Music layer level (0..1); sits under voice, over ambience via the mixer. */
  musicVolume: number;
  /** Anchor-triggered SFX permissiveness while reading (how freely it fires). */
  sfxPermissiveness: SfxLevel;
  /** Auto-assign distinct voices to unmapped side characters (dialogue casts itself). */
  autoCastVoices: boolean;

  /** Loop a quiet ambient bed while reading. */
  ambientEnabled: boolean;
  ambientVolume: number;
  /**
   * Ambient bed per theme, keyed by theme id. Value is either a built-in
   * soundscape (`builtin:rain`, `builtin:wind`…) or a custom audio URL.
   * Empty / missing means silence for that theme.
   */
  ambientByTheme: Record<string, string>;

  dialogueColor: string;
  dialogueStyle: DialogueStyle;
  dialogueAnimation: DialogueAnimation;

  /** Max content column width in px (0 = use the theme's default width). */
  contentWidth: number;
  /** What to do with out-of-character [OOC: ...] / (OOC: ...) asides. */
  oocHandling: OocHandling;
  /** Phone theme: show only dialogue, as received-text bubbles. */
  phoneDialogueOnly: boolean;
  /** Ambient theme effects (scanlines, particles, glows, animations). */
  themeEffects: boolean;
  /** Animate a living particle background suited to the theme (opt-in). */
  livingBackground: boolean;

  /** AI assistant (OpenAI-compatible endpoint). */
  aiBaseUrl: string;
  aiApiKey: string;
  aiModel: string;
  /** Advanced generation controls (behind a collapsed section in the AI panel). */
  aiAdvanced: AiAdvancedConfig;
}

export interface AppState extends AppConfig {
  // Library
  screen: Screen;
  library: StoryMeta[];
  libraryLoaded: boolean;
  currentStory: Story | null;

  // Playback data
  chains: Chain[];
  visibleMessages: Message[];
  streamingMessage: Message | null;
  streamedText: string;
  /** True once the reveal has committed the full passage — the view stops
   *  hiding the in-progress last word during the end-of-message hold. */
  revealComplete: boolean;
  currentChainIndex: number;
  currentMessageIndex: number;
  isStreaming: boolean;

  // View state
  viewMode: ViewMode;
  layoutMode: LayoutMode;
  searchQuery: string;
  isAutofocusMode: boolean;
  autofocusZoom: number;
  autofocusPanX: number;
  isHighlightMode: boolean;
  reverseStream: boolean;
  controlsMinimized: boolean;
  settingsOpen: boolean;

  /** TTS coordination (transient, not persisted). */
  ttsPending: boolean;
  awaitingAdvance: boolean;
  /** How far the voice has spoken the current message, 0..1 (1 = not gating).
   *  Drives the reveal so the text can't outrun the narration. */
  ttsProgress: number;

  /** Selected swipe/branch index per message id (transient). */
  swipeSelections: Record<string, number>;
  /** AI assistant modal open (transient). */
  aiOpen: boolean;
  /** Message id the reader asked to Lens-edit; opens the AI panel in edit mode (transient). */
  lensEditTarget: string | null;

  savedConfigs: Record<string, AppConfig>;

  // Library actions
  initLibrary: () => Promise<void>;
  /** Import stories, optionally with companion character cards to auto-map. */
  importFiles: (files: File[], cardFiles?: File[]) =>
    Promise<{ imported: number; errors: string[]; notes: string[] }>;
  /** Read a different timeline of the open story (null = the trunk). */
  setActiveTimeline: (timelineId: string | null) => void;
  /** Detach an attached branch from the open story (non-destructive to trunk). */
  removeTimeline: (timelineId: string) => void;
  /** Copy a timeline out into its own standalone library story. */
  snipTimelineToStory: (timelineId: string) => Promise<void>;
  openStory: (id: string) => Promise<void>;
  closeStory: () => void;
  deleteStoryById: (id: string) => Promise<void>;
  /** Rename a chat. Imports take their title from the card, which for many
   *  exports is a placeholder like "unused" — the reader needs a way out. */
  renameStory: (id: string, title: string) => Promise<void>;
  persistStoryState: () => void;

  // Playback actions
  setIsStreaming: (isStreaming: boolean) => void;
  setPlaybackSpeed: (speed: number) => void;
  advanceMessage: () => void;
  updateStreamedText: (text: string) => void;
  /** Commit the reveal. Pass the PROCESSED full text so the finished message
   *  keeps its formatting instead of flipping back to raw source. */
  finishCurrentMessage: (fullText?: string) => void;
  resetPlayback: () => void;
  restreamFromId: (id: string) => void;
  jumpToMessage: (id: string) => void;
  fastForward: () => void;
  nextPage: () => void;
  prevPage: () => void;

  // Chain actions
  reorderChains: (chains: Chain[]) => void;
  toggleStarChain: (chainId: string) => void;
  updateStarSettings: (chainId: string, settings: ChainStarSettings) => void;

  // Highlights
  addHighlight: (highlight: Highlight) => void;
  removeHighlight: (id: string) => void;

  // View / settings actions
  setViewMode: (mode: ViewMode) => void;
  setUiMode: (mode: UiMode) => void;
  /** Pick a reading mode — writes its presentation keys and records the intent. */
  setReadingMode: (mode: import('./utils/readingModes').ReadingMode) => void;
  /** Pin/unpin a view on the top bar (never removes it from the overflow). */
  toggleVisibleView: (view: ViewMode) => void;
  /** Reorder a pinned view one slot left/right. */
  moveVisibleView: (view: ViewMode, direction: -1 | 1) => void;
  /** Drop the reader's custom bar and follow the workspace preset again. */
  resetVisibleViews: () => void;
  setLayoutMode: (mode: LayoutMode) => void;
  setTheme: (theme: Theme) => void;
  setAccentColor: (accent: AccentColor) => void;
  setShowImages: (show: boolean) => void;
  setAutofocusAutoZoom: (on: boolean) => void;
  setFocusMagnifier: (on: boolean) => void;
  setAskCharacter: (on: boolean) => void;
  setOnboarded: (on: boolean) => void;
  setFontFamily: (font: FontFamily) => void;
  setFontSize: (size: number) => void;
  setTextColor: (color: string) => void;
  setBgColor: (color: string) => void;
  setAnimationStyle: (style: AnimationStyle) => void;
  setStreamEffect: (effect: StreamEffect) => void;
  setExpressiveText: (on: boolean) => void;
  setCinematicPacing: (on: boolean) => void;
  setExpressiveIntensity: (intensity: ExpressiveIntensity) => void;
  setDropCaps: (on: boolean) => void;
  setSceneTheming: (on: boolean) => void;
  setSceneSoundscapes: (on: boolean) => void;
  setEmotionalTts: (on: boolean) => void;
  setSceneEmphasis: (on: boolean) => void;
  setScenePerformance: (on: boolean) => void;
  setAiRepairFormatting: (on: boolean) => void;
  setHideMetadata: (hide: boolean) => void;
  setAutoStream: (autoStream: boolean) => void;
  setAutoFormat: (autoFormat: boolean) => void;
  setStyleQuotes: (styleQuotes: boolean) => void;
  setSubstituteNames: (substituteNames: boolean) => void;
  setParagraphSpacing: (paragraphSpacing: boolean) => void;
  setDialogueOwnLine: (dialogueOwnLine: boolean) => void;
  setSmartTypography: (smartTypography: boolean) => void;
  setRevealMode: (revealMode: RevealMode) => void;
  setMessagePause: (messagePause: number) => void;
  setPauseAtPageEnd: (pauseAtPageEnd: boolean) => void;
  setTtsEnabled: (ttsEnabled: boolean) => void;
  setTtsVoiceURI: (ttsVoiceURI: string) => void;
  setTtsRate: (ttsRate: number) => void;
  setTtsPitch: (ttsPitch: number) => void;
  setTtsFollowSpeed: (ttsFollowSpeed: boolean) => void;
  setTtsMultiVoice: (ttsMultiVoice: boolean) => void;
  setTtsDialogueOnly: (ttsDialogueOnly: boolean) => void;
  setTtsPending: (ttsPending: boolean) => void;
  setTtsProgress: (progress: number) => void;
  setTtsEngine: (ttsEngine: TtsEngine) => void;
  setKokoroBaseUrl: (kokoroBaseUrl: string) => void;
  setAudioBaseUrl: (audioBaseUrl: string) => void;
  setImageBaseUrl: (imageBaseUrl: string) => void;
  setImageApiKey: (imageApiKey: string) => void;
  setImageAdapter: (imageAdapter: ImageAdapterId) => void;
  setImageModel: (imageModel: string) => void;
  setComfyWorkflow: (comfyWorkflow: string) => void;
  setComfyMapping: (comfyMapping: AppConfig['comfyMapping']) => void;
  setImagePreset: (imagePreset: string) => void;
  setImageNegativeExtra: (imageNegativeExtra: string) => void;
  setLiveReaction: (liveReaction: boolean) => void;
  setLiveReactor: (liveReactor: string) => void;
  setLiveReactionVisibility: (v: 'upTo' | 'whole') => void;
  setLiveReactionFreeze: (on: boolean) => void;
  setLiveReactionFrame: (f: 'room' | 'phone') => void;
  /** Transient: the reveal is held while a companion finishes speaking. Never
   *  persisted — a reload must not leave the reader frozen. */
  reactionHold: boolean;
  setReactionHold: (on: boolean) => void;
  setAudioCuesEnabled: (audioCuesEnabled: boolean) => void;
  setAudioLiveGen: (audioLiveGen: boolean) => void;
  setSceneMusic: (sceneMusic: boolean) => void;
  setMusicVolume: (musicVolume: number) => void;
  setSfxPermissiveness: (sfxPermissiveness: SfxLevel) => void;
  /** Transient: a generated-library ambience bed is currently playing, so the
   *  procedural ambient stands down to avoid stacking two beds. Not persisted. */
  librarySoundscapeActive: boolean;
  setLibrarySoundscapeActive: (on: boolean) => void;
  /** Transient: the last few anchor-SFX that fired, for the scene-audio panel. */
  recentSfx: { id: string; label: string; at: number }[];
  pushRecentSfx: (e: { id: string; label: string }) => void;
  clearRecentSfx: () => void;
  /** Transient: a mid-message location the reader just crossed into (bridging),
   *  so the soundscape can switch beds before the next message. Null = follow
   *  the enriched scene location. */
  midSceneLocation: string | null;
  setMidSceneLocation: (loc: string | null) => void;
  setKokoroApiKey: (kokoroApiKey: string) => void;
  setKokoroVoice: (kokoroVoice: string) => void;
  setKokoroUserVoice: (kokoroUserVoice: string) => void;
  /** Assign (or clear, with '') a Kokoro voice for a named speaker. */
  setCharacterVoice: (name: string, voice: string) => void;
  setAutoCastVoices: (autoCastVoices: boolean) => void;
  setAmbientEnabled: (ambientEnabled: boolean) => void;
  setAmbientVolume: (ambientVolume: number) => void;
  /** Set (or clear, with '') the ambient bed for a theme id. */
  setThemeAmbient: (theme: string, value: string) => void;
  setAwaitingAdvance: (awaitingAdvance: boolean) => void;
  setSearchQuery: (query: string) => void;
  setIsAutofocusMode: (isAutofocusMode: boolean) => void;
  setAutofocusZoom: (zoom: number) => void;
  setAutofocusPanX: (panX: number) => void;
  setIsHighlightMode: (isHighlightMode: boolean) => void;
  setReverseStream: (reverse: boolean) => void;
  setControlsMinimized: (minimized: boolean) => void;
  setSettingsOpen: (open: boolean) => void;

  setDialogueColor: (color: string) => void;
  setDialogueStyle: (style: DialogueStyle) => void;
  setDialogueAnimation: (animation: DialogueAnimation) => void;
  setContentWidth: (px: number) => void;
  setOocHandling: (mode: OocHandling) => void;
  setPhoneDialogueOnly: (on: boolean) => void;
  setThemeEffects: (on: boolean) => void;
  setLivingBackground: (on: boolean) => void;
  /** Set a profile picture (data URL) for the character or the user, per story. */
  setStoryAvatar: (who: 'character' | 'user', dataUrl: string | undefined) => void;
  /** Set a profile picture for a specific character by name (group chats). */
  setCharacterAvatar: (name: string, dataUrl: string | undefined) => void;

  setAiBaseUrl: (url: string) => void;
  setAiApiKey: (key: string) => void;
  setAiModel: (model: string) => void;
  setAiOpen: (open: boolean) => void;
  /** Request a Lens edit for a message (opens the AI panel in edit mode); null clears it. */
  setLensEditTarget: (messageId: string | null) => void;
  /** Merge a partial patch into the advanced AI generation controls. */
  setAiAdvanced: (patch: Partial<AiAdvancedConfig>) => void;
  selectSwipe: (messageId: string, index: number) => void;
  updateHighlight: (id: string, updates: Partial<Highlight>) => void;

  addAutoFormatRule: (rule: AutoFormatRule) => void;
  updateAutoFormatRule: (id: string, updates: Partial<AutoFormatRule>) => void;
  removeAutoFormatRule: (id: string) => void;
  moveAutoFormatRule: (id: string, direction: -1 | 1) => void;
  importAutoFormatRules: (rules: AutoFormatRule[]) => void;

  addStatRule: (rule: StatRule) => void;
  updateStatRule: (id: string, updates: Partial<StatRule>) => void;
  removeStatRule: (id: string) => void;
  moveStatRule: (id: string, direction: -1 | 1) => void;

  saveConfig: (name: string) => void;
  loadConfig: (name: string) => void;
  deleteConfig: (name: string) => void;
}
