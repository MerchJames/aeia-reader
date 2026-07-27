import React from 'react';
import { create } from 'zustand';
import { createJSONStorage, persist, StateStorage } from 'zustand/middleware';
import { Annotation, Chain, ChatThread, ChatTurn, ContextZone, CowritePreset, Message, MessageOverride, Pin, PinSet, PinVersion, SandboxActive, SandboxScope, SandboxTreatment, SceneCue, SceneDescriptor, Sheet, StyleConfig } from '../types';
import { useAppStore } from '../store';

/**
 * Debounced localStorage. This blob can hold codex data, overrides and several
 * large pinned visuals (up to ~150k chars each) — serializing and writing all
 * of it on every single `set()` (panel toggles, codex-scan ticks, annotations)
 * stutters the reader. Coalesce rapid writes into one, and flush on hide/unload
 * so nothing is lost.
 */
const debouncedLocalStorage = (delay = 500): StateStorage => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { name: string; value: string } | null = null;
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (pending) {
      try { localStorage.setItem(pending.name, pending.value); } catch { /* quota */ }
      pending = null;
    }
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
  }
  return {
    getItem: (name) => localStorage.getItem(name),
    setItem: (name, value) => {
      pending = { name, value };
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, delay);
    },
    removeItem: (name) => {
      pending = null;
      if (timer) { clearTimeout(timer); timer = null; }
      localStorage.removeItem(name);
    },
  };
};

/* ------------------------------------------------------------------ */
/* Codex types                                                         */
/* ------------------------------------------------------------------ */

export type EntityKind = 'character' | 'location' | 'item';

export interface CodexEntity {
  id: string;
  /** Canonical display name, e.g. "Mira Valen". */
  name: string;
  kind: EntityKind;
  /** Alternate spellings/short forms that should also match in text. */
  aliases: string[];
  /**
   * Spoiler-free summary. Built only from text the reader has already
   * passed, so hovering an entity never reveals anything ahead.
   */
  summary: string;
  /** Where the entity first appeared (flat message index across chains). */
  firstSeenIndex: number;
  firstSeenMessageId: string;
  mentions: number;
  updatedAt: number;
  /** Merge priority: card (author-written) > ai > heuristic. */
  source: 'heuristic' | 'ai' | 'card';
}

const SOURCE_RANK: Record<CodexEntity['source'], number> = {
  heuristic: 0, ai: 1, card: 2,
};

export interface StoryStats {
  /** Total milliseconds spent with this story streaming. */
  msRead: number;
  lastReadAt: number;
}

/* ------------------------------------------------------------------ */
/* Multiverse graph types (plain data; MultiverseExplorer maps them    */
/* onto React Flow nodes/edges)                                        */
/* ------------------------------------------------------------------ */

export interface MvSceneData {
  type: 'scene';
  chainIndex: number;
  /** First message id of the chain — the jump target. */
  messageId: string;
  speaker: string;
  preview: string;
  messageCount: number;
  starred: boolean;
  /** Number of alternate-version fans hanging off this scene. */
  branchCount: number;
}

export interface MvVariantData {
  type: 'variant';
  chainIndex: number;
  messageId: string;
  swipeIndex: number;
  preview: string;
  /** This version is the one currently woven into the reading path. */
  active: boolean;
}

export interface MvNode {
  id: string;
  x: number;
  y: number;
  data: MvSceneData | MvVariantData;
}

export interface MvEdge {
  id: string;
  source: string;
  target: string;
  /** Part of the timeline the reader is currently on. */
  onPath: boolean;
}

export interface MvGraph {
  nodes: MvNode[];
  edges: MvEdge[];
  currentSceneId: string;
}

