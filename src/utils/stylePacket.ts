/**
 * The Style Packet — the reader's free-text direction, RESOLVED.
 *
 * Why this exists. The Scene Director used to take the reader's guidance
 * ("1970s giallo horror") and paste it as ONE line into a ~55-line system
 * prompt that already had loud opinions about colour, depth, motion and
 * framing. The doctrine outvoted the reader, every beat re-improvised from
 * scratch, and the same guidance produced amber candlelight on beat 1 and
 * steel-blue on beat 3. That is what "a complete gamble regardless of model"
 * actually looks like from the inside.
 *
 * So guidance is normalised ONCE per story into this packet: concrete values,
 * not adjectives — real hex, a real font stack, a named light model, an
 * allowlist of shot types, an explicit never-do list. The packet renders to the
 * SAME BYTES on every call (see `packetBlock`), so every beat of a story is
 * directed against one fixed brief instead of a fresh improvisation.
 *
 * Three properties matter more than the prompt wording:
 *  - It is DERIVABLE WITHOUT AI. `heuristicPacket` keyword-matches guidance
 *    against a built-in vocabulary, so the packet exists with no endpoint
 *    configured — the fallback ladder the rest of Aura is built on.
 *  - It is INSPECTABLE. The reader sees the resolved hex and can edit it. A
 *    gamble you can look at and correct stops being a gamble.
 *  - It is a FLOOR. `composeScene` builds a genuinely good stylesheet from the
 *    packet in pure TS, so a bad model reply degrades to something composed
 *    rather than to nothing.
 */

import { ChatMsg, chatCompletion, SamplerParams } from './aiClient';
import { isLocalBase } from './aiClient';

export const STYLE_PACKET_VERSION = 1;

export type PacketMotion = 'still' | 'drift' | 'restless';

/** The four colours every scene is built from. Real hex, never adjectives. */
export interface PacketPalette {
  /** The backdrop the shot sits in — usually the darkest or the paper. */
  bg: string;
  /** The words. Must clear contrast against `bg`; validated on parse. */
  ink: string;
  /** The one sharp colour that carries the mood. */
  accent: string;
  /** A second light — halation, rim light, the glow behind the fog. */
  glow: string;
}

export interface PacketType {
  /** A web-safe stack — the sandbox is offline, fonts cannot be downloaded. */
  stack: string;
  /** [light, heavy] — character comes from weight EXTREMES, not a custom face. */
  weight: [number, number];
  /** e.g. ".04em" — tracking is most of what makes type look designed. */
  tracking: string;
  /** "uppercase" | "lowercase" | "none". */
  transform: string;
}

export interface StylePacket {
  v: number;
  /** Where it came from — shown to the reader so the state is never mysterious. */
  source: 'heuristic' | 'ai' | 'reader';
  /** The named vocabulary entry it resolved to (heuristic path), for the label. */
  preset?: string;
  /** One clause naming the look. */
  look: string;
  palette: PacketPalette;
  /** The light model in words a stylesheet can be built from. */
  light: string;
  /** The shot grammar this story is allowed to use — 3-5 entries. */
  camera: string[];
  type: PacketType;
  /** Grain, halation, vignette, scanlines… — 2-4 entries. */
  texture: string[];
  motion: PacketMotion;
  /** The explicit never-do list. Checked by the critic, not just asked for. */
  forbid: string[];
}

/** A packet as persisted, beside the guidance it was resolved from. */
export interface PacketRecord {
  packet: StylePacket;
  /** The guidance text at derivation time — reword it and the packet is stale. */
  guidance: string;
}

/** Has the reader's direction moved on from the packet we resolved for it? */
export const isPacketStale = (rec: PacketRecord | undefined, guidance: string): boolean =>
  !rec || rec.packet.v !== STYLE_PACKET_VERSION
  || (rec.packet.source !== 'reader' && rec.guidance.trim() !== guidance.trim());

/* ------------------------------------------------------------------ *
 * The vocabulary — the AI-free floor.                                 *
 * ------------------------------------------------------------------ */

interface Preset extends Omit<StylePacket, 'v' | 'source' | 'preset'> {
  /** Lowercase keywords that select this preset from free-text guidance. */
  keys: string[];
}

