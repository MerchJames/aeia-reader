/**
 * Sandbox mode — the AI treatment layer (build order step 2 in SANDBOX_PLAN.md).
 *
 * The model authors ONLY presentation: a CSS block, and optionally an HTML
 * skeleton that slots `{{speaker}}` / `{{body}}`. It never emits story text —
 * Aura injects the verbatim words — so source stays sacred by construction.
 * Everything the model returns is sanitized before it can reach the iframe:
 * no scripts, no event handlers, no network (`@import`, remote `url(...)`).
 */

import { ChatMsg, isLocalBase, SamplerParams } from './aiClient';
// Was a private copy here, and a weaker one: it knew `<think>` but not
// `<thinking>`, and left an UNCLOSED block — a reply that ran out of room
// mid-thought — entirely in place, where the fence matcher would then read the
// model's deliberation as the answer.
import { askText, stripReasoning } from './aiCall';
import { composeScene, packetBlock, StylePacket } from './stylePacket';
import { ACCEPT_SCORE, REPAIRABLE_SCORE, repairNotes, scoreScene } from './sceneQuality';
import { FxKind, SceneCue, ShellControl, SoundKind } from '../types';

/**
 * Sampling for a DESIGN task, not a writing one.
 *
 * Every sandbox call used to run on `samplerParamsFrom(store.aiAdvanced)` — the
 * reader's chat settings, which default to all-null, which means the backend's
 * own creative-writing defaults. Two of those are actively wrong here:
 *
 *  - `repetition_penalty` on a stylesheet penalises the tokens CSS is MADE of:
 *    `px`, `rgba(`, `;`, `background`, every property name. The longer the sheet
 *    the more the sampler fights it, which is exactly why long scenes degraded.
 *  - `max_tokens` was omitted entirely, so a 25-declaration stylesheet — emitted
 *    on ONE LINE inside a JSON string — could be cut off mid-string. The reply
 *    then fails `JSON.parse`, `generateSceneCue` returns null, and the reader
 *    sees "nothing usable came back" with no clue that the design was fine and
 *    the budget was not. If the reader had set `maxTokens` for chat, EVERY scene
 *    truncated at that length.
 *
 * Temperature stays slightly above zero: greedy decoding collapses a design task
 * onto the most generic completion, which is the "AI slop" the build prompt
 * spends a paragraph arguing against. The reader's own explicit settings still
 * win — this only replaces the defaults nobody chose.
 */
export const designSamplers = (base: string): SamplerParams => ({
  temperature: 0.35, top_p: 0.9, frequency_penalty: 0, presence_penalty: 0,
  ...(isLocalBase(base) ? { min_p: 0.05, repetition_penalty: 1 } : {}),
});

/**
 * Room for a composed stylesheet. A 14-30 declaration sheet with gradients and
 * keyframes runs 700-1400 tokens once it is JSON-escaped onto one line; the
 * plan pass is a fraction of that.
 */
export const SCENE_TOKENS = 2200;
export const PLAN_TOKENS = 900;

export interface SandboxGenInput {
  name: string;
  isUser: boolean;
  content: string;
  /** From the cached SceneDescriptor, when available — sharpens the styling. */
  mood?: string;
  tension?: number;
}

export interface SandboxGenConfig {
  base: string;
  key: string;
  model: string;
  params?: SamplerParams;
}

export interface ParsedTreatment { css: string; skeleton?: string }

const SYSTEM = [
  'You are a CSS stylist for a finished-story reader called Sandbox. You dress ONE',
  'chat message so it reads like its own little designed document — a JRPG dialogue',
  'box, a torn letter, a terminal readout, text that flickers like a dying bulb.',
  '',
  'HARD RULES:',
  '1. Return ONLY presentation. NEVER write, repeat, paraphrase, or summarize the',
  '   story text — Aura injects it. Reproducing any of it is a failure.',
  '2. Output a fenced ```css block. You MAY also output a fenced ```html block that',
  '   replaces the card body — but it may contain ONLY tags and the placeholders',
  '   {{speaker}} and {{body}}. No real words. {{body}} is REQUIRED if you send html.',
  '3. No <script>, no on* handlers, no @import, no remote url() — data: URIs only.',
  '4. You are styling this fixed structure (unless you replace it via html):',
  '   <div class="card"><span class="who">…</span><div class="body">…paragraphs…</div></div>',
  '5. These CSS variables are available: --who (this speaker\'s color), --surface,',
  '   --bg, --text, --accent, --border. Use them so the card sits in the theme.',
  '6. Keep it readable: real contrast, no text smaller than 13px, respect',
  '   prefers-reduced-motion for anything that moves.',
].join('\n');

/** Build the chat messages for one treatment request. */
export const buildSandboxMessages = (input: SandboxGenInput): ChatMsg[] => {
  const mood = input.mood ? `\nMood: ${input.mood}${input.tension != null ? ` (tension ${input.tension.toFixed(2)})` : ''}` : '';
  const user = [
    `Speaker: ${input.name}${input.isUser ? ' (the reader / protagonist)' : ''}`,
    mood.trim(),
    'Message text (CONTEXT ONLY — do not reproduce any of it):',
    '"""',
    input.content.slice(0, 1600),
    '"""',
    '',
    'Return the ```css (and optional ```html skeleton) for this message.',
  ].filter(Boolean).join('\n');
  return [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }];
};