/** Trimmed one-line preview of a message for node labels. */
const preview = (text: string, len = 90): string => {
  const plain = text.replace(/[*_`#>[\]]+/g, '').replace(/\s+/g, ' ').trim();
  return plain.length > len ? `${plain.slice(0, len)}…` : plain;
};

/** The swipe index currently woven into the path for a message. */
export const activeSwipeIndex = (
  msg: Message, selections: Record<string, number>,
): number => {
  if (selections[msg.id] != null) return selections[msg.id];
  const found = msg.swipes?.indexOf(msg.content) ?? -1;
  return found >= 0 ? found : 0;
};

const SPINE_X = 0;
const SPINE_GAP_Y = 130;
const FAN_X = 380;
const FAN_COL_W = 320;
const FAN_ROW_H = 96;

/**
 * Build the story DAG. The main timeline is a vertical spine of scene
 * nodes (one per chain); every message that has swipes fans its alternate
 * versions out to the right, merging back into the next scene. Chains
 * without branches stay plain spine links, so even a 5,000-scene Kobold
 * save produces a graph that pans smoothly with virtualized rendering.
 */
export const buildMultiverseGraph = (
  chains: Chain[],
  swipeSelections: Record<string, number>,
  currentChainIndex: number,
): MvGraph => {
  const nodes: MvNode[] = [];
  const edges: MvEdge[] = [];

  chains.forEach((chain, ci) => {
    const first = chain.messages[0];
    const branching = chain.messages.filter(m => m.swipes && m.swipes.length > 1);

    nodes.push({
      id: `scene-${ci}`,
      x: SPINE_X,
      y: ci * SPINE_GAP_Y,
      data: {
        type: 'scene',
        chainIndex: ci,
        messageId: first?.id ?? '',
        speaker: first?.name ?? '',
        preview: preview(first?.content ?? ''),
        messageCount: chain.messages.length,
        starred: chain.starred,
        branchCount: branching.length,
      },
    });

    if (ci > 0) {
      edges.push({
        id: `spine-${ci}`,
        source: `scene-${ci - 1}`,
        target: `scene-${ci}`,
        onPath: true,
      });
    }

    branching.forEach((msg, bi) => {
      const active = activeSwipeIndex(msg, swipeSelections);
      msg.swipes!.forEach((text, si) => {
        const id = `var-${msg.id}-${si}`;
        nodes.push({
          id,
          x: FAN_X + bi * FAN_COL_W,
          y: ci * SPINE_GAP_Y + (si - (msg.swipes!.length - 1) / 2) * FAN_ROW_H,
          data: {
            type: 'variant',
            chainIndex: ci,
            messageId: msg.id,
            swipeIndex: si,
            preview: preview(text, 70),
            active: si === active,
          },
        });
        edges.push({
          id: `e-${msg.id}-${si}`,
          source: bi === 0 ? `scene-${ci}` : `var-${branching[bi - 1].id}-${activeSwipeIndex(branching[bi - 1], swipeSelections)}`,
          target: id,
          onPath: si === active,
        });
        // Merge the fan back into the next scene so alternates read as
        // "what-ifs" that rejoin the timeline, not dead ends.
        if (bi === branching.length - 1 && ci + 1 < chains.length) {
          edges.push({
            id: `m-${msg.id}-${si}`,
            source: id,
            target: `scene-${ci + 1}`,
            onPath: si === active,
          });
        }
      });
    });
  });

  return {
    nodes,
    edges,
    currentSceneId: `scene-${Math.min(currentChainIndex, Math.max(0, chains.length - 1))}`,
  };
};

/* ------------------------------------------------------------------ */
/* Shared derived helpers                                              */
/* ------------------------------------------------------------------ */

/** Committed (fully read) message count, flat across chains. */
export const committedCount = (
  chains: Chain[], ci: number, mi: number, streaming: boolean,
): number => {
  let n = 0;
  for (let c = 0; c < ci; c++) n += chains[c]?.messages.length ?? 0;
  return n + mi + (streaming ? 0 : 1);
};

/** Flat message list in reading order. */
export const flatMessages = (chains: Chain[]): Message[] =>
  chains.flatMap(c => c.messages);

/** Entities the reader has actually met so far — the spoiler gate. */
export const visibleEntities = (
  entities: CodexEntity[], readCount: number,
): CodexEntity[] => entities.filter(e => e.firstSeenIndex < readCount);

/**
 * The reader's current branch choices: message id → selected swipe index.
 * This is the "currentBranchPath" the multiverse graph highlights.
 */
export const currentBranchPath = (): Record<string, number> => {
  const { chains, swipeSelections } = useAppStore.getState();
  const path: Record<string, number> = {};
  chains.forEach(c => c.messages.forEach(m => {
    if (m.swipes && m.swipes.length > 1) path[m.id] = activeSwipeIndex(m, swipeSelections);
  }));
  return path;
};

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

const MAX_ENTITIES_PER_STORY = 300;
const MAX_TRACKED_STORIES = 24;
const MAX_OVERRIDES_PER_STORY = 500;
const MAX_PINS_PER_STORY = 24;
const MAX_PIN_SETS_PER_STORY = 30;
/** Kept versions per pin (original is always preserved when trimming). */
const MAX_PIN_VERSIONS = 12;
/** Generous cap per pinned visual (~25k words) — big summary docs fit intact. */
const MAX_PIN_CONTENT = 150_000;
const MAX_ZONES_PER_STORY = 40;
const MAX_THREADS_PER_STORY = 30;
/** Trim a thread's history so a runaway conversation can't bloat localStorage. */
const MAX_TURNS_PER_THREAD = 400;

const normName = (s: string) => s.trim().toLowerCase();

/** A reader-authored sound cue on a hand-picked span (see #1 highlight→SFX). */
export interface SfxMark {
  id: string;
  /** Verbatim selected text — the anchor the SFX fires at as it's revealed. */
  text: string;
  /** The sound to render/reuse. */
  prompt: string;
  /** Slow the reveal across this span so the beat lands with the sound. */
  slow?: boolean;
}

interface AuraV2State {
  /* Codex data (persisted) */
  codexByStory: Record<string, CodexEntity[]>;
  /** Flat count of messages already scanned per story. */
  scanProgress: Record<string, number>;
  statsByStory: Record<string, StoryStats>;

  /* Lens override layer (persisted) */
  overridesByStory: Record<string, MessageOverride[]>;
  /** Whether the curated (override) view is active for a story. */
  lensOnByStory: Record<string, boolean>;

  /* Sheets (persisted) */
  sheetsByStory: Record<string, Sheet[]>;

  /* Anchored notes (persisted) */
  annotationsByStory: Record<string, Annotation[]>;

  /* Reader-authored SFX marks — story → messageId → span cues (persisted). */
  sfxMarksByStory: Record<string, Record<string, SfxMark[]>>;
  addSfxMark: (storyId: string, messageId: string, mark: Omit<SfxMark, 'id'>) => void;
  removeSfxMark: (storyId: string, messageId: string, markId: string) => void;

  /* Pinned visuals (persisted) */
  pinsByStory: Record<string, Pin[]>;

  /* Named, swappable pin arrangements — "saved views" (persisted) */
  pinSetsByStory: Record<string, PinSet[]>;
  /** Which set is currently applied per story; absent = none. */
  activePinSetByStory: Record<string, string>;

  /* Context Zones — named AI-context selections (persisted) */
  zonesByStory: Record<string, ContextZone[]>;

  /* Assistant conversation threads (persisted) */
  chatThreadsByStory: Record<string, ChatThread[]>;
  /** Active thread id per story. */
  activeThreadByStory: Record<string, string>;

  /* Cowriting presets — reusable, global (not per-story) draft-time recipes. */
  cowritePresets: CowritePreset[];

  /* Scene Director — cached per-passage AI scene reading (persisted).
     story → messageId → descriptor. See docs/SCENE_DIRECTOR.md. */
  sceneByStory: Record<string, Record<string, SceneDescriptor>>;
  /** Whether the Director pass is enabled for a story (opt-in, spends tokens). */
  directorEnabledByStory: Record<string, boolean>;

  /* Sandbox mode — AI-authored per-message presentation treatments (persisted).
     story → messageId → treatment. See SANDBOX_PLAN.md. */
  sandboxByStory: Record<string, Record<string, SandboxTreatment>>;

  /* Sandbox Studio — saved, named Style Configs + which is active at each scope
     + a master on/off, all per story (persisted). */
  sandboxConfigs: Record<string, StyleConfig[]>;
  sandboxActive: Record<string, SandboxActive>;
  sandboxEnabledByStory: Record<string, boolean>;
  /** Reader colour override applied over any Sandbox styling (per story). */
  sandboxPaletteByStory: Record<string, { text?: string; accent?: string; bg?: string }>;
  /** AI director scene cues — story → messageId → ordered cue track (persisted). */
  sandboxCuesByStory: Record<string, Record<string, SceneCue[]>>;
  /** Named, toggleable metadata for a message's built scene (like a saved View). */
  sandboxSceneByStory: Record<string, Record<string, { name: string; enabled: boolean }>>;
  /** Reader's standing direction for the Scene Director, per story (persisted). */
  sandboxGuidanceByStory: Record<string, string>;

  /** The summary pin the agentic summarizer maintains per story (for versioning
   *  across re-runs). Absent until the first summary is generated. */
  summaryPinByStory: Record<string, string>;

  /* Codex preferences (persisted) */
  codexEnabled: boolean;
  /** Use the configured OpenAI-compatible endpoint for extraction. */
  codexUseAI: boolean;
  /** Underline recognized lore words in the text. */
  codexHighlight: boolean;

  /* Transient UI */
  codexOpen: boolean;
  codexTab: EntityKind | 'notes';
  /** Focused entity in the sidebar (opened from an inline mention). */
  codexFocusId: string | null;
  multiverseOpen: boolean;
  recapSeen: Record<string, boolean>;
  /** Lens manager popover open (transient). */
  lensManagerOpen: boolean;
  /** Sheets panel open (transient). */
  sheetsOpen: boolean;
  /** Currently selected sheet id in the panel (transient). */
  currentSheetId: string | null;
  /** Right-margin pin dock visible (transient, defaults on). */
  pinDockOpen: boolean;
  /** Context Zone builder modal open (transient). */
  zoneBuilderOpen: boolean;
  /** Zone being edited in the builder; null = creating a new one. */
  editingZoneId: string | null;

  setCodexOpen: (open: boolean) => void;
  setCodexTab: (tab: EntityKind | 'notes') => void;
  setCodexFocusId: (id: string | null) => void;
  setMultiverseOpen: (open: boolean) => void;
  setCodexEnabled: (on: boolean) => void;
  setCodexUseAI: (on: boolean) => void;
  setCodexHighlight: (on: boolean) => void;
  markRecapSeen: (storyId: string) => void;

  /** Merge freshly extracted entities into a story's codex. */
  upsertEntities: (storyId: string, incoming: Omit<CodexEntity, 'id' | 'updatedAt'>[]) => void;
  /** Bump mention counters for already-known entities. */
  addMentions: (storyId: string, counts: Record<string, number>) => void;
  removeEntity: (storyId: string, entityId: string) => void;
  setScanProgress: (storyId: string, count: number) => void;
  /** Wipe and rebuild from scratch (rescans on next tick). */
  clearCodex: (storyId: string) => void;
  addReadingTime: (storyId: string, ms: number) => void;

  /* Lens actions */
  setLensOn: (storyId: string, on: boolean) => void;
  setLensManagerOpen: (open: boolean) => void;
  /** Add or replace an override for a message. */
  setOverride: (storyId: string, override: MessageOverride) => void;
  /** Remove a specific override; omit kind to remove all overrides for the message. */
  removeOverride: (storyId: string, messageId: string, kind?: MessageOverride['kind']) => void;
  /** Remove every override for a story. */
  clearOverrides: (storyId: string) => void;

  /* Sheet actions */
  setSheetsOpen: (open: boolean) => void;
  setCurrentSheetId: (id: string | null) => void;
  addSheet: (storyId: string, sheet: Omit<Sheet, 'id' | 'createdAt' | 'updatedAt'>) => void;
  updateSheet: (storyId: string, sheetId: string, updates: Partial<Omit<Sheet, 'id'>>) => void;
  removeSheet: (storyId: string, sheetId: string) => void;
  addSheetRow: (storyId: string, sheetId: string, row?: Record<string, string>) => void;
  updateSheetCell: (storyId: string, sheetId: string, rowIndex: number, column: string, value: string) => void;
  removeSheetRow: (storyId: string, sheetId: string, rowIndex: number) => void;

  /* Pin actions */
  setPinDockOpen: (open: boolean) => void;
  addPin: (storyId: string, pin: Omit<Pin, 'id' | 'createdAt'>) => void;
  updatePin: (storyId: string, pinId: string, updates: Partial<Omit<Pin, 'id'>>) => void;
  removePin: (storyId: string, pinId: string) => void;
  /** Append a new version (AI/manual) — seeds the current content as the
   *  'original' the first time — and switches the pin to show it. */
  addPinVersion: (storyId: string, pinId: string, version: Omit<PinVersion, 'createdAt'>) => void;
  /** Switch which stored version the pin displays (and feeds to AI context). */
  setPinActiveVersion: (storyId: string, pinId: string, index: number) => void;

  /* Pin set actions */
  /** Snapshot the current docked + AI-context arrangement as a new named set (becomes active). */
  createPinSet: (storyId: string, name: string) => string;
  /** Re-apply a set's docked + inContext flags across the pin pool and make it active. */
  applyPinSet: (storyId: string, setId: string) => void;
  renamePinSet: (storyId: string, setId: string, name: string) => void;
  duplicatePinSet: (storyId: string, setId: string) => string;
  removePinSet: (storyId: string, setId: string) => void;
  /** Clear the active-set marker without touching pins (setId always null here). */
  setActivePinSet: (storyId: string, setId: string | null) => void;

  /* Context Zone actions */
  setZoneBuilderOpen: (open: boolean) => void;
  /** Open the builder to edit an existing zone (or create when id is null). */
  openZoneBuilder: (zoneId: string | null) => void;
  addZone: (storyId: string, zone: Omit<ContextZone, 'id' | 'createdAt' | 'updatedAt'>) => string;
  updateZone: (storyId: string, zoneId: string, updates: Partial<Omit<ContextZone, 'id'>>) => void;
  removeZone: (storyId: string, zoneId: string) => void;

  /* Assistant thread actions */
  /** Return the active thread id for a story, creating a first thread if needed. */
  ensureActiveThread: (storyId: string) => string;
  createThread: (storyId: string, name?: string) => string;
  renameThread: (storyId: string, threadId: string, name: string) => void;
  removeThread: (storyId: string, threadId: string) => void;
  setActiveThread: (storyId: string, threadId: string) => void;
  /** Append a turn to a thread; returns the new turn's id. */
  addTurn: (storyId: string, threadId: string, turn: Omit<ChatTurn, 'id' | 'createdAt'>) => string;
  /** Append a fresh generation (swipe) to a turn and make it active. */
  appendVariant: (storyId: string, threadId: string, turnId: string, text: string) => void;
  /** Switch which variant of a turn is shown. */
  setActiveVariant: (storyId: string, threadId: string, turnId: string, index: number) => void;
  /** Drop a turn and everything after it (used when a send fails before commit). */
  removeTurnsFrom: (storyId: string, threadId: string, turnId: string) => void;

  /* Cowriting preset actions (custom presets only; built-ins live in code) */
  addCowritePreset: (preset: Omit<CowritePreset, 'id' | 'createdAt' | 'updatedAt'>) => string;
  updateCowritePreset: (id: string, updates: Partial<Omit<CowritePreset, 'id'>>) => void;
  removeCowritePreset: (id: string) => void;

  /* Scene Director actions (cache only — the enrichment call lives in
     utils/sceneDirector.ts; callers pass the descriptors here to persist). */
  setDirectorEnabled: (storyId: string, on: boolean) => void;
  /** Merge descriptors into a story's cache, keyed by message id (last wins). */
  putScenes: (storyId: string, descriptors: SceneDescriptor[]) => void;
  /** Drop one passage's descriptor (id given) or the whole story's cache. */
  clearScenes: (storyId: string, messageId?: string) => void;

  /** Store one message's AI Sandbox treatment (last wins). */
  setSandboxTreatment: (storyId: string, messageId: string, treatment: SandboxTreatment) => void;
  /** Drop one message's treatment (id given) or the whole story's. */
  clearSandboxTreatment: (storyId: string, messageId?: string) => void;

  /* Sandbox Studio config library + assignment + master toggle. */
  addSandboxConfig: (storyId: string, config: StyleConfig) => void;
  updateSandboxConfig: (storyId: string, id: string, patch: Partial<StyleConfig>) => void;
  deleteSandboxConfig: (storyId: string, id: string) => void;
  /** Assign a config at a scope. `targetKey` is the chainId/messageId for those scopes. */
  setSandboxActive: (storyId: string, scope: SandboxScope, configId: string, targetKey?: string) => void;
  /** Unassign at a scope (targetKey for chain/message). */
  clearSandboxActive: (storyId: string, scope: SandboxScope, targetKey?: string) => void;
  setSandboxEnabled: (storyId: string, on: boolean) => void;
  /** Patch the reader colour override (pass {} / undefined values to clear). */
  setSandboxPalette: (storyId: string, patch: { text?: string; accent?: string; bg?: string }) => void;
  /** Store one message's directed scene cue track (last wins). */
  setSandboxCues: (storyId: string, messageId: string, cues: SceneCue[]) => void;
  /** Drop cues for one message, or the whole story when messageId is omitted. */
  clearSandboxCues: (storyId: string, messageId?: string) => void;
  /** Name a message's scene (registers it as a toggleable performance). */
  setSandboxScene: (storyId: string, messageId: string, meta: { name: string; enabled: boolean }) => void;
  /** Flip a scene on/off without discarding its cues. */
  toggleSandboxScene: (storyId: string, messageId: string, on: boolean) => void;
  /** Set the reader's standing Scene Director guidance for a story. */
  setSandboxGuidance: (storyId: string, guidance: string) => void;

  /** Remember which pin holds a story's generated summary (or clear it). */
  setSummaryPin: (storyId: string, pinId: string | null) => void;

  /* Annotation actions */
  addAnnotation: (storyId: string, annotation: Omit<Annotation, 'id' | 'createdAt' | 'updatedAt'>) => void;
  updateAnnotation: (storyId: string, annotationId: string, updates: Partial<Omit<Annotation, 'id'>>) => void;
  removeAnnotation: (storyId: string, annotationId: string) => void;

  /** Snap the reader to a multiverse node (scene or alternate version). */
  selectGraphNode: (data: MvSceneData | MvVariantData) => void;
}

const newId = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** Keep only the most recently touched stories so the codex can't grow unbounded. */
const pruneStories = <T,>(map: Record<string, T>, keep: string[]): Record<string, T> => {
  const keys = Object.keys(map);
  if (keys.length <= MAX_TRACKED_STORIES) return map;
  const keepSet = new Set(keep.slice(0, MAX_TRACKED_STORIES));
  const out: Record<string, T> = {};
  keys.forEach(k => { if (keepSet.has(k)) out[k] = map[k]; });
  return out;
};

/** Keep the active set a faithful mirror of the live docked/inContext flags,
 *  so any toggle the reader makes (including the AI-context Bot button) is
 *  captured in the set they're currently on. */
const mirrorActiveSet = (sets: PinSet[], activeId: string, pins: Pin[]): PinSet[] => {
  const docked = pins.filter(p => p.docked).map(p => p.id);
  const inContext = pins.filter(p => p.inContext).map(p => p.id);
  return sets.map(s => (s.id === activeId ? { ...s, docked, inContext, updatedAt: Date.now() } : s));
};

export const useAuraV2Store = create<AuraV2State>()(
  persist(
    (set, get) => ({
      codexByStory: {},
      scanProgress: {},
      statsByStory: {},

      overridesByStory: {},
      lensOnByStory: {},

      sheetsByStory: {},
      annotationsByStory: {},
      sfxMarksByStory: {},
      pinsByStory: {},
      pinSetsByStory: {},
      activePinSetByStory: {},
      zonesByStory: {},
      chatThreadsByStory: {},
      activeThreadByStory: {},
      cowritePresets: [],
      sceneByStory: {},
      sandboxByStory: {},
      sandboxConfigs: {},
      sandboxActive: {},
      sandboxEnabledByStory: {},
      sandboxPaletteByStory: {},
      sandboxCuesByStory: {},
      sandboxSceneByStory: {},
      sandboxGuidanceByStory: {},
      directorEnabledByStory: {},
      summaryPinByStory: {},

      codexEnabled: true,
      codexUseAI: false,
      codexHighlight: true,

      codexOpen: false,
      codexTab: 'character',
      codexFocusId: null,
      multiverseOpen: false,
      recapSeen: {},
      lensManagerOpen: false,
      sheetsOpen: false,
      currentSheetId: null,
      pinDockOpen: true,
      zoneBuilderOpen: false,
      editingZoneId: null,

      setCodexOpen: (codexOpen) => set({ codexOpen, ...(codexOpen ? {} : { codexFocusId: null }) }),
      setCodexTab: (codexTab) => set({ codexTab }),
      setCodexFocusId: (codexFocusId) => set({ codexFocusId }),
      setMultiverseOpen: (multiverseOpen) => set({ multiverseOpen }),
      setCodexEnabled: (codexEnabled) => set({ codexEnabled }),
      setCodexUseAI: (codexUseAI) => set({ codexUseAI }),
      setCodexHighlight: (codexHighlight) => set({ codexHighlight }),
      markRecapSeen: (storyId) =>
        set({ recapSeen: { ...get().recapSeen, [storyId]: true } }),

      upsertEntities: (storyId, incoming) => {
        if (incoming.length === 0) return;
        const existing = get().codexByStory[storyId] ?? [];
        const byName = new Map<string, CodexEntity>();
        existing.forEach(e => {
          byName.set(normName(e.name), e);
          e.aliases.forEach(a => byName.set(normName(a), e));
        });

        const next = [...existing];
        const now = Date.now();

        incoming.forEach(inc => {
          const hit = byName.get(normName(inc.name))
            ?? inc.aliases.map(a => byName.get(normName(a))).find(Boolean);
          if (hit) {
            const idx = next.findIndex(e => e.id === hit.id);
            if (idx === -1) return;
            // Higher-trust sources refine what lower ones wrote, never the
            // other way round: card (author) > ai > heuristic.
            const upgrade = SOURCE_RANK[inc.source] >= SOURCE_RANK[hit.source];
            const better = upgrade && inc.summary.length > 12;
            next[idx] = {
              ...hit,
              kind: upgrade ? inc.kind : hit.kind,
              summary: better ? inc.summary : hit.summary,
              aliases: [...new Set([...hit.aliases, ...inc.aliases, inc.name].filter(
                a => normName(a) !== normName(hit.name),
              ))].slice(0, 6),
              mentions: hit.mentions + Math.max(1, inc.mentions),
              source: upgrade ? inc.source : hit.source,
              updatedAt: now,
            };
          } else if (next.length < MAX_ENTITIES_PER_STORY) {
            const entity: CodexEntity = { ...inc, id: newId(), updatedAt: now };
            next.push(entity);
            byName.set(normName(entity.name), entity);
            entity.aliases.forEach(a => byName.set(normName(a), entity));
          }
        });

        const touched = [storyId, ...Object.keys(get().codexByStory).filter(k => k !== storyId)];
        set({
          codexByStory: pruneStories({ ...get().codexByStory, [storyId]: next }, touched),
        });
      },

      addMentions: (storyId, counts) => {
        const list = get().codexByStory[storyId];
        if (!list || Object.keys(counts).length === 0) return;
        set({
          codexByStory: {
            ...get().codexByStory,
            [storyId]: list.map(e =>
              counts[e.id] ? { ...e, mentions: e.mentions + counts[e.id] } : e),
          },
        });
      },

      removeEntity: (storyId, entityId) => {
        const list = get().codexByStory[storyId];
        if (!list) return;
        set({
          codexByStory: {
            ...get().codexByStory,
            [storyId]: list.filter(e => e.id !== entityId),
          },
        });
      },

      setScanProgress: (storyId, count) =>
        set({ scanProgress: { ...get().scanProgress, [storyId]: count } }),

      clearCodex: (storyId) => {
        const codex = { ...get().codexByStory };
        const scan = { ...get().scanProgress };
        delete codex[storyId];
        delete scan[storyId];
        set({ codexByStory: codex, scanProgress: scan, codexFocusId: null });
      },

      addReadingTime: (storyId, ms) => {
        const prev = get().statsByStory[storyId] ?? { msRead: 0, lastReadAt: 0 };
        set({
          statsByStory: {
            ...get().statsByStory,
            [storyId]: { msRead: prev.msRead + ms, lastReadAt: Date.now() },
          },
        });
      },

      setLensOn: (storyId, on) => {
        set({ lensOnByStory: { ...get().lensOnByStory, [storyId]: on } });
      },
      setLensManagerOpen: (lensManagerOpen) => set({ lensManagerOpen }),
      setOverride: (storyId, override) => {
        const existing = get().overridesByStory[storyId] ?? [];
        const idx = existing.findIndex(
          o => o.messageId === override.messageId && o.kind === override.kind,
        );
        const next = idx === -1
          ? [...existing, override]
          : existing.map((o, i) => (i === idx ? override : o));
        const pruned = next.length > MAX_OVERRIDES_PER_STORY
          ? next.slice(next.length - MAX_OVERRIDES_PER_STORY)
          : next;
        const touched = [storyId, ...Object.keys(get().overridesByStory).filter(k => k !== storyId)];
        set({
          overridesByStory: pruneStories({ ...get().overridesByStory, [storyId]: pruned }, touched),
          lensOnByStory: { ...get().lensOnByStory, [storyId]: true },
        });
      },
      removeOverride: (storyId, messageId, kind) => {
        const existing = get().overridesByStory[storyId];
        if (!existing) return;
        const next = kind
          ? existing.filter(o => !(o.messageId === messageId && o.kind === kind))
          : existing.filter(o => o.messageId !== messageId);
        const all = { ...get().overridesByStory, [storyId]: next };
        if (next.length === 0) delete all[storyId];
        set({ overridesByStory: all });
      },
      clearOverrides: (storyId) => {
        const all = { ...get().overridesByStory };
        delete all[storyId];
        set({ overridesByStory: all });
      },

      setSheetsOpen: (sheetsOpen) => set({ sheetsOpen }),
      setCurrentSheetId: (currentSheetId) => set({ currentSheetId }),
      addSheet: (storyId, sheet) => {
        const now = Date.now();
        const next: Sheet = { ...sheet, id: newId(), createdAt: now, updatedAt: now };
        const list = [...(get().sheetsByStory[storyId] ?? []), next];
        const touched = [storyId, ...Object.keys(get().sheetsByStory).filter(k => k !== storyId)];
        set({
          sheetsByStory: pruneStories({ ...get().sheetsByStory, [storyId]: list }, touched),
          currentSheetId: next.id,
        });
      },
      updateSheet: (storyId, sheetId, updates) => {
        const list = get().sheetsByStory[storyId];
        if (!list) return;
        set({
          sheetsByStory: {
            ...get().sheetsByStory,
            [storyId]: list.map(s =>
              s.id === sheetId ? { ...s, ...updates, updatedAt: Date.now() } : s),
          },
        });
      },
      removeSheet: (storyId, sheetId) => {
        const list = get().sheetsByStory[storyId];
        if (!list) return;
        const next = list.filter(s => s.id !== sheetId);
        const all = { ...get().sheetsByStory, [storyId]: next };
        if (next.length === 0) delete all[storyId];
        set({
          sheetsByStory: all,
          currentSheetId: get().currentSheetId === sheetId ? null : get().currentSheetId,
        });
      },
      addSheetRow: (storyId, sheetId, row) => {
        const list = get().sheetsByStory[storyId];
        if (!list) return;
        set({
          sheetsByStory: {
            ...get().sheetsByStory,
            [storyId]: list.map(s =>
              s.id === sheetId
                ? { ...s, rows: [...s.rows, row ?? {}], updatedAt: Date.now() }
                : s),
          },
        });
      },
      updateSheetCell: (storyId, sheetId, rowIndex, column, value) => {
        const list = get().sheetsByStory[storyId];
        if (!list) return;
        set({
          sheetsByStory: {
            ...get().sheetsByStory,
            [storyId]: list.map(s =>
              s.id === sheetId
                ? {
                    ...s,
                    rows: s.rows.map((r, i) =>
                      i === rowIndex ? { ...r, [column]: value } : r),
                    updatedAt: Date.now(),
                  }
                : s),
          },
        });
      },
      removeSheetRow: (storyId, sheetId, rowIndex) => {
        const list = get().sheetsByStory[storyId];
        if (!list) return;
        set({
          sheetsByStory: {
            ...get().sheetsByStory,
            [storyId]: list.map(s =>
              s.id === sheetId
                ? { ...s, rows: s.rows.filter((_, i) => i !== rowIndex), updatedAt: Date.now() }
                : s),
          },
        });
      },

      setPinDockOpen: (pinDockOpen) => set({ pinDockOpen }),
      addPin: (storyId, pin) => {
        const list = get().pinsByStory[storyId] ?? [];
        if (list.length >= MAX_PINS_PER_STORY) return;
        const next: Pin = {
          ...pin,
          content: pin.content.slice(0, MAX_PIN_CONTENT),
          id: newId(),
          createdAt: Date.now(),
        };
        const touched = [storyId, ...Object.keys(get().pinsByStory).filter(k => k !== storyId)];
        const nextList = [...list, next];
        const patch: Partial<AuraV2State> = {
          pinsByStory: pruneStories({ ...get().pinsByStory, [storyId]: nextList }, touched),
        };
        const activeId = get().activePinSetByStory[storyId];
        if (activeId) {
          patch.pinSetsByStory = {
            ...get().pinSetsByStory,
            [storyId]: mirrorActiveSet(get().pinSetsByStory[storyId] ?? [], activeId, nextList),
          };
        }
        set(patch);
      },
      updatePin: (storyId, pinId, updates) => {
        const list = get().pinsByStory[storyId];
        if (!list) return;
        const nextList = list.map(p => (p.id === pinId ? { ...p, ...updates } : p));
        const patch: Partial<AuraV2State> = {
          pinsByStory: { ...get().pinsByStory, [storyId]: nextList },
        };
        // A change to what's shown or fed to the AI flows into the active set.
        const activeId = get().activePinSetByStory[storyId];
        if (activeId && ('docked' in updates || 'inContext' in updates)) {
          patch.pinSetsByStory = {
            ...get().pinSetsByStory,
            [storyId]: mirrorActiveSet(get().pinSetsByStory[storyId] ?? [], activeId, nextList),
          };
        }
        set(patch);
      },
      removePin: (storyId, pinId) => {
        const list = get().pinsByStory[storyId];
        if (!list) return;
        const next = list.filter(p => p.id !== pinId);
        const all = { ...get().pinsByStory, [storyId]: next };
        if (next.length === 0) delete all[storyId];
        const patch: Partial<AuraV2State> = { pinsByStory: all };
        // Drop the deleted pin from every set so stale ids can't linger.
        const sets = get().pinSetsByStory[storyId];
        if (sets?.some(s => s.docked.includes(pinId) || s.inContext.includes(pinId))) {
          patch.pinSetsByStory = {
            ...get().pinSetsByStory,
            [storyId]: sets.map(s => ({
              ...s,
              docked: s.docked.filter(id => id !== pinId),
              inContext: s.inContext.filter(id => id !== pinId),
            })),
          };
        }
        set(patch);
      },

      addPinVersion: (storyId, pinId, version) => {
        const list = get().pinsByStory[storyId];
        if (!list) return;
        const now = Date.now();
        const nextList = list.map(p => {
          if (p.id !== pinId) return p;
          // First edit: capture what's currently shown as the 'original'.
          const base: PinVersion[] = p.versions?.length
            ? p.versions
            : [{ content: p.content, source: 'original', createdAt: p.createdAt }];
          const added: PinVersion = {
            ...version,
            content: version.content.slice(0, MAX_PIN_CONTENT),
            createdAt: now,
          };
          const all = [...base, added];
          // Trim to the cap but always keep the original (index 0).
          const versions = all.length > MAX_PIN_VERSIONS
            ? [all[0], ...all.slice(all.length - (MAX_PIN_VERSIONS - 1))]
            : all;
          return { ...p, versions, activeVersion: versions.length - 1, content: added.content };
        });
        set({ pinsByStory: { ...get().pinsByStory, [storyId]: nextList } });
      },
      setPinActiveVersion: (storyId, pinId, index) => {
        const list = get().pinsByStory[storyId];
        if (!list) return;
        const nextList = list.map(p =>
          (p.id === pinId && p.versions && p.versions[index]
            ? { ...p, activeVersion: index, content: p.versions[index].content }
            : p));
        set({ pinsByStory: { ...get().pinsByStory, [storyId]: nextList } });
      },

      createPinSet: (storyId, name) => {
        const sets = get().pinSetsByStory[storyId] ?? [];
        if (sets.length >= MAX_PIN_SETS_PER_STORY) return '';
        const pins = get().pinsByStory[storyId] ?? [];
        const now = Date.now();
        const next: PinSet = {
          id: newId(),
          name: name.trim() || `Set ${sets.length + 1}`,
          docked: pins.filter(p => p.docked).map(p => p.id),
          inContext: pins.filter(p => p.inContext).map(p => p.id),
          createdAt: now,
          updatedAt: now,
        };
        set({
          pinSetsByStory: { ...get().pinSetsByStory, [storyId]: [...sets, next] },
          activePinSetByStory: { ...get().activePinSetByStory, [storyId]: next.id },
        });
        return next.id;
      },
      applyPinSet: (storyId, setId) => {
        const target = (get().pinSetsByStory[storyId] ?? []).find(s => s.id === setId);
        if (!target) return;
        const list = get().pinsByStory[storyId];
        const patch: Partial<AuraV2State> = {
          activePinSetByStory: { ...get().activePinSetByStory, [storyId]: setId },
        };
        if (list) {
          patch.pinsByStory = {
            ...get().pinsByStory,
            [storyId]: list.map(p => ({
              ...p,
              docked: target.docked.includes(p.id),
              inContext: target.inContext.includes(p.id),
            })),
          };
        }
        set(patch);
      },
      renamePinSet: (storyId, setId, name) => {
        const sets = get().pinSetsByStory[storyId];
        if (!sets) return;
        set({
          pinSetsByStory: {
            ...get().pinSetsByStory,
            [storyId]: sets.map(s => (s.id === setId ? { ...s, name: name.trim() || s.name, updatedAt: Date.now() } : s)),
          },
        });
      },
      duplicatePinSet: (storyId, setId) => {
        const sets = get().pinSetsByStory[storyId] ?? [];
        const src = sets.find(s => s.id === setId);
        if (!src || sets.length >= MAX_PIN_SETS_PER_STORY) return '';
        const now = Date.now();
        const copy: PinSet = {
          ...src,
          id: newId(),
          name: `${src.name} copy`,
          docked: [...src.docked],
          inContext: [...src.inContext],
          createdAt: now,
          updatedAt: now,
        };
        set({ pinSetsByStory: { ...get().pinSetsByStory, [storyId]: [...sets, copy] } });
        return copy.id;
      },
      removePinSet: (storyId, setId) => {
        const sets = get().pinSetsByStory[storyId];
        if (!sets) return;
        const nextSets = sets.filter(s => s.id !== setId);
        const setsMap = { ...get().pinSetsByStory, [storyId]: nextSets };
        if (nextSets.length === 0) delete setsMap[storyId];
        const active = { ...get().activePinSetByStory };
        if (active[storyId] === setId) delete active[storyId];
        set({ pinSetsByStory: setsMap, activePinSetByStory: active });
      },
      setActivePinSet: (storyId, setId) => {
        const active = { ...get().activePinSetByStory };
        if (setId) active[storyId] = setId;
        else delete active[storyId];
        set({ activePinSetByStory: active });
      },

      setZoneBuilderOpen: (zoneBuilderOpen) =>
        set({ zoneBuilderOpen, ...(zoneBuilderOpen ? {} : { editingZoneId: null }) }),
      openZoneBuilder: (editingZoneId) => set({ editingZoneId, zoneBuilderOpen: true }),
      addZone: (storyId, zone) => {
        const now = Date.now();
        const next: ContextZone = { ...zone, id: newId(), createdAt: now, updatedAt: now };
        const list = [...(get().zonesByStory[storyId] ?? []), next].slice(-MAX_ZONES_PER_STORY);
        const touched = [storyId, ...Object.keys(get().zonesByStory).filter(k => k !== storyId)];
        set({
          zonesByStory: pruneStories({ ...get().zonesByStory, [storyId]: list }, touched),
        });
        return next.id;
      },
      updateZone: (storyId, zoneId, updates) => {
        const list = get().zonesByStory[storyId];
        if (!list) return;
        set({
          zonesByStory: {
            ...get().zonesByStory,
            [storyId]: list.map(z =>
              z.id === zoneId ? { ...z, ...updates, updatedAt: Date.now() } : z),
          },
        });
      },
      removeZone: (storyId, zoneId) => {
        const list = get().zonesByStory[storyId];
        if (!list) return;
        const next = list.filter(z => z.id !== zoneId);
        const all = { ...get().zonesByStory, [storyId]: next };
        if (next.length === 0) delete all[storyId];
        set({ zonesByStory: all });
      },

      ensureActiveThread: (storyId) => {
        const threads = get().chatThreadsByStory[storyId] ?? [];
        const activeId = get().activeThreadByStory[storyId];
        if (activeId && threads.some(t => t.id === activeId)) return activeId;
        if (threads.length) {
          set({ activeThreadByStory: { ...get().activeThreadByStory, [storyId]: threads[0].id } });
          return threads[0].id;
        }
        return get().createThread(storyId);
      },
      createThread: (storyId, name) => {
        const now = Date.now();
        const existing = get().chatThreadsByStory[storyId] ?? [];
        const thread: ChatThread = {
          id: newId(),
          name: name?.trim() || `Chat ${existing.length + 1}`,
          turns: [],
          createdAt: now,
          updatedAt: now,
        };
        const list = [...existing, thread].slice(-MAX_THREADS_PER_STORY);
        const touched = [storyId, ...Object.keys(get().chatThreadsByStory).filter(k => k !== storyId)];
        set({
          chatThreadsByStory: pruneStories({ ...get().chatThreadsByStory, [storyId]: list }, touched),
          activeThreadByStory: { ...get().activeThreadByStory, [storyId]: thread.id },
        });
        return thread.id;
      },
      renameThread: (storyId, threadId, name) => {
        const list = get().chatThreadsByStory[storyId];
        if (!list) return;
        set({
          chatThreadsByStory: {
            ...get().chatThreadsByStory,
            [storyId]: list.map(t =>
              t.id === threadId ? { ...t, name: name.trim() || t.name, updatedAt: Date.now() } : t),
          },
        });
      },
      removeThread: (storyId, threadId) => {
        const list = get().chatThreadsByStory[storyId];
        if (!list) return;
        const next = list.filter(t => t.id !== threadId);
        const threads = { ...get().chatThreadsByStory, [storyId]: next };
        if (next.length === 0) delete threads[storyId];
        const active = { ...get().activeThreadByStory };
        if (active[storyId] === threadId) {
          if (next.length) active[storyId] = next[next.length - 1].id;
          else delete active[storyId];
        }
        set({ chatThreadsByStory: threads, activeThreadByStory: active });
      },
      setActiveThread: (storyId, threadId) =>
        set({ activeThreadByStory: { ...get().activeThreadByStory, [storyId]: threadId } }),
      addTurn: (storyId, threadId, turn) => {
        const id = newId();
        const full: ChatTurn = { ...turn, id, createdAt: Date.now() };
        const list = get().chatThreadsByStory[storyId];
        if (!list) return id;
        set({
          chatThreadsByStory: {
            ...get().chatThreadsByStory,
            [storyId]: list.map(t =>
              t.id === threadId
                ? { ...t, turns: [...t.turns, full].slice(-MAX_TURNS_PER_THREAD), updatedAt: Date.now() }
                : t),
          },
        });
        return id;
      },
      appendVariant: (storyId, threadId, turnId, text) => {
        const list = get().chatThreadsByStory[storyId];
        if (!list) return;
        set({
          chatThreadsByStory: {
            ...get().chatThreadsByStory,
            [storyId]: list.map(t =>
              t.id === threadId
                ? {
                    ...t, updatedAt: Date.now(),
                    turns: t.turns.map(tr =>
                      tr.id === turnId
                        ? { ...tr, variants: [...tr.variants, text], activeVariant: tr.variants.length }
                        : tr),
                  }
                : t),
          },
        });
      },
      setActiveVariant: (storyId, threadId, turnId, index) => {
        const list = get().chatThreadsByStory[storyId];
        if (!list) return;
        set({
          chatThreadsByStory: {
            ...get().chatThreadsByStory,
            [storyId]: list.map(t =>
              t.id === threadId
                ? {
                    ...t,
                    turns: t.turns.map(tr =>
                      tr.id === turnId && index >= 0 && index < tr.variants.length
                        ? { ...tr, activeVariant: index }
                        : tr),
                  }
                : t),
          },
        });
      },
      removeTurnsFrom: (storyId, threadId, turnId) => {
        const list = get().chatThreadsByStory[storyId];
        if (!list) return;
        set({
          chatThreadsByStory: {
            ...get().chatThreadsByStory,
            [storyId]: list.map(t => {
              if (t.id !== threadId) return t;
              const idx = t.turns.findIndex(tr => tr.id === turnId);
              return idx === -1 ? t : { ...t, turns: t.turns.slice(0, idx), updatedAt: Date.now() };
            }),
          },
        });
      },

      addCowritePreset: (preset) => {
        const now = Date.now();
        const next: CowritePreset = { ...preset, builtIn: false, id: newId(), createdAt: now, updatedAt: now };
        set({ cowritePresets: [...get().cowritePresets, next] });
        return next.id;
      },
      updateCowritePreset: (id, updates) => {
        set({
          cowritePresets: get().cowritePresets.map(p =>
            (p.id === id && !p.builtIn ? { ...p, ...updates, updatedAt: Date.now() } : p)),
        });
      },
      removeCowritePreset: (id) => {
        set({ cowritePresets: get().cowritePresets.filter(p => p.id !== id) });
      },

      setDirectorEnabled: (storyId, on) => {
        const next = { ...get().directorEnabledByStory };
        if (on) next[storyId] = true; else delete next[storyId];
        set({ directorEnabledByStory: next });
      },
      putScenes: (storyId, descriptors) => {
        if (descriptors.length === 0) return;
        const existing = get().sceneByStory[storyId] ?? {};
        const merged = { ...existing };
        for (const d of descriptors) merged[d.messageId] = d;
        set({ sceneByStory: { ...get().sceneByStory, [storyId]: merged } });
      },
      clearScenes: (storyId, messageId) => {
        const all = { ...get().sceneByStory };
        if (messageId == null) {
          delete all[storyId];
        } else {
          const forStory = { ...(all[storyId] ?? {}) };
          delete forStory[messageId];
          if (Object.keys(forStory).length === 0) delete all[storyId];
          else all[storyId] = forStory;
        }
        set({ sceneByStory: all });
      },
      setSandboxTreatment: (storyId, messageId, treatment) => {
        const forStory = { ...(get().sandboxByStory[storyId] ?? {}), [messageId]: treatment };
        set({ sandboxByStory: { ...get().sandboxByStory, [storyId]: forStory } });
      },
      clearSandboxTreatment: (storyId, messageId) => {
        const all = { ...get().sandboxByStory };
        if (messageId == null) {
          delete all[storyId];
        } else {
          const forStory = { ...(all[storyId] ?? {}) };
          delete forStory[messageId];
          if (Object.keys(forStory).length === 0) delete all[storyId];
          else all[storyId] = forStory;
        }
        set({ sandboxByStory: all });
      },

      addSandboxConfig: (storyId, config) => {
        const list = get().sandboxConfigs[storyId] ?? [];
        set({ sandboxConfigs: { ...get().sandboxConfigs, [storyId]: [...list, config] } });
      },
      updateSandboxConfig: (storyId, id, patch) => {
        const list = get().sandboxConfigs[storyId] ?? [];
        set({
          sandboxConfigs: {
            ...get().sandboxConfigs,
            [storyId]: list.map(c => (c.id === id ? { ...c, ...patch, updatedAt: Date.now() } : c)),
          },
        });
      },
      deleteSandboxConfig: (storyId, id) => {
        const list = (get().sandboxConfigs[storyId] ?? []).filter(c => c.id !== id);
        // Also drop any assignment that pointed at it.
        const active: SandboxActive = { ...(get().sandboxActive[storyId] ?? {}) };
        if (active.chat === id) delete active.chat;
        if (active.chains) active.chains = Object.fromEntries(Object.entries(active.chains).filter(([, v]) => v !== id));
        if (active.messages) active.messages = Object.fromEntries(Object.entries(active.messages).filter(([, v]) => v !== id));
        set({
          sandboxConfigs: { ...get().sandboxConfigs, [storyId]: list },
          sandboxActive: { ...get().sandboxActive, [storyId]: active },
        });
      },
      setSandboxActive: (storyId, scope, configId, targetKey) => {
        const active: SandboxActive = { ...(get().sandboxActive[storyId] ?? {}) };
        if (scope === 'chat') active.chat = configId;
        else if (scope === 'chain') active.chains = { ...(active.chains ?? {}), [targetKey!]: configId };
        else active.messages = { ...(active.messages ?? {}), [targetKey!]: configId };
        set({ sandboxActive: { ...get().sandboxActive, [storyId]: active } });
      },
      clearSandboxActive: (storyId, scope, targetKey) => {
        const active: SandboxActive = { ...(get().sandboxActive[storyId] ?? {}) };
        if (scope === 'chat') delete active.chat;
        else if (scope === 'chain' && active.chains) { const c = { ...active.chains }; delete c[targetKey!]; active.chains = c; }
        else if (scope === 'message' && active.messages) { const m = { ...active.messages }; delete m[targetKey!]; active.messages = m; }
        set({ sandboxActive: { ...get().sandboxActive, [storyId]: active } });
      },
      setSandboxEnabled: (storyId, on) => {
        set({ sandboxEnabledByStory: { ...get().sandboxEnabledByStory, [storyId]: on } });
      },
      setSandboxPalette: (storyId, patch) => {
        const next = { ...(get().sandboxPaletteByStory[storyId] ?? {}), ...patch };
        for (const k of Object.keys(next) as (keyof typeof next)[]) if (!next[k]) delete next[k];
        set({ sandboxPaletteByStory: { ...get().sandboxPaletteByStory, [storyId]: next } });
      },
      setSandboxCues: (storyId, messageId, cues) => {
        const forStory = { ...(get().sandboxCuesByStory[storyId] ?? {}) };
        if (cues.length) forStory[messageId] = cues; else delete forStory[messageId];
        set({ sandboxCuesByStory: { ...get().sandboxCuesByStory, [storyId]: forStory } });
      },
      clearSandboxCues: (storyId, messageId) => {
        const all = { ...get().sandboxCuesByStory };
        const scenes = { ...get().sandboxSceneByStory };
        if (messageId == null) { delete all[storyId]; delete scenes[storyId]; }
        else {
          const forStory = { ...(all[storyId] ?? {}) };
          delete forStory[messageId];
          all[storyId] = forStory;
          const sForStory = { ...(scenes[storyId] ?? {}) };
          delete sForStory[messageId];
          scenes[storyId] = sForStory;
        }
        set({ sandboxCuesByStory: all, sandboxSceneByStory: scenes });
      },
      setSandboxScene: (storyId, messageId, meta) => {
        const forStory = { ...(get().sandboxSceneByStory[storyId] ?? {}), [messageId]: meta };
        set({ sandboxSceneByStory: { ...get().sandboxSceneByStory, [storyId]: forStory } });
      },
      toggleSandboxScene: (storyId, messageId, on) => {
        const cur = get().sandboxSceneByStory[storyId]?.[messageId];
        if (!cur) return;
        const forStory = { ...(get().sandboxSceneByStory[storyId] ?? {}), [messageId]: { ...cur, enabled: on } };
        set({ sandboxSceneByStory: { ...get().sandboxSceneByStory, [storyId]: forStory } });
      },
      setSandboxGuidance: (storyId, guidance) => {
        set({ sandboxGuidanceByStory: { ...get().sandboxGuidanceByStory, [storyId]: guidance } });
      },
      setSummaryPin: (storyId, pinId) => {
        const next = { ...get().summaryPinByStory };
        if (pinId) next[storyId] = pinId; else delete next[storyId];
        set({ summaryPinByStory: next });
      },

      addSfxMark: (storyId, messageId, mark) => {
        const byMsg = get().sfxMarksByStory[storyId] ?? {};
        const list = [...(byMsg[messageId] ?? []), { ...mark, id: newId() }];
        set({ sfxMarksByStory: { ...get().sfxMarksByStory, [storyId]: { ...byMsg, [messageId]: list } } });
      },
      removeSfxMark: (storyId, messageId, markId) => {
        const byMsg = get().sfxMarksByStory[storyId];
        if (!byMsg?.[messageId]) return;
        set({ sfxMarksByStory: { ...get().sfxMarksByStory, [storyId]: { ...byMsg, [messageId]: byMsg[messageId].filter(m => m.id !== markId) } } });
      },

      addAnnotation: (storyId, annotation) => {
        const now = Date.now();
        const next: Annotation = { ...annotation, id: newId(), createdAt: now, updatedAt: now };
        const list = [...(get().annotationsByStory[storyId] ?? []), next];
        const touched = [storyId, ...Object.keys(get().annotationsByStory).filter(k => k !== storyId)];
        set({
          annotationsByStory: pruneStories({ ...get().annotationsByStory, [storyId]: list }, touched),
        });
      },
      updateAnnotation: (storyId, annotationId, updates) => {
        const list = get().annotationsByStory[storyId];
        if (!list) return;
        set({
          annotationsByStory: {
            ...get().annotationsByStory,
            [storyId]: list.map(a =>
              a.id === annotationId ? { ...a, ...updates, updatedAt: Date.now() } : a),
          },
        });
      },
      removeAnnotation: (storyId, annotationId) => {
        const list = get().annotationsByStory[storyId];
        if (!list) return;
        const next = list.filter(a => a.id !== annotationId);
        const all = { ...get().annotationsByStory, [storyId]: next };
        if (next.length === 0) delete all[storyId];
        set({ annotationsByStory: all });
      },

      selectGraphNode: (data) => {
        // Close the overlay first so React can commit that frame before the
        // heavy reader re-render (deep jumps can mount hundreds of messages).
        set({ multiverseOpen: false });
        React.startTransition(() => {
          const app = useAppStore.getState();
          if (data.type === 'variant') {
            // Weave the chosen version into the path, then snap the reader there.
            app.selectSwipe(data.messageId, data.swipeIndex);
          }
          if (data.messageId) app.jumpToMessage(data.messageId);
        });
      },
    }),
    {
      name: 'aura-reader-v2',
      storage: createJSONStorage(() => debouncedLocalStorage()),
      partialize: (s) => ({
        codexByStory: s.codexByStory,
        scanProgress: s.scanProgress,
        statsByStory: s.statsByStory,
        overridesByStory: s.overridesByStory,
        lensOnByStory: s.lensOnByStory,
        sheetsByStory: s.sheetsByStory,
        annotationsByStory: s.annotationsByStory,
        sfxMarksByStory: s.sfxMarksByStory,
        pinsByStory: s.pinsByStory,
        pinSetsByStory: s.pinSetsByStory,
        activePinSetByStory: s.activePinSetByStory,
        zonesByStory: s.zonesByStory,
        chatThreadsByStory: s.chatThreadsByStory,
        activeThreadByStory: s.activeThreadByStory,
        cowritePresets: s.cowritePresets,
        sceneByStory: s.sceneByStory,
        sandboxByStory: s.sandboxByStory,
        sandboxConfigs: s.sandboxConfigs,
        sandboxActive: s.sandboxActive,
        sandboxEnabledByStory: s.sandboxEnabledByStory,
        sandboxPaletteByStory: s.sandboxPaletteByStory,
        sandboxCuesByStory: s.sandboxCuesByStory,
        sandboxSceneByStory: s.sandboxSceneByStory,
        sandboxGuidanceByStory: s.sandboxGuidanceByStory,
        directorEnabledByStory: s.directorEnabledByStory,
        summaryPinByStory: s.summaryPinByStory,
        codexEnabled: s.codexEnabled,
        codexUseAI: s.codexUseAI,
        codexHighlight: s.codexHighlight,
      }),
    },
  ),
);