/**
 * Twelve looks that cover most of what readers actually ask for. Each is a
 * complete, hand-checked brief — a palette that holds together, a stack that
 * exists on every machine, and a never-list aimed at that look's own failure
 * mode. Unmatched guidance HASHES into one of these rather than falling back to
 * nothing, so the floor is always a designed look and never a grey box.
 */
const PRESETS: Preset[] = [
  {
    keys: ['noir', 'detective', 'hardboiled', 'black and white', 'monochrome', 'venetian'],
    look: 'high-contrast film noir — hard shadow, wet light, everything withheld',
    palette: { bg: '#08090b', ink: '#e9e7e2', accent: '#c9a227', glow: '#6f9fc4' },
    light: 'one hard source low and off-frame, venetian slats, deep falloff to black',
    camera: ['low-angle close-up', 'silhouette against light', 'slow push-in', 'canted frame'],
    type: { stack: '"Times New Roman", Times, ui-serif, Georgia, serif', weight: [300, 800], tracking: '.02em', transform: 'none' },
    texture: ['film grain', 'hard vignette', 'smoke haze'],
    motion: 'drift',
    forbid: ['flat even fills', 'soft pastel colour', 'centred default box'],
  },
  {
    keys: ['giallo', 'lurid', 'operatic', 'slasher', 'argento', 'italian horror'],
    look: '1970s giallo — lurid gelled colour, operatic and cruel',
    palette: { bg: '#140609', ink: '#f4e6d6', accent: '#d61f2b', glow: '#ffb03a' },
    light: 'saturated gel lights fighting each other, red key against amber rim',
    camera: ['hard zoom', 'extreme close-up on the eye', 'canted angle', 'whip pan'],
    type: { stack: 'Impact, Haettenschweiler, "Arial Narrow", ui-sans-serif, sans-serif', weight: [400, 900], tracking: '.06em', transform: 'uppercase' },
    texture: ['heavy film grain', 'halation bloom', 'colour fringing'],
    motion: 'restless',
    forbid: ['muted desaturated palette', 'timid small type', 'grey neutrals'],
  },
  {
    keys: ['terminal', 'hacker', 'computer', 'console', 'cli', 'green screen', 'retro tech'],
    look: 'a phosphor terminal — cold, precise, one colour of light',
    palette: { bg: '#040806', ink: '#8effb0', accent: '#00ff9c', glow: '#0d4a26' },
    light: 'self-luminous phosphor, glow bleeding into the black around each glyph',
    camera: ['locked-off frame', 'slow scroll', 'hard cut', 'screen-edge curvature'],
    type: { stack: '"Courier New", Courier, ui-monospace, monospace', weight: [400, 700], tracking: '.08em', transform: 'none' },
    texture: ['scanlines', 'phosphor bloom', 'screen curvature vignette'],
    motion: 'drift',
    forbid: ['serif type', 'warm colour', 'rounded soft shapes'],
  },
  {
    keys: ['storybook', 'fairy tale', 'fable', 'illuminated', 'parchment', 'manuscript', 'cosy', 'cozy'],
    look: 'an illuminated storybook page — warm paper, inked capitals',
    palette: { bg: '#f2e7d2', ink: '#2b2117', accent: '#8c3b2e', glow: '#d9a441' },
    light: 'flat warm daylight on paper, a soft shadow in the gutter',
    camera: ['flat overhead page', 'slow reveal down the page', 'decorated initial', 'margin vignette'],
    type: { stack: 'Palatino, "Palatino Linotype", "Book Antiqua", ui-serif, Georgia, serif', weight: [400, 700], tracking: '.01em', transform: 'none' },
    texture: ['paper fibre', 'deckled edge shadow', 'ink bleed'],
    motion: 'still',
    forbid: ['dark backgrounds', 'neon colour', 'glow effects'],
  },
  {
    keys: ['cosmic', 'eldritch', 'void', 'lovecraft', 'starlight', 'abyss', 'space'],
    look: 'cosmic dread — vast cold depth, a light that should not be there',
    palette: { bg: '#04050e', ink: '#d6dbf2', accent: '#7b5cff', glow: '#38e8ff' },
    light: 'no source you can point at; a pale glow rising from below the frame',
    camera: ['wide establishing void', 'slow endless push-in', 'rack focus to nothing', 'tilt up'],
    type: { stack: 'Georgia, "Times New Roman", ui-serif, serif', weight: [200, 700], tracking: '.14em', transform: 'uppercase' },
    texture: ['star field', 'chromatic haze', 'deep vignette'],
    motion: 'drift',
    forbid: ['warm domestic colour', 'tight cramped framing', 'hard geometric edges'],
  },
  {
    keys: ['candle', 'tavern', 'hearth', 'firelight', 'warm', 'inn', 'rustic', 'medieval'],
    look: 'candlelit interior — small warm light, a large dark room',
    palette: { bg: '#1a1109', ink: '#f0e0c6', accent: '#e09f3e', glow: '#ff7a29' },
    light: 'a single flame low in frame, warm falloff, everything past arm’s reach in shadow',
    camera: ['close two-shot', 'firelight flicker', 'shallow focus', 'slow drift'],
    type: { stack: 'Georgia, "Palatino Linotype", ui-serif, serif', weight: [300, 700], tracking: '.02em', transform: 'none' },
    texture: ['soot haze', 'warm vignette', 'flame flicker'],
    motion: 'drift',
    forbid: ['cold blue light', 'flat even illumination', 'clinical whites'],
  },
  {
    keys: ['clinical', 'sterile', 'lab', 'hospital', 'facility', 'institutional', 'white room'],
    look: 'clinical light — nowhere to hide, no shadow to stand in',
    palette: { bg: '#0e1319', ink: '#e4ebf2', accent: '#4cc9f0', glow: '#90e0ef' },
    light: 'flat overhead fluorescence, faint flicker, shadowless and unkind',
    camera: ['symmetrical wide', 'locked-off frame', 'hard cut', 'overhead top-down'],
    type: { stack: 'ui-sans-serif, "Helvetica Neue", Helvetica, Arial, sans-serif', weight: [200, 800], tracking: '.1em', transform: 'uppercase' },
    texture: ['fluorescent flicker', 'cold gradient wash', 'thin rule lines'],
    motion: 'still',
    forbid: ['warm colour', 'organic texture', 'soft glow'],
  },
  {
    keys: ['neon', 'cyberpunk', 'synthwave', 'city', 'rain', 'street', 'nightlife'],
    look: 'rain-slick neon — every surface reflecting something else',
    palette: { bg: '#060310', ink: '#eaf2ff', accent: '#ff2e88', glow: '#00e5ff' },
    light: 'competing neon signs, magenta key against cyan rim, wet reflections',
    camera: ['low wide with reflections', 'rack focus through glass', 'push-in', 'neon-lit close-up'],
    type: { stack: 'ui-sans-serif, "Arial Black", Impact, sans-serif', weight: [200, 900], tracking: '.12em', transform: 'uppercase' },
    texture: ['rain streaks', 'neon bloom', 'chromatic aberration'],
    motion: 'restless',
    forbid: ['beige or brown palette', 'daylight', 'paper texture'],
  },
  {
    keys: ['gothic', 'cathedral', 'vampire', 'crypt', 'baroque', 'funeral', 'ritual'],
    look: 'gothic ritual — stone, stained light, ceremony',
    palette: { bg: '#0b0810', ink: '#e0dae8', accent: '#7a3f8c', glow: '#c9a227' },
    light: 'coloured light through high glass, long shafts through dust, everything else stone-dark',
    camera: ['low-angle looking up', 'symmetrical altar frame', 'slow tilt', 'silhouette in an arch'],
    type: { stack: '"Times New Roman", Times, ui-serif, Georgia, serif', weight: [300, 800], tracking: '.08em', transform: 'uppercase' },
    texture: ['dust shafts', 'stone grain', 'deep vignette'],
    motion: 'drift',
    forbid: ['bright even light', 'modern sans type', 'playful colour'],
  },
  {
    keys: ['thriller', 'steel', 'procedural', 'cold', 'tense', 'military', 'espionage'],
    look: 'cold steel thriller — controlled, blue-grey, nothing wasted',
    palette: { bg: '#0a0e13', ink: '#e0e7ee', accent: '#3d8fbf', glow: '#8fb8d6' },
    light: 'hard cool key from one side, practical lights failing in the distance',
    camera: ['handheld close-up', 'hard cut', 'over-the-shoulder', 'shallow long lens'],
    type: { stack: 'ui-sans-serif, "Helvetica Neue", Arial, sans-serif', weight: [300, 800], tracking: '.05em', transform: 'uppercase' },
    texture: ['fine grain', 'cool gradient wash', 'lens vignette'],
    motion: 'restless',
    forbid: ['warm gold light', 'ornate decoration', 'soft focus glow'],
  },
  {
    keys: ['pastoral', 'forest', 'meadow', 'dawn', 'nature', 'wilderness', 'garden', 'spring'],
    look: 'first light outdoors — air you can see, colour coming back into the world',
    palette: { bg: '#0f1a15', ink: '#eaf2e8', accent: '#86c06c', glow: '#f2d492' },
    light: 'low golden sun through mist, long soft shadows, haze catching the beams',
    camera: ['wide establishing landscape', 'slow drift', 'backlit silhouette', 'shallow focus on detail'],
    type: { stack: 'Georgia, "Iowan Old Style", ui-serif, serif', weight: [300, 700], tracking: '.02em', transform: 'none' },
    texture: ['morning haze', 'soft bloom', 'dappled light'],
    motion: 'drift',
    forbid: ['harsh neon', 'heavy black vignette', 'mechanical geometry'],
  },
  {
    keys: ['ruin', 'ash', 'desert', 'wasteland', 'post-apocalyptic', 'drought', 'aftermath', 'decay'],
    look: 'sun-bleached ruin — dust, heat, and what is left',
    palette: { bg: '#151210', ink: '#e8e1d5', accent: '#a8563a', glow: '#d9c9a8' },
    light: 'flat overhead sun through dust, bleached highlights, no true black',
    camera: ['wide desolate frame', 'slow pan across nothing', 'low horizon', 'heat-shimmer close-up'],
    type: { stack: '"Copperplate Gothic", Copperplate, Georgia, ui-serif, serif', weight: [400, 700], tracking: '.16em', transform: 'uppercase' },
    texture: ['dust haze', 'sun bleach', 'cracked grain'],
    motion: 'drift',
    forbid: ['saturated colour', 'deep pure blacks', 'glossy surfaces'],
  },
];