const fence = (raw: string, lang: string): string | null => {
  const re = new RegExp('```' + lang + '\\b[^\\n]*\\n([\\s\\S]*?)```', 'i');
  const m = raw.match(re);
  if (m) return m[1].trim();
  // Some models fence without a language tag — accept a lone block that looks
  // like the thing we asked for (css has `{…}`, html has a tag).
  const any = raw.match(/```[^\n]*\n([\s\S]*?)```/);
  if (any) {
    const body = any[1].trim();
    const looksCss = /\{[\s\S]*:[\s\S]*\}/.test(body) && !/<[a-z]/i.test(body);
    if ((lang === 'css' && looksCss) || (lang === 'html' && /<[a-z]/i.test(body))) return body;
  }
  return null;
};

/**
 * Neutralize AI CSS: no way out of the <style>, no network, no active content.
 * Whitespace-tolerant so `@ import` / `url ( http…)` can't slip through.
 */
export const sanitizeCss = (css: string): string =>
  css
    .replace(/<\/?[a-z][\s\S]*?>/gi, '')            // any HTML tag (can't close <style>)
    .replace(/@\s*import[^;]*;?/gi, '')              // no external stylesheets
    .replace(/expression\s*\(/gi, '(')               // legacy IE script-in-css
    .replace(/url\s*\(\s*(['"]?)\s*(?:https?:)?\/\/[^)]*\)/gi, 'none') // remote url()
    .replace(/javascript:/gi, '')
    .trim();

/** Neutralize an AI skeleton: strip active tags, handlers, and js: URIs. */
export const sanitizeSkeleton = (html: string): string =>
  html
    .replace(/<\s*(script|style|iframe|object|embed|link|meta|base)[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed|link|meta|base)\b[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '') // event handlers
    .replace(/(href|src)\s*=\s*(['"]?)\s*javascript:[^"'>\s]*\2/gi, '')
    .trim();

/**
 * Parse a model reply into a sanitized treatment, or null if it gave us nothing
 * usable (so the caller can keep the heuristic card — the fallback ladder).
 */
export const parseSandboxTreatment = (input: string): ParsedTreatment | null => {
  const raw = stripReasoning(input || '');
  if (!raw) return null;
  let css = fence(raw, 'css');
  // Some models skip the fence and just return CSS-looking text.
  if (!css && /\{[\s\S]*:[\s\S]*\}/.test(raw) && !/```/.test(raw)) css = raw;
  if (!css) return null;
  css = sanitizeCss(css);
  if (!css) return null;

  const rawSkeleton = fence(raw, 'html');
  let skeleton: string | undefined;
  if (rawSkeleton) {
    const clean = sanitizeSkeleton(rawSkeleton);
    // A skeleton is only valid if it still slots the body after sanitizing.
    if (clean.includes('{{body}}')) skeleton = clean;
  }
  return { css, skeleton };
};

/** Generate + sanitize one message's treatment. Null on empty/garbage reply. */
export const generateTreatment = async (
  input: SandboxGenInput, cfg: SandboxGenConfig, signal?: AbortSignal,
): Promise<ParsedTreatment | null> => {
  const reply = await askText(
    { base: cfg.base, key: cfg.key, model: cfg.model }, buildSandboxMessages(input),
    {
      label: 'Styling this message',
      params: designSamplers(cfg.base), reader: cfg.params, budget: SCENE_TOKENS, signal,
    },
  );
  return parseSandboxTreatment(reply);
};

/* ------------------------------------------------------------------ *
 * Sandbox Studio — directed configs (theme at any scope, or a shell). *
 * ------------------------------------------------------------------ */

export type StudioScope = 'message' | 'chain' | 'chat';
export type StudioKind = 'theme' | 'shell';
export type StudioMode = 'slideshow' | 'scroll';

export interface StudioInput {
  intent: string;
  scope: StudioScope;
  kind: StudioKind;
  /** A few sample lines from the scope, so the design fits the material. */
  samples: string[];
  /** Speaker names in play, for color/labelling. */
  cast: string[];
  /** Which interactive trinkets the reader wants embedded (shell/view only). */
  controls?: ShellControl[];
  /** When editing: the current CSS + the change to apply (regenerate in place). */
  priorCss?: string;
  tweak?: string;
}

export interface ParsedConfig {
  css: string;
  skeleton?: string;
  mode?: StudioMode;
  title?: string;
}

const THEME_SYSTEM = [
  'You are a CSS stylist for a finished-story reader called Sandbox. You are',
  'designing a REUSABLE theme applied to many message cards at once.',
  '',
  'HARD RULES:',
  '1. Return ONLY presentation. NEVER write, repeat, or paraphrase story text.',
  '2. Output a fenced ```css block styling this fixed card:',
  '   <div class="card"><span class="who">…</span><div class="body">…</div></div>',
  '   You MAY also output a ```html block that replaces the card inner using ONLY',
  '   tags + {{speaker}} / {{body}} ({{body}} required). No real words.',
  '3. No <script>, no on* handlers, no @import, no remote url() — data: only.',
  '4. CSS vars available: --who (speaker color), --surface, --bg, --text, --accent,',
  '   --border. Keep text ≥13px and readable; respect prefers-reduced-motion.',
].join('\n');

const SHELL_SYSTEM = [
  'You are a view designer for Sandbox. Design a FULL-VIEWPORT frame that presents',
  'ONE message of a finished chat at a time — a JRPG dialogue box, a terminal, a',
  'walk-through-door, an ASCII dungeon panel. The reader advances message-by-message',
  "with Aura's own playback controls; you may ALSO embed in-world trinkets (a light",
  'switch, a hamster wheel) that drive playback — see the trinkets note if present.',
  '',
  'Return a ```css block, and optionally a ```html block. HARD RULES:',
  '1. NEVER write, repeat, or paraphrase story text — Aura injects it.',
  '2. Style the body as the full-screen backdrop and this fixed structure as the',
  '   centrepiece: <div class="card"><span class="who">…</span><div class="body">…</div></div>.',
  '   Aura fills it and STREAMS the words into .body as they arrive, so never hide',
  '   .body or set it to display:none.',
  '3. If you send ```html it REPLACES the card inner using ONLY tags + {{speaker}} /',
  '   {{body}} ({{body}} required) — no real words.',
  '4. The frame fills the viewport (100vh); make it look composed on screen, not a',
  '   long scroll. Put ambient/animated decoration in elements with class "aura-fx".',
  '5. Optional: emit one line "[TITLE: your title]" and reference it as {{title}}.',
  '6. No <script>, no on* handlers, no @import, no remote url() — data: only. CSS',
  '   vars available: --who (speaker colour), --surface, --bg, --text, --accent, --border.',
].join('\n');

/** How each requested trinket must be wired — Aura only honours these data-act
 *  hooks, and the click is handled over the allowlisted intent bus. */
const CONTROL_HINTS: Record<ShellControl, string> = {
  playpause: 'a play/pause trinket carrying data-act="toggle-playback"',
  prev: 'a "previous" trinket carrying data-act="prev"',
  next: 'a "next" trinket carrying data-act="next"',
  restart: 'a "restart" trinket carrying data-act="restart"',
  text: 'a text-visibility switch carrying data-act="toggle-text"',
  fx: 'a flourish trinket carrying data-act="pulse" (a harmless visual pulse)',
};

/** Build the chat messages for a Studio generation. */
export const buildStudioMessages = (input: StudioInput): ChatMsg[] => {
  const system = input.kind === 'shell' ? SHELL_SYSTEM : THEME_SYSTEM;
  const cast = input.cast.length ? `Cast: ${input.cast.slice(0, 8).join(', ')}` : '';
  const samples = input.samples.length
    ? ['Sample lines (CONTEXT ONLY — never reproduce them):', '"""', input.samples.slice(0, 6).join('\n---\n').slice(0, 1800), '"""'].join('\n')
    : '';
  const editing = input.tweak
    ? ['You are REVISING an existing design. Apply this change and return the FULL updated blocks:',
       `Change: ${input.tweak.trim()}`, 'Current CSS:', '"""', (input.priorCss ?? '').slice(0, 4000), '"""'].join('\n')
    : '';
  const trinkets = input.kind === 'shell' && input.controls?.length
    ? ['Embed these interactive trinkets INTO the frame (style them to fit the world;',
       'each must carry exactly its data-act hook and nothing else drives playback):',
       ...input.controls
         .filter((c): c is ShellControl => c in CONTROL_HINTS)
         .map(c => `- ${CONTROL_HINTS[c]}`)].join('\n')
    : '';
  const user = [
    `Direction: ${input.intent.trim() || 'surprise me — make it immersive'}`,
    `Applies to: the ${input.scope}.`,
    cast, samples, trinkets, editing,
    input.kind === 'shell'
      ? 'Return the ```css (and optional ```html frame that slots {{speaker}} / {{body}}).'
      : 'Return the ```css (and optional ```html card skeleton).',
  ].filter(Boolean).join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
};

/** Parse a Studio reply into a sanitized config, or null if unusable. */
export const parseStudioConfig = (input: string, kind: StudioKind): ParsedConfig | null => {
  const raw = stripReasoning(input || '');
  if (!raw) return null;
  let css = fence(raw, 'css');
  if (!css && /\{[\s\S]*:[\s\S]*\}/.test(raw) && !/```/.test(raw)) css = raw;
  if (!css) return null;
  css = sanitizeCss(css);
  if (!css) return null;

  // Theme and view (shell) share the single-message contract: css + an optional
  // skeleton that must still slot {{body}} after sanitizing. A view just renders
  // full-viewport, one message at a time (Aura's playback advances it).
  const html = fence(raw, 'html');
  let skeleton: string | undefined;
  if (html) { const c = sanitizeSkeleton(html); if (c.includes('{{body}}')) skeleton = c; }
  const title = kind === 'shell' ? raw.match(/\[TITLE:\s*([^\]]+)\]/i)?.[1]?.trim() : undefined;
  return { css, skeleton, title };
};

/** Generate + sanitize a Studio config. Null on empty/garbage reply. */
export const generateStudioConfig = async (
  input: StudioInput, cfg: SandboxGenConfig, signal?: AbortSignal,
): Promise<ParsedConfig | null> => {
  // Same design regime as the director: a Studio theme is a stylesheet too, and
  // it truncated on an unbudgeted max_tokens for exactly the same reason.
  const reply = await askText(
    { base: cfg.base, key: cfg.key, model: cfg.model }, buildStudioMessages(input),
    {
      label: 'Designing the look',
      params: designSamplers(cfg.base), reader: cfg.params, budget: SCENE_TOKENS, signal,
    },
  );
  return parseStudioConfig(reply, input.kind);
};

/* ------------------------------------------------------------------ *
 * Scene director — cue tracks fired *inside* one message as it reads. *
 * ------------------------------------------------------------------ */

const FX_KINDS: FxKind[] = ['shake', 'zoom', 'flash', 'pulse', 'glitch', 'rumble', 'fade'];
const SOUND_KINDS: SoundKind[] = ['clink', 'boom', 'whoosh', 'chime', 'heartbeat', 'thud', 'shimmer'];

export interface CueGenInput {
  name: string;
  content: string;
  /** From the cached SceneDescriptor, when available — sharpens the direction. */
  mood?: string;
  tension?: number;
  /** Reader's own standing direction — a style/vibe to steer every beat. */
  guidance?: string;
  /** The guidance RESOLVED into concrete values (see utils/stylePacket). When
   *  present it supersedes the raw guidance line: it says the same thing in hex
   *  and font stacks instead of adjectives, and it says it identically on every
   *  beat, which is what makes a story look like one story. */
  packet?: StylePacket;
  /** Other named characters in play — so the director can tell WHO speaks each
   *  quoted line, even when it's an NPC the author is voicing or a reported line. */
  cast?: string[];
  /** Compact palette of already-generated audio assets the director may REUSE
   *  by id (adaptive soundscapes) — a sustained bed carried across scenes for
   *  continuity, rather than regenerating a near-duplicate every beat. */
  audioLibrary?: AudioPaletteItem[];
}

/** One reusable audio asset offered to the planner. */
export interface AudioPaletteItem {
  id: string;
  category: string;
  tags?: string[];
  description?: string;
}

/**
 * The reader's direction, at the head of every prompt.
 *
 * A resolved packet wins: it carries the same intent as concrete values the
 * model cannot reinterpret, and it renders to identical bytes on every call.
 * The raw guidance line is the fallback for a story with no packet yet.
 */
const directionBlock = (input: { guidance?: string; packet?: StylePacket }): string =>
  input.packet ? packetBlock(input.packet)
    : input.guidance?.trim() ? `DIRECTOR'S STANDING GUIDANCE (highest priority — obey it): ${input.guidance.trim()}`
    : '';

/** The cast around this message, so quoted lines can be attributed by speaker. */
const castLine = (cast?: string[], speaker?: string): string => {
  const others = (cast ?? []).map(c => c.trim()).filter(c => c && c.toLowerCase() !== (speaker ?? '').toLowerCase());
  return others.length ? `Cast that may speak here (attribute each quote to its real speaker): ${[...new Set(others)].slice(0, 10).join(', ')}` : '';
};

/**
 * The reveal-edge principle, shared by both director passes. The reader's eye is
 * pinned to the newest character — the streaming point — so composition must
 * orient there, not treat the slice as a static block.
 */
const FOCAL_NOTE =
  'THE FOCAL POINT IS THE LIVE REVEAL EDGE. Words stream in one character at a '
  + "time; the reader's eye sits on the NEWEST letter, not the top of the block. "
  + 'Compose so the reveal point is the visual centre of gravity — the fresh text '
  + 'lands in a stable, lit focal zone and stays on-screen as it grows. Never design '
  + 'for a full paragraph appearing at once.';

/**
 * Speaker-attribution principle. One message often carries lines from several
 * mouths — an NPC the author voices, a quote-within-a-quote, a remembered line.
 * The director should hear WHO is speaking and treat each voice distinctly.
 */
const VOICE_NOTE =
  'LISTEN FOR WHO SPEAKS. A single message can contain dialogue from DIFFERENT '
  + 'characters — the speaker quoting an NPC, someone repeating another\'s words, a '
  + 'remembered line. Attribute each quoted line to its ACTUAL speaker from the prose '
  + '("said Kara", context, who is present), and treat a different speaker as a '
  + 'distinct voice (its own colour/placement/pacing) — never blanket the whole '
  + 'message in the author\'s identity.';

const CUE_SYSTEM = [
  'You are a SCENE DIRECTOR for a finished-story reader. Given ONE message, you',
  'STAGE it so it plays like a little film as the words stream in. You mark beats',
  'by anchoring to the text, and at each beat you can (a) fire a transient effect,',
  '(b) play a sound, or — the powerful one — (c) SWAP THE WHOLE PRESENTATION to a',
  'custom mini-scene that takes over the screen from that point. You never touch',
  'the words; you only decide WHEN things happen and WHAT the moment looks like.',
  '',
  'Think cinematically. Example beats for a passage: a tavern door creaks open →',
  'SWAP to a first-person view of a table facing a widening doorway, the words',
  'settling above it; then her eyes lock → PACE slows like time stopping and SWAP',
  'to a tight vignette tunnelling toward her eyes, the words rushing up a spire.',
  '',
  'Return ONE fenced ```json block: an array of 2–6 cue objects, in reading order.',
  'Each cue = {',
  '  "anchor": a SHORT verbatim phrase copied EXACTLY from the message (3–8 words),',
  '  "kind": "fx" | "audio" | "scene",',
  '  "fx":    one of ' + FX_KINDS.join(', ') + '  (for kind="fx", or to punch a scene entry),',
  '  "sound": one of ' + SOUND_KINDS.join(', ') + ' (for kind="audio"),',
  '  "css":   (kind="scene") a full-viewport CSS presentation, ALL ON ONE LINE,',
  '  "pace":  (optional) "slow" | "normal" | "fast" — retime the reveal from here,',
  '  "label": 2–4 words naming the beat',
  '}',
  '',
  'WRITING A SCENE (kind="scene"):',
  '- Style `body` as the full-screen backdrop and `.card` as the stage; the words',
  '  stream into `.body` (id aura-body) — never hide it or set display:none.',
  '- Use gradients, transforms, perspective, vignettes, and @keyframes to EVOKE',
  '  the moment (a doorway of light, a tunnel toward her eyes). These CSS vars are',
  '  available: --who --surface --bg --text --accent --border.',
  '- Put the whole stylesheet on ONE line (rules separated by ; and }), so it is a',
  '  valid JSON string. No real newlines inside the JSON.',
  '',
  'HARD RULES:',
  '1. "anchor" MUST be copied verbatim from the message — never paraphrase it. That',
  '   is the ONLY story text you may echo, and only to point at a position.',
  '2. fx/sound/pace values ONLY from the lists above. In css: no <script>, no',
  '   on* handlers, no @import, no remote url() — data: URIs only. No real words.',
  '3. Space the beats out; open on a scene early, and change it when the mood turns.',
  '4. Return ONLY the ```json block.',
].join('\n');

/** Build the chat messages for a cue-track request. */
export const buildCueMessages = (input: CueGenInput): ChatMsg[] => {
  const mood = input.mood ? `Mood: ${input.mood}${input.tension != null ? ` (tension ${input.tension.toFixed(2)})` : ''}` : '';
  const user = [
    `Speaker: ${input.name}`,
    mood,
    'Message (stage THIS; copy anchors from it exactly):',
    '"""',
    input.content.slice(0, 2400),
    '"""',
    '',
    'Direct it. Return the ```json cue array.',
  ].filter(Boolean).join('\n');
  return [{ role: 'system', content: CUE_SYSTEM }, { role: 'user', content: user }];
};

const rid = () => `cue-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const PACES = ['slow', 'normal', 'fast'];

/**
 * Turn one raw cue object into a sanitized, anchor-checked SceneCue, or null if
 * nothing usable survives. The anchor MUST occur in the real message text, and
 * fx/sound/pace come only from the allowlists — a cue can only ever point at
 * words that exist and fire effects we know. Shared by the one-shot track parser
 * and the per-beat builder.
 */
const cueFromItem = (it: any, hay: string): SceneCue | null => {
  if (!it || typeof it !== 'object') return null;
  const anchor = typeof it.anchor === 'string' ? it.anchor.trim() : '';
  if (anchor.length < 2 || !hay.includes(anchor.toLowerCase())) return null;
  const label = typeof it.label === 'string' ? it.label.slice(0, 40) : undefined;
  const css = typeof it.css === 'string' ? sanitizeCss(it.css) : '';
  if (it.kind === 'audio' && SOUND_KINDS.includes(it.sound)) {
    return { id: rid(), anchor, kind: 'audio', sound: it.sound, label };
  }
  if (it.kind === 'scene' || css) {
    // A scene swaps the whole presentation; it may also punch an entry fx and
    // retime the reveal. Dropped if nothing usable survives sanitising.
    if (!css) return null;
    let skeleton: string | undefined;
    if (typeof it.skeleton === 'string') { const c = sanitizeSkeleton(it.skeleton); if (c.includes('{{body}}')) skeleton = c; }
    return {
      id: rid(), anchor, kind: 'theme', css, skeleton, label,
      fx: FX_KINDS.includes(it.fx) ? it.fx : undefined,
      pace: PACES.includes(it.pace) ? it.pace : undefined,
    };
  }
  if (FX_KINDS.includes(it.fx)) return { id: rid(), anchor, kind: 'fx', fx: it.fx, label };
  return null;
};

/**
 * Parse a director reply into a sanitized, anchor-resolved cue track (the
 * one-shot path). Returns [] when nothing is usable.
 */
export const parseCueTrack = (input: string, content: string): SceneCue[] => {
  const raw = stripReasoning(input || '');
  const json = fence(raw, 'json') ?? (raw.trim().startsWith('[') ? raw.trim() : null);
  if (!json) return [];
  let arr: any;
  try { arr = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(arr)) return [];

  const hay = content.toLowerCase();
  const out: SceneCue[] = [];
  for (const it of arr) {
    const cue = cueFromItem(it, hay);
    if (cue) out.push(cue);
    if (out.length >= 8) break;
  }
  // Reading order by where each anchor first appears.
  return out.sort((a, b) => hay.indexOf(a.anchor.toLowerCase()) - hay.indexOf(b.anchor.toLowerCase()));
};

/* ---- Two-pass director: plan a shot list, then build each beat on its own ---- */

/** One proposed beat in the storyboard — the plan the reader approves. */
export interface ScenePlanItem {
  id: string;
  anchor: string;
  kind: 'scene' | 'fx' | 'audio';
  /** One line describing the look/feeling the built beat should deliver. */
  intent: string;
  /** For an audio beat: reuse this existing library asset by id (adaptive
   *  soundscape) instead of generating a fresh clip. Only set when the model
   *  picked an id that really exists in the offered palette. */
  assetId?: string;
  /** The exact text this shot displays (anchor → next shot). Set by the caller
   *  from the same coverage map the reader sees. A one-line hero and a full
   *  paragraph need opposite typography, so both the critic and the composed
   *  floor need to know which one this is. */
  slice?: string;
}

const PLAN_SYSTEM = [
  'You are a SCENE DIRECTOR — a director of photography for text. You stage how a',
  'single message plays as it streams. You do NOT build anything yet: you pitch a',
  'SHOT LIST the reader approves, then each shot is built on its own.',
  '',
  'HOW THE STAGE WORKS — this is the craft, use it:',
  '- Each "scene" beat OWNS ONLY ITS OWN SLICE of the text (from its anchor to the',
  '  next beat). You are NOT dumping the whole message on screen — you are cutting',
  '  it into shots. Decide the RHYTHM: a sweeping establishing shot for a paragraph,',
  '  then a hard cut that ISOLATES a single line and blows it up for impact.',
  '- You control emphasis, reveal, and time. Slow the reveal to a crawl on a turn',
  '  ("time stops"); punch a word; hold on one sentence enlarged and glowing.',
  '- Think in real cinema language: establishing shot, push-in, rack focus, cut to',
  "  black, match cut, close-up, silhouette, dolly, hard light. Don't be generic —",
  '  each beat should look and feel DISTINCT from the ones around it.',
  '',
  FOCAL_NOTE,
  '',
  VOICE_NOTE + ' When a new voice takes a line, that is a natural place to CUT to a',
  'new beat.',
  '',
  'Return ONE fenced ```json block: an array of 3–6 beats in reading order. Each:',
  '{',
  '  "anchor": a SHORT verbatim phrase copied EXACTLY from the message (3–8 words)',
  '            marking where this shot begins,',
  '  "kind": "scene" | "fx" | "audio"  (scene = a full custom shot with its own',
  '          look + typography + pacing; fx = a quick punch; audio = a sound),',
  '  "intent": TWO rich clauses — the LOOK, then the TEXT TREATMENT. Name the shot',
  '            type, the palette/light, and how the words behave (isolate one line',
  '            enlarged? slow crawl? tight column? rush upward?). Be specific and',
  '            evocative, e.g. "hard cut to a cold high-contrast close-up, warmth',
  '            drained to steel-blue; her single line held centre-screen, oversized',
  '            and breathing, the rest of the room gone".',
  '  "asset":  (optional, kind="audio" ONLY) an id copied EXACTLY from the AUDIO',
  '            LIBRARY below to REUSE that clip instead of making a new one.',
  '}',
  '',
  'AUDIO BEATS: for kind="audio", write the intent as a concrete SOUND to render —',
  'the source + texture, and whether it is a one-shot hit (a door slam, a blade ring)',
  'or a sustained bed (rain ambience, a low cello drone under the scene). Say which.',
  '',
  'ADAPTIVE SOUNDSCAPE — REUSE what exists: when an AUDIO LIBRARY is listed below and',
  'one of its clips already fits a beat, REUSE it: set "asset" to that exact id (still',
  'give a short intent). A sustained BED (ambience/music) should usually be REUSED and',
  'carried across scenes for continuity — only ask for a NEW sound (no "asset", just',
  'intent) when nothing in the library fits. Reserve fresh generation for one-shots or',
  'a genuinely new mood.',
  '',
  'RULES: anchors verbatim only (the sole story text you may echo); vary every beat;',
  'open on an establishing scene and CUT when the mood turns; return ONLY the ```json.',
].join('\n');

/** The reusable audio palette, formatted for the planner. Beds (ambience/music)
 *  first so continuity choices are the model's easiest reach. */
const libraryLine = (lib?: AudioPaletteItem[]): string => {
  if (!lib?.length) return '';
  const rank = (c: string) => (c === 'music' ? 0 : c === 'ambience' ? 1 : 2);
  const rows = [...lib]
    .sort((a, b) => rank(a.category) - rank(b.category))
    .slice(0, 40)
    .map(a => {
      const tail = a.tags?.length ? a.tags.slice(0, 6).join(', ') : (a.description ?? '').slice(0, 60);
      return `- ${a.id} [${a.category}]${tail ? ` — ${tail}` : ''}`;
    });
  return ['AUDIO LIBRARY (existing clips — REUSE by copying an id into "asset" for an audio beat):', ...rows].join('\n');
};

/** Build the messages that pitch a storyboard for one passage. */
export const buildPlanMessages = (input: CueGenInput): ChatMsg[] => {
  const mood = input.mood ? `Mood: ${input.mood}${input.tension != null ? ` (tension ${input.tension.toFixed(2)})` : ''}` : '';
  const user = [
    directionBlock(input),
    `Speaker: ${input.name}`, mood,
    castLine(input.cast, input.name),
    libraryLine(input.audioLibrary),
    'Message to stage (copy anchors from it exactly):',
    '"""', input.content.slice(0, 2400), '"""',
    '', 'Pitch the shot list. Return the ```json array.',
  ].filter(Boolean).join('\n');
  return [{ role: 'system', content: PLAN_SYSTEM }, { role: 'user', content: user }];
};

/**
 * Parse a shot-list reply, keeping only beats whose anchor really occurs. When a
 * palette of valid asset ids is supplied, an audio beat's "asset" is honoured
 * only if it names a real library clip (so the model can't invent an id).
 */
export const parseScenePlan = (
  input: string, content: string, validAssetIds?: Set<string>,
): ScenePlanItem[] => {
  const raw = stripReasoning(input || '');
  const json = fence(raw, 'json') ?? (raw.trim().startsWith('[') ? raw.trim() : null);
  if (!json) return [];
  let arr: any;
  try { arr = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const hay = content.toLowerCase();
  const out: ScenePlanItem[] = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const anchor = typeof it.anchor === 'string' ? it.anchor.trim() : '';
    if (anchor.length < 2 || !hay.includes(anchor.toLowerCase())) continue;
    const kind = ['scene', 'fx', 'audio'].includes(it.kind) ? it.kind : 'scene';
    const intent = typeof it.intent === 'string' ? it.intent.trim().slice(0, 200) : '';
    if (!intent) continue;
    const assetId = kind === 'audio' && typeof it.asset === 'string' && validAssetIds?.has(it.asset.trim())
      ? it.asset.trim() : undefined;
    out.push({ id: rid(), anchor, kind, intent, assetId });
    if (out.length >= 6) break;
  }
  return out.sort((a, b) => hay.indexOf(a.anchor.toLowerCase()) - hay.indexOf(b.anchor.toLowerCase()));
};

/** Generate the storyboard for a passage. [] on empty/garbage reply. */
export const generateScenePlan = async (
  input: CueGenInput, cfg: SandboxGenConfig, signal?: AbortSignal,
): Promise<ScenePlanItem[]> => {
  const reply = await askText(
    { base: cfg.base, key: cfg.key, model: cfg.model }, buildPlanMessages(input),
    {
      label: 'Storyboarding the passage',
      params: designSamplers(cfg.base), reader: cfg.params, budget: PLAN_TOKENS, signal,
    },
  );
  const validIds = input.audioLibrary?.length ? new Set(input.audioLibrary.map(a => a.id)) : undefined;
  return parseScenePlan(reply, input.content, validIds);
};

const BUILD_SYSTEM = [
  'You are a master CSS scene designer building ONE approved shot of a message. The',
  'reader picked WHERE it lands and WHAT it should do — you realise it, beautifully.',
  '',
  'READ THIS FIRST — you tend to converge on generic, "AI-slop" output: flat dark',
  'boxes, one centred paragraph, timid colour, no depth. DO NOT. Commit to ONE bold,',
  'specific aesthetic for this shot and make deliberate, unexpected, context-fit',
  'choices. Think like a title-sequence designer, not a default template.',
  '',
  'Return ONE fenced ```json object (no array): {',
  '  "kind": "scene" | "fx" | "audio",',
  '  "css":   (kind="scene") the full-viewport stylesheet, ALL ON ONE LINE,',
  '  "skeleton": (optional) tags + {{speaker}} / {{body}} — no real words,',
  '  "pace":  (optional) "slow" | "normal" | "fast" — retime the reveal here,',
  '  "fx":    one of ' + FX_KINDS.join(', ') + '  (kind="fx", or to punch a scene entry),',
  '  "sound": one of ' + SOUND_KINDS.join(', ') + ' (kind="audio")',
  '}',
  '',
  'THE STAGE — a FIXED, NON-SCROLLING viewport, roughly full-width × ONE screen tall.',
  '`body` is the backdrop; `.card` is the stage; the shot\'s text streams into `.body`',
  '(id aura-body) — never hide it. You get ONLY this shot\'s slice of text (often a',
  'line or two). EVERYTHING MUST FIT ON ONE SCREEN — no overflow, no clipping:',
  '- Size text so THIS slice fills the frame without spilling. A single-sentence hero',
  '  can be large — clamp(1.6rem, 4.5vw, 3.2rem) — but a multi-line slice must drop to',
  '  a readable size in a centred column (max-width ~40ch). Never assume one word.',
  '- HARD LIMITS so nothing escapes: never set a width/height in vw/vh above 100, no',
  '  fixed pixel widths wider than the screen, no position:fixed, no negative margins',
  '  that push content off-frame. Keep .body inside the visible frame — Aura auto-',
  '  scrolls it to the newest line, so leave it room to grow (avoid pinning it dead-',
  '  centre with no give). Prefer overflow-safe layout: flex/grid that wraps.',
  '',
  '  ' + FOCAL_NOTE,
  '',
  '  ' + VOICE_NOTE,
  '- Fonts CANNOT be downloaded (offline sandbox) — use expressive WEB-SAFE stacks',
  '  (Georgia, "Times New Roman", Palatino, ui-serif; "Courier New", ui-monospace;',
  '  Impact, Copperplate) and get character from WEIGHT EXTREMES (100/200 vs 800/900),',
  '  letter-spacing, text-transform, and big size jumps — not from a custom font.',
  '',
  'CRAFT (aim for ~14–30 rich declarations, not 3):',
  '- Colour: commit to a dominant colour + ONE sharp accent (via --accent/--who); no',
  '  timid evenly-grey palettes, no purple-on-white cliché.',
  '- Depth: layered radial + linear gradients for light/atmosphere; a ::before/::after',
  '  vignette or inset box-shadow; fog, haze, a shaft of light — never a flat fill.',
  '- Motion: ONE orchestrated entrance (staggered animation-delay reveals) plus a slow',
  '  ambient loop (drift/flicker/push-in) on BACKDROP layers, not on the words.',
  '- Framing: perspective()+rotateX for a floor/table view; a radial mask to tunnel',
  '  focus; place the stage low/high/off-centre. Make it feel shot by a camera.',
  '',
  'Whole stylesheet on ONE line (rules separated by ; and }) — valid JSON string, NO',
  'real newlines.',
  '',
  'RULES: no story text anywhere; keep text readable (real contrast, body ≥14px, hero',
  'may be big but must FIT); respect prefers-reduced-motion for big motion; no',
  '<script>/on*/@import/remote url() — data: URIs only. An inline SVG data URI MUST',
  'be percent-encoded (%3Csvg …%3E) — a raw one is stripped by the sanitiser and',
  'you lose the texture. Return ONLY the ```json.',
].join('\n');

/** Build the messages that realise one planned beat. */
export const buildSceneMessages = (input: CueGenInput, item: ScenePlanItem): ChatMsg[] => {
  const user = [
    directionBlock(input),
    castLine(input.cast, input.name),
    `Passage (context — do not reproduce it):`, '"""', input.content.slice(0, 2400), '"""',
    '', 'The approved beat to build:',
    `- lands at: "${item.anchor}"`,
    `- kind: ${item.kind}`,
    `- intent: ${item.intent}`,
    '', 'Build it. Return the ```json object.',
  ].filter(Boolean).join('\n');
  return [{ role: 'system', content: BUILD_SYSTEM }, { role: 'user', content: user }];
};

/**
 * Parse ONE build reply into a sanitized cue, stamping the plan's anchor on it.
 * Exported so the quality harness measures the exact parse the app uses — a
 * harness with its own parser measures the harness.
 */
export const parseSceneCue = (
  reply: string, item: ScenePlanItem, content: string,
): SceneCue | null => {
  const raw = stripReasoning(reply || '');
  const json = fence(raw, 'json') ?? (raw.trim().startsWith('{') ? raw.trim() : null);
  if (!json) return null;
  let obj: any;
  try { obj = JSON.parse(json); } catch { return null; }
  if (Array.isArray(obj)) obj = obj[0];
  if (!obj) return null;
  return cueFromItem({ ...obj, anchor: item.anchor, kind: obj?.kind ?? item.kind }, content.toLowerCase());
};

/** How a beat's cue was finally arrived at — surfaced in the modal. */
export type BuildOrigin = 'ai' | 'repaired' | 'composed';

export interface BuiltCue {
  cue: SceneCue;
  origin: BuildOrigin;
  /** The critic's score for the stylesheet that shipped (scene beats only). */
  score?: number;
}

/**
 * Build one planned beat into a finished cue — and then actually check it.
 *
 * The old version took one sample and shipped whatever came back as long as it
 * parsed. This runs the ladder:
 *
 *   1. Build. If it isn't a scene (fx/audio), it's done — nothing to score.
 *   2. Score the stylesheet against the packet. At or above ACCEPT, ship it.
 *   3. Otherwise hand the critic's own findings back as a repair — a correction,
 *      not a re-roll — and re-score. Keep whichever attempt scored higher.
 *   4. If the best is still below REPAIRABLE, compose the scene from the packet
 *      in pure TS. That is the floor, and it is why this stops being a gamble:
 *      the worst case is now a designed shot rather than an empty frame.
 *
 * With no packet there is nothing to grade against, so it behaves as before.
 */
export const generateSceneCue = async (
  input: CueGenInput, item: ScenePlanItem, cfg: SandboxGenConfig, signal?: AbortSignal,
): Promise<BuiltCue | null> => {
  const opts = {
    label: 'Building the shot',
    params: designSamplers(cfg.base), reader: cfg.params, budget: SCENE_TOKENS, signal,
  };
  const messages = buildSceneMessages(input, item);
  const sliceLen = (item.slice ?? input.content).length;

  const build = async (msgs: ChatMsg[]): Promise<SceneCue | null> =>
    parseSceneCue(
      await askText({ base: cfg.base, key: cfg.key, model: cfg.model }, msgs, opts),
      item, input.content,
    );

  const first = await build(messages);
  const packet = input.packet;

  // Nothing to grade: a point cue, or a story with no resolved packet.
  if (!packet) return first ? { cue: first, origin: 'ai' } : null;
  if (first && first.kind !== 'theme') return { cue: first, origin: 'ai' };

  const graded = first?.css ? { cue: first, score: scoreScene(first.css, packet, sliceLen) } : null;
  if (graded && graded.score.score >= ACCEPT_SCORE) {
    return { cue: graded.cue, origin: 'ai', score: graded.score.score };
  }

  // One targeted repair, quoting the exact measurements it missed.
  let best = graded;
  if (graded && !signal?.aborted) {
    const repaired = await build([
      ...messages,
      { role: 'assistant', content: '```json\n' + JSON.stringify({ kind: 'scene', css: graded.cue.css }) + '\n```' },
      { role: 'user', content: repairNotes(graded.score) },
    ]);
    if (repaired?.css) {
      const score = scoreScene(repaired.css, packet, sliceLen);
      if (score.score > graded.score.score) best = { cue: repaired, score };
    }
  }

  if (best && best.score.score >= REPAIRABLE_SCORE) {
    return {
      cue: best.cue,
      origin: best === graded ? 'ai' : 'repaired',
      score: best.score.score,
    };
  }

  // The floor. Composed from the packet, so it obeys the same brief the model
  // was given and lands in the same look as every other beat of this story.
  const composed = composeScene(packet, {
    weight: input.tension ?? 0.5,
    textLength: sliceLen,
  });
  return {
    cue: {
      id: rid(), anchor: item.anchor, kind: 'theme', css: composed,
      label: item.intent.slice(0, 40),
      pace: best?.cue.pace, fx: best?.cue.fx,
    },
    origin: 'composed',
    score: scoreScene(composed, packet, sliceLen).score,
  };
};

/**
 * Resolve each cue's anchor to offsets in the text: `start` (where the phrase
 * begins — the boundary a scene segment opens at) and `at` (just after it — where
 * point effects fire once the words are read). Drops anchors that no longer
 * occur; sorted in reading order.
 */
export const resolveCues = (cues: SceneCue[], content: string): { start: number; at: number; cue: SceneCue }[] => {
  const hay = content.toLowerCase();
  return cues
    .map(cue => { const i = hay.indexOf(cue.anchor.toLowerCase()); return i < 0 ? null : { start: i, at: i + cue.anchor.length, cue }; })
    .filter((x): x is { start: number; at: number; cue: SceneCue } => x != null)
    .sort((a, b) => a.start - b.start);
};

/** Generate + sanitize a cue track for one message. [] on empty/garbage reply. */
export const generateCueTrack = async (
  input: CueGenInput, cfg: SandboxGenConfig, signal?: AbortSignal,
): Promise<SceneCue[]> => {
  const reply = await askText(
    { base: cfg.base, key: cfg.key, model: cfg.model }, buildCueMessages(input),
    {
      label: 'Directing the scene',
      params: designSamplers(cfg.base), reader: cfg.params, budget: SCENE_TOKENS, signal,
    },
  );
  return parseCueTrack(reply, input.content);
};