/** The named looks, for UI listing. */
export const PRESET_NAMES = PRESETS.map(p => p.keys[0]);

const norm = (s: string) => s.toLowerCase();

/** FNV-1a — stable across sessions, so unguided stories keep their look. */
const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};

/**
 * Pick the preset whose keywords the guidance hits hardest. Ties break toward
 * the earlier preset so the choice is deterministic; NO hit at all hashes the
 * guidance into a preset, because a designed look chosen arbitrarily beats a
 * grey box chosen carefully.
 */
export const matchPreset = (guidance: string): { preset: Preset; matched: boolean } => {
  const g = norm(guidance || '');
  let best: Preset | null = null;
  let bestScore = 0;
  for (const p of PRESETS) {
    // Longer keywords are stronger evidence — "italian horror" over "horror".
    const score = p.keys.reduce((n, k) => (g.includes(k) ? n + k.length : n), 0);
    if (score > bestScore) { bestScore = score; best = p; }
  }
  if (best) return { preset: best, matched: true };
  return { preset: PRESETS[hash(g) % PRESETS.length], matched: false };
};

/** Resolve guidance to a packet with no AI at all — the floor. */
export const heuristicPacket = (guidance: string): StylePacket => {
  const { preset, matched } = matchPreset(guidance);
  const { keys, ...rest } = preset;
  return {
    v: STYLE_PACKET_VERSION,
    source: 'heuristic',
    preset: keys[0],
    ...rest,
    // Keep the reader's own words at the head of the look when they gave any —
    // the preset supplies the values, the reader supplies the intent.
    look: matched && guidance.trim() ? `${guidance.trim().slice(0, 120)} — ${rest.look}` : rest.look,
  };
};

/* ------------------------------------------------------------------ *
 * Rendering — the same bytes on every call.                           *
 * ------------------------------------------------------------------ */

/**
 * The packet as it appears in a prompt. Deterministic: identical packet in,
 * identical string out, so a re-run differs only where the model differs.
 */
export const packetBlock = (p: StylePacket): string => [
  'STYLE PACKET — the reader’s direction, already resolved. Obey EVERY field;',
  'these are values, not suggestions. Do not substitute your own palette.',
  `  look:     ${p.look}`,
  `  palette:  bg ${p.palette.bg} · ink ${p.palette.ink} · accent ${p.palette.accent} · glow ${p.palette.glow}`,
  `  light:    ${p.light}`,
  `  camera:   ${p.camera.join(' · ')}`,
  `  type:     ${p.type.stack} · weights ${p.type.weight[0]}/${p.type.weight[1]} · tracking ${p.type.tracking}${p.type.transform !== 'none' ? ` · ${p.type.transform}` : ''}`,
  `  texture:  ${p.texture.join(' · ')}`,
  `  motion:   ${p.motion}${p.motion === 'still' ? ' (no ambient animation — compose in stillness)' : ''}`,
  `  NEVER:    ${p.forbid.join(' · ')}`,
].join('\n');

/** A one-line label for the UI. */
export const packetLabel = (p: StylePacket): string =>
  `${p.preset ?? 'custom'} · ${p.source === 'ai' ? 'AI-resolved' : p.source === 'reader' ? 'edited' : 'built-in'}`;

/* ------------------------------------------------------------------ *
 * AI derivation — one cheap call per story, schema-shaped.            *
 * ------------------------------------------------------------------ */

const HEX = /^#[0-9a-f]{6}$/i;

const PACKET_SYSTEM = [
  'You are an art director. Turn a reader’s free-text direction into a CONCRETE',
  'style brief that a CSS designer will follow literally for an entire story.',
  '',
  'Return ONE fenced ```json object, no prose:',
  '{',
  '  "look":    one clause naming the look (max 100 chars),',
  '  "palette": {"bg":"#rrggbb","ink":"#rrggbb","accent":"#rrggbb","glow":"#rrggbb"},',
  '  "light":   the light model in one clause — source, direction, falloff,',
  '  "camera":  3-5 shot types this story is allowed to use,',
  '  "type":    {"stack":"a WEB-SAFE css font stack","weight":[light,heavy],',
  '              "tracking":"0.04em","transform":"uppercase|none"},',
  '  "texture": 2-4 surface textures (grain, halation, scanlines, paper fibre…),',
  '  "motion":  "still" | "drift" | "restless",',
  '  "forbid":  3-4 things that would BETRAY this look',
  '}',
  '',
  'RULES:',
  '1. Palette must be real 6-digit hex. `ink` must be clearly readable on `bg` —',
  '   they are the text and its backdrop. `accent` and `glow` are the two lights.',
  '2. Fonts CANNOT be downloaded. Use stacks that exist everywhere: Georgia,',
  '   "Times New Roman", Palatino, "Courier New", Impact, Copperplate, ui-sans-serif.',
  '3. Commit. A vague brief produces vague design — name the decade, the stock,',
  '   the lens, the failure you are avoiding.',
  '4. Return ONLY the ```json object.',
].join('\n');

export const buildPacketMessages = (guidance: string, samples: string[] = []): ChatMsg[] => {
  const sample = samples.length
    ? ['The story reads like this (CONTEXT ONLY — never reproduce it):', '"""',
       samples.slice(0, 3).join('\n---\n').slice(0, 1200), '"""'].join('\n')
    : '';
  const user = [
    `Reader’s direction: ${guidance.trim() || 'no direction given — derive the look from the material itself'}`,
    sample,
    '', 'Resolve it into the ```json brief.',
  ].filter(Boolean).join('\n');
  return [{ role: 'system', content: PACKET_SYSTEM }, { role: 'user', content: user }];
};

const strFrom = (v: unknown, max: number, fallback: string): string =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : fallback;

const listFrom = (v: unknown, max: number, fallback: string[]): string[] => {
  if (!Array.isArray(v)) return fallback;
  const out = v.filter((x): x is string => typeof x === 'string' && !!x.trim())
    .map(x => x.trim().slice(0, 60)).slice(0, max);
  return out.length ? out : fallback;
};

/**
 * Parse a derivation reply, FIELD BY FIELD, against the heuristic packet for
 * the same guidance. Every field the model got wrong falls back to a value that
 * was already good — so a half-usable reply yields a whole usable packet, and a
 * garbage reply yields exactly the floor rather than a broken brief.
 */
export const parsePacket = (raw: string, guidance: string): StylePacket => {
  const floor = heuristicPacket(guidance);
  const text = (raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const fenced = text.match(/```json\b[^\n]*\n([\s\S]*?)```/i)?.[1]
    ?? text.match(/```[^\n]*\n([\s\S]*?)```/)?.[1]
    ?? (text.trim().startsWith('{') ? text.trim() : '');
  if (!fenced) return floor;
  let o: Record<string, unknown>;
  try { o = JSON.parse(fenced); } catch { return floor; }
  if (!o || typeof o !== 'object') return floor;

  const pal = (o.palette ?? {}) as Record<string, unknown>;
  const hex = (v: unknown, fb: string) => (typeof v === 'string' && HEX.test(v.trim()) ? v.trim().toLowerCase() : fb);
  const ty = (o.type ?? {}) as Record<string, unknown>;
  const w = Array.isArray(ty.weight) ? ty.weight : [];
  const weight: [number, number] = [
    typeof w[0] === 'number' && w[0] >= 100 && w[0] <= 900 ? Math.round(w[0] / 100) * 100 : floor.type.weight[0],
    typeof w[1] === 'number' && w[1] >= 100 && w[1] <= 900 ? Math.round(w[1] / 100) * 100 : floor.type.weight[1],
  ];
  const motion = ['still', 'drift', 'restless'].includes(o.motion as string)
    ? (o.motion as PacketMotion) : floor.motion;

  const packet: StylePacket = {
    v: STYLE_PACKET_VERSION,
    source: 'ai',
    preset: floor.preset,
    look: strFrom(o.look, 120, floor.look),
    palette: {
      bg: hex(pal.bg, floor.palette.bg),
      ink: hex(pal.ink, floor.palette.ink),
      accent: hex(pal.accent, floor.palette.accent),
      glow: hex(pal.glow, floor.palette.glow),
    },
    light: strFrom(o.light, 160, floor.light),
    camera: listFrom(o.camera, 5, floor.camera),
    type: {
      stack: strFrom(ty.stack, 120, floor.type.stack),
      weight: weight[0] <= weight[1] ? weight : [weight[1], weight[0]],
      tracking: /^-?\d*\.?\d+(em|px)$/.test(String(ty.tracking ?? '')) ? String(ty.tracking) : floor.type.tracking,
      transform: ['uppercase', 'lowercase', 'none'].includes(ty.transform as string)
        ? (ty.transform as string) : floor.type.transform,
    },
    texture: listFrom(o.texture, 4, floor.texture),
    motion,
    forbid: listFrom(o.forbid, 4, floor.forbid),
  };
  // A palette whose ink vanishes into its own backdrop is worse than no palette
  // at all — the one failure that makes a story unreadable rather than ugly.
  if (contrast(packet.palette.ink, packet.palette.bg) < 4.5) packet.palette = floor.palette;
  return packet;
};

/** Sampling for RESOLVING a brief — a classification task, not a creative one. */
export const packetSamplers = (base: string): SamplerParams => ({
  temperature: 0, top_p: 1, frequency_penalty: 0, presence_penalty: 0,
  ...(isLocalBase(base) ? { top_k: 1, min_p: 0, repetition_penalty: 1 } : {}),
});

/** Derive the packet for a story. Never throws — falls back to the floor. */
export const derivePacket = async (
  guidance: string, samples: string[],
  cfg: { base: string; key: string; model: string },
  signal?: AbortSignal,
): Promise<StylePacket> => {
  if (!cfg.base || !cfg.model) return heuristicPacket(guidance);
  try {
    const reply = await chatCompletion(
      cfg.base, cfg.key, cfg.model, buildPacketMessages(guidance, samples),
      { ...packetSamplers(cfg.base), max_tokens: 700 }, signal,
    );
    return parsePacket(reply, guidance);
  } catch {
    return heuristicPacket(guidance);
  }
};

/* ------------------------------------------------------------------ *
 * Colour maths — enough to keep the packet honest.                    *
 * ------------------------------------------------------------------ */

const rgb = (h: string): [number, number, number] => {
  const s = h.replace('#', '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
};
const lin = (c: number) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
const lum = (h: string) => { const [r, g, b] = rgb(h); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };

/** WCAG contrast ratio between two hex colours. */
export const contrast = (a: string, b: string): number => {
  if (!HEX.test(a) || !HEX.test(b)) return 21;
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

/** `#rrggbb` → `rgba(r,g,b,alpha)` — how the composer builds its light layers. */
export const rgba = (hex: string, alpha: number): string => {
  const [r, g, b] = rgb(HEX.test(hex) ? hex : '#000000');
  return `rgba(${r},${g},${b},${alpha})`;
};

/** Is this packet's backdrop a dark one? Decides which way the light goes. */
export const isDark = (p: StylePacket): boolean => lum(p.palette.bg) < 0.35;

/* ------------------------------------------------------------------ *
 * The floor — a good scene composed from the packet, with no AI.      *
 * ------------------------------------------------------------------ */

/** Grain as an inline SVG data URI — no network, allowed by the sandbox CSP. */
const grain = (opacity: number) =>
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E`
  + `%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3'/%3E`
  + `%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)' opacity='${opacity}'/%3E%3C/svg%3E")`;

export interface ComposeOptions {
  /** How loud this beat is, 0-1 — scales the hero type and the light. */
  weight?: number;
  /** A short slice means a hero line; a long one needs a readable column. */
  textLength?: number;
}

/**
 * Build a complete, composed stylesheet from the packet in pure TypeScript.
 *
 * This is the guarantee. A model can return three declarations and a flat fill;
 * this cannot. It always produces a layered backdrop, a vignette, real texture,
 * a type scale sized to the slice, and — unless the packet says `still` — one
 * ambient loop on the BACKDROP rather than on the words. Emitted on one line,
 * matching the cue contract.
 */
export const composeScene = (p: StylePacket, opts: ComposeOptions = {}): string => {
  const weight = Math.min(1, Math.max(0, opts.weight ?? 0.5));
  const len = opts.textLength ?? 240;
  const dark = isDark(p);
  const { bg, ink, accent, glow } = p.palette;

  // A hero line gets to be enormous; a paragraph drops into a readable column.
  const hero = len <= 120;
  const size = hero
    ? `clamp(1.9rem, ${(4.4 + weight * 1.8).toFixed(1)}vw, 3.6rem)`
    : len <= 420 ? 'clamp(1.15rem, 2.2vw, 1.6rem)' : 'clamp(1rem, 1.7vw, 1.25rem)';
  const column = hero ? '18ch' : len <= 420 ? '46ch' : '62ch';

  const ambient = p.motion === 'still' ? ''
    : p.motion === 'restless'
      ? 'body::before{animation:auraDrift 9s ease-in-out infinite alternate}'
      : 'body::before{animation:auraDrift 24s ease-in-out infinite alternate}';
  const keyframes = p.motion === 'still' ? ''
    : '@keyframes auraDrift{from{transform:scale(1) translate3d(0,0,0);opacity:.85}to{transform:scale(1.08) translate3d(2%,-2%,0);opacity:1}}';

  return [
    // The backdrop: three stacked lights, never a flat fill.
    `body{margin:0;min-height:100vh;background:`
      + `radial-gradient(120% 90% at 50% ${dark ? '112%' : '-12%'}, ${rgba(glow, dark ? 0.34 : 0.42)} 0%, transparent 58%),`
      + `radial-gradient(70% 55% at ${weight > 0.6 ? '22%' : '76%'} 18%, ${rgba(accent, 0.22)} 0%, transparent 62%),`
      + `linear-gradient(${dark ? '168deg' : '12deg'}, ${bg} 0%, ${rgba(accent, 0.07)} 55%, ${bg} 100%) ${bg};`
      + `color:${ink};font-family:${p.type.stack};overflow:hidden;isolation:isolate}`,
    // Texture + the ambient layer, on the backdrop and never on the words.
    //
    // Two things above are load-bearing, and both were found by looking at a
    // screenshot rather than by any test:
    //
    //  - The trailing `${bg}` is a background-COLOUR under the layers. A tinted
    //    mid-stop (`rgba(accent,.07)` at 55%) makes the base gradient ~93%
    //    transparent through a diagonal band, and a sandbox iframe has nothing
    //    opaque behind it — so the reader's own dark app page showed through the
    //    middle of the frame. On the light look that was a black diagonal smear
    //    across two thirds of the shot. The critic scored that stylesheet 100/100,
    //    because as a stylesheet it is perfectly good.
    //  - `isolation:isolate` keeps the grain's `mix-blend-mode` blending against
    //    this scene's own layers rather than whatever the compositor puts behind
    //    the iframe.
    `body::before{content:"";position:absolute;inset:0;pointer-events:none;`
      + `background-image:${grain(dark ? 0.5 : 0.32)};background-size:180px 180px;`
      + `mix-blend-mode:${dark ? 'screen' : 'multiply'};opacity:${dark ? 0.16 : 0.1}}`,
    // The vignette that stops it reading as a rectangle of colour.
    `body::after{content:"";position:absolute;inset:0;pointer-events:none;`
      + `box-shadow:inset 0 0 ${dark ? '22vmin' : '14vmin'} ${dark ? '6vmin' : '3vmin'} ${rgba(dark ? '#000000' : bg, dark ? 0.72 : 0.5)};`
      + `background:radial-gradient(130% 100% at 50% 50%, transparent 42%, ${rgba(dark ? '#000000' : bg, 0.55)} 100%)}`,
    // The stage. Vertically centred rather than bottom-anchored: Aura's own
    // playback bar floats over the bottom centre of the frame, and a lower-third
    // composition puts the words directly behind it.
    `.card{position:relative;z-index:1;min-height:100vh;display:flex;flex-direction:column;`
      + `justify-content:center;align-items:${hero ? 'center' : 'flex-start'};`
      + `gap:1.2rem;padding:clamp(1.5rem,6vw,5rem) clamp(1.5rem,6vw,5rem) clamp(5rem,12vh,8rem);`
      + `max-width:100vw;box-sizing:border-box}`,
    // The speaker, small and deliberate — tracking does the work.
    `.who{font-size:.72rem;font-weight:${p.type.weight[0]};letter-spacing:.28em;text-transform:uppercase;`
      + `color:${accent};opacity:.9;border-bottom:1px solid ${rgba(accent, 0.35)};padding-bottom:.4rem}`,
    // The words.
    `.body{font-size:${size};font-weight:${hero ? p.type.weight[1] : p.type.weight[0] + 100};`
      + `line-height:${hero ? 1.16 : 1.55};letter-spacing:${p.type.tracking};`
      + `${p.type.transform !== 'none' && hero ? `text-transform:${p.type.transform};` : ''}`
      + `max-width:${column};text-align:${hero ? 'center' : 'left'};text-wrap:balance;`
      + `color:${ink};text-shadow:0 0 ${hero ? '2.4rem' : '1.2rem'} ${rgba(glow, dark ? 0.34 : 0)};`
      + `overflow-wrap:break-word;max-height:82vh;overflow:auto}`,
    `.body p{margin:0 0 .7em}.body p:last-child{margin-bottom:0}`,
    // Quoted speech picks up the accent — the one place colour touches the text.
    `.say{color:${accent};font-weight:${p.type.weight[1]}}`,
    // One orchestrated entrance — but the WORDS never depend on it.
    //
    // The first version animated `.card>*` from opacity 0 with `fill: both`, so
    // if the animation had not finished (or never ran) the text was invisible
    // while sitting in the DOM, correctly coloured and correctly sized. The E2E
    // caught it at opacity 0 on five of six looks. In a reader that streams text
    // into a live iframe, "the words appear once an animation completes" is not
    // a risk worth taking for a flourish — so the speaker label fades in, and
    // the body only ever MOVES.
    `.who{animation:auraRise .8s cubic-bezier(.2,.7,.2,1) .05s both}`,
    `.body{animation:auraSettle .9s cubic-bezier(.2,.7,.2,1) both}`,
    `@keyframes auraRise{from{opacity:0;transform:translateY(.6rem)}to{opacity:1;transform:none}}`,
    `@keyframes auraSettle{from{transform:translateY(${hero ? '1.2rem' : '.7rem'})}to{transform:none}}`,
    ambient,
    keyframes,
    `@media (prefers-reduced-motion:reduce){.who,.body,body::before{animation:none!important}}`,
  ].filter(Boolean).join('');
};
