import React from 'react';
import { create } from 'zustand';
import { applyOps, loadV2 } from '../lib/v2Storage';
import { alertSaveFailed } from '../utils/alerts';
import {
  addFolder as addFolderTo, assignFolder, removeFolder as removeFolderFrom,
  renameFolder as renameFolderIn, type Folder, type FolderAssignments,
} from '../utils/folders';
import { SliceBag, diffSlices, misdeclaredSlices, pickPersisted } from '../utils/v2Persist';
import { Annotation, Chain, ChatThread, ChatTurn, ContextZone, CowritePreset, Message, MessageOverride, Pin, PinSet, PinVersion, SandboxActive, SandboxScope, SandboxTreatment, SceneArt, SceneCue, SceneDescriptor, SceneEmphasis, ScenePerformCue, Sheet, StyleConfig } from '../types';
import { TasteEntry, recordTaste } from '../utils/tasteBlock';
import { useAppStore } from '../store';
import type { StoryRead } from '../utils/storyRead';
import type { PacketRecord, StylePacket } from '../utils/stylePacket';
import { readThread, type AskTurn } from '../utils/askCharacter';
import type { ReactionPoint } from '../utils/liveReaction';
import {
  addCrossing as addCrossingTo, removeCrossing as removeCrossingFrom,
  updateCrossing as updateCrossingIn, type Crossing,
} from '../utils/crossing';
import type { EmotionBucket } from '../lib/spriteStorage';
import type { Visitor } from '../utils/visitor';
import type { NarrativeFunction } from '../utils/narrativeFunction';
import type { Arc, Throughline } from '../utils/throughline';
import type { ZoneTask } from '../utils/zoneTask';
import type { ContextPocket } from '../utils/contextPocket';
import {
  MAX_PAGE_VERSIONS, activePage, activePageIndex, addPage as addBookPage, editActivePage,
  mergeInto, movePage, patchPage, removePage, syncActive, turnTo, withPages,
} from '../utils/pinBook';
import {
  moveArc as moveArcIn, orderedArcs, renumber as renumberArcs,
} from '../utils/throughline';

/* ------------------------------------------------------------------ */
/* Codex types                                                         */
/* ------------------------------------------------------------------ */

export type EntityKind = 'character' | 'location' | 'item';

/** The Codex's columns: the three kinds it extracts, plus the two the
 *  reader writes — anchored notes and tracking sheets. */
export type CodexTab = EntityKind | 'notes' | 'sheets';

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
  /** Merge priority: lorebook and card (author-written) > ai > heuristic. */
  source: 'heuristic' | 'ai' | 'card' | 'lorebook';
  /**
   * Never removed by a rebuild.
   *
   * A rebuild wipes the story's codex so the extractor can start over, which is
   * exactly right for entries the extractor MADE and exactly wrong for the ones
   * it did not: an imported lorebook is authored material that no amount of
   * re-reading will produce again, and a reader who has corrected an entry by
   * hand has done work the scan cannot repeat either. Locked entries survive
   * `clearCodex`; deleting one is still a thing the reader can do on purpose.
   */
  locked?: boolean;
}

const SOURCE_RANK: Record<CodexEntity['source'], number> = {
  heuristic: 0, ai: 1, card: 2, lorebook: 3,
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

/** Generous cap per pinned visual (~25k words) — big summary docs fit intact. */
const MAX_PIN_CONTENT = 150_000;
const MAX_ZONES_PER_STORY = 40;
/** Tasks are hand-authored and few; the cap only stops an import loop. */
const MAX_TASKS_PER_STORY = 40;
const MAX_POCKETS_PER_STORY = 24;
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

/** A reader-authored performance direction on a hand-picked span. */
export interface PerformMark extends ScenePerformCue {
  id: string;
}

/** One line the reactor actually said, at one marked moment. */
export interface SpokenReaction {
  text: string;
  emotion: EmotionBucket;
  at: number;
}

/** What the scout found in one passage, and what has been said there since. */
export interface ReactionRecord {
  messageId: string;
  /** Who was watching. A reaction belongs to them — switching companions is a
   *  different reading, not an edit of this one. */
  reactor: string;
  /** Fingerprint of the passage the moments were found in. */
  hash: string;
  points: ReactionPoint[];
  /** Spoken lines, by point id. */
  lines: Record<string, SpokenReaction>;
}

/**
 * A reader-authored typographic mark on a hand-picked span — a colour, an
 * underline, a strike.
 *
 * Kept apart from the Director's `SceneEmphasis` for the same reason SFX marks
 * are: the Director's read is rebuilt whenever a passage is edited or re-read,
 * and a reader's own marking must survive that. Merged with the Director's
 * spans at every render site, never written into the descriptor.
 */
export interface EmphasisMark extends SceneEmphasis {
  id: string;
}

interface AuraV2State {
  /* Codex data (persisted) */
  codexByStory: Record<string, CodexEntity[]>;
  /** Flat count of messages already scanned per story. */
  scanProgress: Record<string, number>;
  statsByStory: Record<string, StoryStats>;
  /**
   * Reader-assigned tags, the library's organising axis.
   *
   * Separate from `StoryMeta.tags`, which is whatever the character card
   * shipped with and is never written again — those seed this on import, and
   * from then on the two are independent. Kept here rather than on the story
   * record so renaming a tag rewrites one small row, not every message.
   */
  libraryTagsByStory: Record<string, string[]>;

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

  /* Generated scene art — story → messageId → picture METADATA (persisted).
   * The bytes live in `lib/artStorage.ts`; a megabyte per image in a slice
   * would be rewritten on every debounced save. This is annotation, not the
   * Lens: the Lens rewrites the WORDS, and a picture is not one of them. */
  artByStory: Record<string, Record<string, SceneArt[]>>;
  addSceneArt: (storyId: string, messageId: string, art: SceneArt) => void;
  removeSceneArt: (storyId: string, messageId: string, artId: string) => void;

  /* Visiting characters brought in from other chats — story → visitors
   * (persisted). NOT the Lens: the Lens rewrites existing messages, while a
   * visitor assembles context for a new generation. */
  visitorsByStory: Record<string, Visitor[]>;
  addVisitor: (storyId: string, visitor: Visitor) => void;
  updateVisitor: (storyId: string, visitorId: string, patch: Partial<Visitor>) => void;
  removeVisitor: (storyId: string, visitorId: string) => void;

  /**
   * Throughlines — one protagonist, several chats, in order.
   *
   * GLOBAL, not per-story, and that is the whole point: this is the one record
   * that belongs to the reader rather than to a chat. A story's membership is
   * its presence in an `arcs` list, so there is no second index that can
   * disagree with the first about which throughline a story is in.
   */
  /**
   * Lines drawn between two stories — see `utils/crossing.ts`.
   *
   * Global, like `throughlines` and for the same reason: a crossing belongs to
   * neither story. Filing it under story A would make it invisible from B, and
   * filing it under both would make deleting one a two-sided problem with a
   * wrong answer.
   */
  crossings: Crossing[];
  addCrossing: (c: Crossing) => void;
  updateCrossing: (id: string, patch: Partial<Omit<Crossing, 'id'>>) => void;
  removeCrossing: (id: string) => void;
  /** Which stories the branching board has on screen, in column order. */
  crossingBoard: string[];
  setCrossingBoard: (storyIds: string[]) => void;
  crossingBoardOpen: boolean;
  setCrossingBoardOpen: (open: boolean) => void;
  throughlines: Throughline[];
  addThroughline: (t: Throughline) => void;
  updateThroughline: (id: string, patch: Partial<Throughline>) => void;
  removeThroughline: (id: string) => void;
  /** Put a story into a throughline, at the end of the chronology. */
  addArc: (id: string, arc: Arc) => void;
  updateArc: (id: string, storyId: string, patch: Partial<Arc>) => void;
  removeArc: (id: string, storyId: string) => void;
  reorderArc: (id: string, storyId: string, direction: -1 | 1) => void;

  /* Per-character appearance sheets — story → character name → prompt text.
   * Prepended verbatim to every image prompt, which is the cheap 80% of making
   * the same person recognisable twice. Reader-editable by design. */
  appearanceByStory: Record<string, Record<string, string>>;
  setAppearance: (storyId: string, character: string, text: string) => void;
  /* Locked seed per character, where the backend has one. */
  artSeedByStory: Record<string, Record<string, number>>;
  setArtSeed: (storyId: string, character: string, seed: number | null) => void;

  /* Reader-authored PERFORMANCE cues — story → messageId → span directions
   * (persisted). Same shape the Director emits, so the reveal treats a
   * hand-marked span exactly like a directed one; these are applied first, so
   * a reader's call always wins over the AI's on the same words. */
  /* Reader-authored typographic marks — story → messageId → spans (persisted). */
  /**
   * The narrative-function read of each passage, cached per message.
   *
   * Same bargain as `sceneByStory`: labelling is one model call per passage,
   * decoded greedily so a re-read gives the same answer, and nothing about it
   * changes as you read — so paying for it twice is paying twice for the same
   * sentence. `hash` is the passage's content fingerprint (`hashContent`), so
   * an edited or re-swiped message re-reads itself and a cached label can never
   * end up describing prose it was not taken from.
   */
  functionsByStory: Record<string, Record<string, { hash: string; fns: NarrativeFunction[] }>>;
  setFunctionRead: (
    storyId: string, messageId: string, hash: string, fns: NarrativeFunction[],
  ) => void;

  emphasisMarksByStory: Record<string, Record<string, EmphasisMark[]>>;
  addEmphasisMark: (storyId: string, messageId: string, mark: Omit<EmphasisMark, 'id'>) => void;
  /** Drop any hand-marked span on `text` (the popover's "no treatment"). */
  clearEmphasisMarkFor: (storyId: string, messageId: string, text: string) => void;

  performMarksByStory: Record<string, Record<string, PerformMark[]>>;
  addPerformMark: (storyId: string, messageId: string, mark: Omit<PerformMark, 'id'>) => void;
  removePerformMark: (storyId: string, messageId: string, markId: string) => void;
  /** Drop any hand-marked cue on `text` (the popover's "no performance"). */
  clearPerformMarkFor: (storyId: string, messageId: string, text: string) => void;

  /**
   * Every span this reader has directed by hand, across every story (persisted,
   * global). Fed to the Director as few-shot examples — see `tasteBlock.ts` for
   * why it is a flat global log rather than something derived from the marks
   * above, and why a CLEARED mark is recorded as carefully as an added one.
   *
   * Global on purpose: taste is the reader's, not the story's, and a per-story
   * derivation could only ever see the one story currently loaded.
   */
  tasteMarks: TasteEntry[];
  /** Forget everything the Director has learned about this reader's taste. */
  clearTaste: () => void;

  /**
   * Take on the direction layer that arrived with a Cut, keyed to the id this
   * library just gave the story (see `utils/cut.ts`).
   *
   * Merges rather than replaces: the incoming story is new here, so there is
   * nothing of its own to overwrite, and merging keeps every other story's
   * share of the same slice untouched.
   */
  adoptCut: (storyId: string, wants: { slice: string; value: Record<string, unknown> }[]) => void;

  /* Pinned visuals (persisted) */
  pinsByStory: Record<string, Pin[]>;

  /* Named, swappable pin arrangements — "saved views" (persisted) */
  pinSetsByStory: Record<string, PinSet[]>;
  /** Which set is currently applied per story; absent = none. */
  activePinSetByStory: Record<string, string>;

  /* Context Zones — named AI-context selections (persisted) */
  zonesByStory: Record<string, ContextZone[]>;

  /* Zone tasks — an ORDER over zones, a fixed document shape, and the pin it
   * lands in. Persisted because the whole point is that the form outlives the
   * run: re-running a task must produce the same shape with new material. */
  tasksByStory: Record<string, ZoneTask[]>;

  /* Assistant conversation threads (persisted) */
  chatThreadsByStory: Record<string, ChatThread[]>;
  /** Active thread id per story. */
  activeThreadByStory: Record<string, string>;

  /* Cowriting presets — reusable, global (not per-story) draft-time recipes. */
  cowritePresets: CowritePreset[];

  /* Scene Director — cached per-passage AI scene reading (persisted).
     story → messageId → descriptor. See docs/SCENE_DIRECTOR.md. */
  sceneByStory: Record<string, Record<string, SceneDescriptor>>;
  /**
   * One cached whole-story read per story (persisted) — the arc, cast
   * registers, recurring places and motifs that let the per-passage read
   * weight its cues. NEVER render this: unlike the Codex it is not
   * spoiler-safe (see `utils/storyRead.ts`).
   */
  storyReadByStory: Record<string, StoryRead>;
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
  /** Interviews with a character, anchored per message — story → messageId →
   *  turns. READER-ONLY by construction: nothing here is canon, so it must never
   *  reach the Lens, an export, the Multiverse graph, or any AI context built
   *  for the Director/summarizer/assistant. Exactly one component reads it. */
  askByStory: Record<string, AskTurn[]>;

  /**
   * Live Reaction — the scout's marked moments and the lines already spoken at
   * them, per story → messageId.
   *
   * READER-ONLY on exactly the same terms as `askByStory`, and for a sharper
   * reason: this one speaks without being asked, so the boundary is the only
   * thing standing between a reading companion and a companion chat. It never
   * reaches the Lens, an export, the Multiverse graph, or any AI context built
   * for the Director/summarizer/assistant.
   *
   * `hash` fingerprints the passage the moments were found in, so an edited or
   * swiped message drops its reactions instead of firing them at offsets that
   * now point at different words.
   *
   * Keyed by `reactionKey(messageId, reactor)` — by beat AND by who was
   * watching. See that function for why.
   */
  reactionsByStory: Record<string, Record<string, ReactionRecord>>;
  setReactionPoints: (
    storyId: string, key: string,
    rec: Pick<ReactionRecord, 'messageId' | 'reactor' | 'hash' | 'points'>,
  ) => void;
  addReactionLine: (
    storyId: string, key: string, pointId: string, line: SpokenReaction,
  ) => void;
  /** Forget one point's line (a re-roll), one beat's, or the whole story's. */
  clearReactions: (storyId: string, key?: string, pointId?: string) => void;

  /** Reader's standing direction for the Scene Director, per story (persisted). */
  sandboxGuidanceByStory: Record<string, string>;
  /** That direction RESOLVED into concrete values — the brief every beat of the
   *  story is directed against. Kept beside the guidance it came from so a
   *  reworded direction can be detected as stale. See utils/stylePacket. */
  sandboxPacketByStory: Record<string, PacketRecord>;

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
  /** Which column of the Codex is showing. 'sheets' is the reader's own
   *  hand-kept tables, which moved in here from their old drawer. */
  codexTab: CodexTab;
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
  setCodexTab: (tab: CodexTab) => void;
  setCodexFocusId: (id: string | null) => void;
  setMultiverseOpen: (open: boolean) => void;
  setCodexEnabled: (on: boolean) => void;
  setCodexUseAI: (on: boolean) => void;
  setCodexHighlight: (on: boolean) => void;
  markRecapSeen: (storyId: string) => void;
  setStoryTags: (storyId: string, tags: string[]) => void;

  /* Library folders (persisted, global) — see utils/folders.ts. */
  folders: Folder[];
  /** Story id → folder id. Exclusive: a story is in one folder, or none. */
  folderByStory: FolderAssignments;
  addFolder: (name: string) => void;
  renameFolder: (id: string, name: string) => void;
  /** Remove a folder; its stories become unfiled, never deleted. */
  removeFolder: (id: string) => void;
  /** File a story, or unfile it with null. */
  setStoryFolder: (storyId: string, folderId: string | null) => void;

  /** Stamp "last read" without claiming any reading time was spent. */
  touchStory: (storyId: string) => void;

  /** Merge freshly extracted entities into a story's codex. */
  upsertEntities: (storyId: string, incoming: Omit<CodexEntity, 'id' | 'updatedAt'>[]) => void;
  /** Bump mention counters for already-known entities. */
  addMentions: (storyId: string, counts: Record<string, number>) => void;
  /** Keep (or stop keeping) an entry through a Rebuild. */
  setEntityLocked: (storyId: string, entityId: string, locked: boolean) => void;
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
  /** Returns the new pin's id, or '' when the per-story cap refused it. */
  addPin: (storyId: string, pin: Omit<Pin, 'id' | 'createdAt'>) => string;
  updatePin: (storyId: string, pinId: string, updates: Partial<Omit<Pin, 'id'>>) => void;
  removePin: (storyId: string, pinId: string) => void;
  /** Append a new version (AI/manual) — seeds the current content as the
   *  'original' the first time — and switches the pin to show it. */
  addPinVersion: (storyId: string, pinId: string, version: Omit<PinVersion, 'createdAt'>) => void;
  /** Switch which stored version the pin displays (and feeds to AI context). */
  setPinActiveVersion: (storyId: string, pinId: string, index: number) => void;
  /** Add a page to a pin, turning it into a book if it was a single note. */
  addPinPage: (storyId: string, pinId: string, page?: { title?: string; content?: string }) => void;
  updatePinPage: (
    storyId: string, pinId: string, index: number,
    patch: Partial<Pick<import('../utils/pinBook').PinPage, 'title' | 'content'>>,
  ) => void;
  /** Hand-edit the page on show. See `applyManualEdit` for the version rule. */
  editPinPage: (storyId: string, pinId: string, content: string) => void;
  setPinActivePage: (storyId: string, pinId: string, index: number) => void;
  removePinPage: (storyId: string, pinId: string, index: number) => void;
  movePinPage: (storyId: string, pinId: string, index: number, direction: -1 | 1) => void;
  /** Fold `sourceId`'s pages onto the end of `targetId`, then delete the source. */
  mergePinPages: (storyId: string, targetId: string, sourceId: string) => void;

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

  /* Zone task actions */
  /**
   * Saved context pockets — a zone with a job attached.
   *
   * Per story, like the zones they are made of: a pocket that reads "all of my
   * messages in THIS chat" means nothing in another one.
   */
  pocketsByStory: Record<string, ContextPocket[]>;
  addPocket: (storyId: string, pocket: Omit<ContextPocket, 'id' | 'createdAt' | 'updatedAt'>) => string;
  updatePocket: (storyId: string, pocketId: string, patch: Partial<Omit<ContextPocket, 'id'>>) => void;
  removePocket: (storyId: string, pocketId: string) => void;
  addTask: (storyId: string, task: Omit<ZoneTask, 'id' | 'createdAt' | 'updatedAt'>) => string;
  updateTask: (storyId: string, taskId: string, updates: Partial<Omit<ZoneTask, 'id'>>) => void;
  removeTask: (storyId: string, taskId: string) => void;
  /** Stamp what a finished run produced, so the panel can say when it last ran. */
  recordTaskRun: (storyId: string, taskId: string, sections: number, pinVersion: number | null) => void;

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
  /**
   * Rewrite the SHOWN variant of a turn in place.
   *
   * Both roles, deliberately. Editing your own question and re-asking is the
   * cheapest way to steer a model, and editing the assistant's reply is how a
   * reader keeps a mostly-right answer they are about to build on — the same
   * reasoning that makes a Lens override an edit rather than a regeneration.
   * The other variants are untouched, so a swipe still reaches the original.
   */
  editTurn: (storyId: string, threadId: string, turnId: string, text: string) => void;
  /** Remove ONE turn, leaving the rest of the thread in place. */
  removeTurn: (storyId: string, threadId: string, turnId: string) => void;

  /* Cowriting preset actions (custom presets only; built-ins live in code) */
  addCowritePreset: (preset: Omit<CowritePreset, 'id' | 'createdAt' | 'updatedAt'>) => string;
  updateCowritePreset: (id: string, updates: Partial<Omit<CowritePreset, 'id'>>) => void;
  removeCowritePreset: (id: string) => void;

  /* Scene Director actions (cache only — the enrichment call lives in
     utils/sceneDirector.ts; callers pass the descriptors here to persist). */
  setDirectorEnabled: (storyId: string, on: boolean) => void;
  /** Merge descriptors into a story's cache, keyed by message id (last wins). */
  putScenes: (storyId: string, descriptors: SceneDescriptor[]) => void;
  /** Cache this story's whole-story read. */
  putStoryRead: (storyId: string, read: StoryRead) => void;
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
  /** Append a turn to the story's running interview. */
  addAskTurn: (storyId: string, turn: AskTurn) => void;
  /** Discard the interview entirely. */
  clearAskThread: (storyId: string) => void;

  /** Set the reader's standing Scene Director guidance for a story. */
  setSandboxGuidance: (storyId: string, guidance: string) => void;
  /** Store the resolved Style Packet for a story (with the guidance it came from). */
  setSandboxPacket: (storyId: string, packet: StylePacket, guidance: string) => void;

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

/**
 * Record one hand-marked span in the reader's taste log.
 *
 * Kept as a thin pair of wrappers so every mutator that touches a mark also
 * teaches the Director, and none of them has to remember the log's shape.
 */
const learn = (log: TasteEntry[], entry: TasteEntry): TasteEntry[] => recordTaste(log, entry);

/**
 * Record that the reader took marks OFF.
 *
 * The removed marks are passed in rather than looked up, because by the time
 * this runs they are already gone from the story's slice — and a clear is the
 * single most informative thing in the log, so losing it to an ordering detail
 * would quietly halve the feature.
 */
const forget = (
  log: TasteEntry[],
  removed: readonly { text: string; kind: string }[],
  track: TasteEntry['track'],
): TasteEntry[] => {
  let next = log;
  const at = Date.now();
  for (const m of removed) next = recordTaste(next, { text: m.text, kind: m.kind, track, at, cleared: true });
  return next;
};

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
    (set, get) => ({
      codexByStory: {},
      scanProgress: {},
      statsByStory: {},
      libraryTagsByStory: {},

      overridesByStory: {},
      lensOnByStory: {},

      sheetsByStory: {},
      annotationsByStory: {},
      sfxMarksByStory: {},
      artByStory: {},
      visitorsByStory: {},
      crossings: [],
      crossingBoard: [],
      crossingBoardOpen: false,
      throughlines: [],
      appearanceByStory: {},
      artSeedByStory: {},
      functionsByStory: {},
      emphasisMarksByStory: {},
      performMarksByStory: {},
      tasteMarks: [],
      pinsByStory: {},
      pinSetsByStory: {},
      activePinSetByStory: {},
      zonesByStory: {},
      tasksByStory: {},
      pocketsByStory: {},
      chatThreadsByStory: {},
      activeThreadByStory: {},
      cowritePresets: [],
      sceneByStory: {},
      storyReadByStory: {},
      sandboxByStory: {},
      sandboxConfigs: {},
      sandboxActive: {},
      sandboxEnabledByStory: {},
      sandboxPaletteByStory: {},
      sandboxCuesByStory: {},
      sandboxSceneByStory: {},
      sandboxGuidanceByStory: {},
      sandboxPacketByStory: {},
      askByStory: {},
      reactionsByStory: {},
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
            // other way round: lorebook > card (author) > ai > heuristic.
            //
            // A LOCKED entry is a further step: its text is the reader's or the
            // author's and the scan may not rewrite it at all. It still gains
            // aliases and mention counts, because those are observations about
            // the story rather than claims about the entry.
            const upgrade = SOURCE_RANK[inc.source] >= SOURCE_RANK[hit.source];
            const better = upgrade && !hit.locked && inc.summary.length > 12;
            next[idx] = {
              ...hit,
              kind: upgrade && !hit.locked ? inc.kind : hit.kind,
              summary: better ? inc.summary : hit.summary,
              // Sticky: once locked, only the reader unlocks it.
              locked: hit.locked || inc.locked,
              aliases: [...new Set([...hit.aliases, ...inc.aliases, inc.name].filter(
                a => normName(a) !== normName(hit.name),
              ))].slice(0, 6),
              mentions: hit.mentions + Math.max(1, inc.mentions),
              source: upgrade && !hit.locked ? inc.source : hit.source,
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

      setEntityLocked: (storyId, entityId, locked) => {
        const list = get().codexByStory[storyId];
        if (!list) return;
        set({
          codexByStory: {
            ...get().codexByStory,
            [storyId]: list.map(e =>
              (e.id === entityId ? { ...e, locked, updatedAt: Date.now() } : e)),
          },
        });
        void flushV2();
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

      /**
       * Wipe what the scan produced and let it start again.
       *
       * Authored entries stay. An imported lorebook is not a guess the extractor
       * made and cannot be re-derived by reading harder, so a "Rebuild" that
       * took it out was destroying the one part of the codex the reader could
       * not get back — the card's own is re-seeded on the next tick, but a
       * lorebook imported from a file is simply gone.
       */
      clearCodex: (storyId) => {
        const codex = { ...get().codexByStory };
        const scan = { ...get().scanProgress };
        const kept = (codex[storyId] ?? []).filter(e => e.locked || e.source === 'lorebook');
        if (kept.length) codex[storyId] = kept;
        else delete codex[storyId];
        delete scan[storyId];
        set({ codexByStory: codex, scanProgress: scan, codexFocusId: null });
        void flushV2();
      },

      folders: [],
      folderByStory: {},
      addFolder: (name) => set({ folders: addFolderTo(get().folders, name) }),
      renameFolder: (id, name) => set({ folders: renameFolderIn(get().folders, id, name) }),
      removeFolder: (id) => {
        // Both halves together. A folder removed while assignments still point
        // at it leaves its stories in no view at all — see utils/folders.ts.
        const next = removeFolderFrom(get().folders, get().folderByStory, id);
        set({ folders: next.folders, folderByStory: next.assignments });
      },
      setStoryFolder: (storyId, folderId) =>
        set({ folderByStory: assignFolder(get().folderByStory, storyId, folderId) }),

      setStoryTags: (storyId, tags) => {
        // Trimmed, de-duped, case-insensitively unique, order preserved — the
        // filter UI groups by exact string, so "Romance" and "romance" as two
        // separate chips would be a bug the reader cannot see the cause of.
        const seen = new Set<string>();
        const clean: string[] = [];
        for (const t of tags) {
          const trimmed = t.trim();
          const key = trimmed.toLowerCase();
          if (!trimmed || seen.has(key)) continue;
          seen.add(key);
          clean.push(trimmed);
        }
        set({ libraryTagsByStory: { ...get().libraryTagsByStory, [storyId]: clean } });
        // Write through rather than debounce. Saves are batched on a 400ms
        // timer, and an IndexedDB write cannot hold up a page unload — fine for
        // reading position, which is re-derived constantly and cheap to lose a
        // moment of, but a tag is a deliberate, one-off edit. Tagging a story
        // and immediately closing the tab must not silently discard it.
        void flushV2();
      },

      touchStory: (storyId) => {
        const prev = get().statsByStory[storyId] ?? { msRead: 0, lastReadAt: 0 };
        set({
          statsByStory: {
            ...get().statsByStory,
            [storyId]: { ...prev, lastReadAt: Date.now() },
          },
        });
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
        void flushV2();
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
        void flushV2();
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
        void flushV2();
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
        void flushV2();
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
        // Refused at the cap. This USED to return void, and every caller then
        // reached for `pins.slice(-1)[0]` to find "the pin it just made" — which
        // at the cap is somebody else's pin. The summariser went on to mark that
        // stranger as the story's summary pin, so the next run wrote a summary
        // over an unrelated note. Returning the id (or '') is what makes the
        // failure visible to the caller instead of silently misdirecting it.
        if (list.length >= MAX_PINS_PER_STORY) return '';
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
        void flushV2();
        return next.id;
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
        void flushV2();
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
        void flushV2();
      },

      /*
       * A version is a new draft of the page you are ON.
       *
       * Once pins gained pages this had to choose, and the choice is the whole
       * point of the feature: rewriting entry eleven of a journal must not
       * produce "version 11" of entry one. So the history belongs to the page,
       * and `pinBook.patchPage` keeps the pin's own `content`/`versions` fields
       * mirroring it for everything that still reads a pin as one note.
       */
      addPinVersion: (storyId, pinId, version) => {
        const list = get().pinsByStory[storyId];
        if (!list) return;
        const now = Date.now();
        const nextList = list.map(p => {
          if (p.id !== pinId) return p;
          const at = activePageIndex(p);
          const page = activePage(p);
          // First edit: capture what's currently shown as the 'original'.
          const base: PinVersion[] = page.versions?.length
            ? page.versions
            : [{ content: page.content, source: 'original', createdAt: page.createdAt }];
          const added: PinVersion = {
            ...version,
            content: version.content.slice(0, MAX_PIN_CONTENT),
            createdAt: now,
          };
          const all = [...base, added];
          // Trim to the cap but always keep the original (index 0).
          const versions = all.length > MAX_PAGE_VERSIONS
            ? [all[0], ...all.slice(all.length - (MAX_PAGE_VERSIONS - 1))]
            : all;
          return patchPage(p, at, {
            versions, activeVersion: versions.length - 1, content: added.content,
          });
        });
        set({ pinsByStory: { ...get().pinsByStory, [storyId]: nextList } });
        void flushV2();
      },
      setPinActiveVersion: (storyId, pinId, index) => {
        const list = get().pinsByStory[storyId];
        if (!list) return;
        const nextList = list.map(p => {
          if (p.id !== pinId) return p;
          const page = activePage(p);
          if (!page.versions || !page.versions[index]) return p;
          return patchPage(p, activePageIndex(p), {
            activeVersion: index, content: page.versions[index].content,
          });
        });
        set({ pinsByStory: { ...get().pinsByStory, [storyId]: nextList } });
        void flushV2();
      },

      /* --- Pages ---------------------------------------------------------
       *
       * All five go through `utils/pinBook`, which owns the one invariant that
       * makes pages invisible to everything that has not heard of them: the
       * pin's `content` always mirrors the page on show.
       */
      addPinPage: (storyId, pinId, page) => {
        const list = get().pinsByStory[storyId];
        if (!list) return;
        const now = Date.now();
        set({
          pinsByStory: {
            ...get().pinsByStory,
            [storyId]: list.map(p => (p.id === pinId
              ? addBookPage(p, {
                id: newId(),
                title: page?.title,
                content: (page?.content ?? '').slice(0, MAX_PIN_CONTENT),
                createdAt: now,
              })
              : p)),
          },
        });
        void flushV2();
      },
      updatePinPage: (storyId, pinId, index, patch) => {
        const list = get().pinsByStory[storyId];
        if (!list) return;
        set({
          pinsByStory: {
            ...get().pinsByStory,
            [storyId]: list.map(p => (p.id === pinId
              ? patchPage(p, index, patch.content === undefined
                ? patch
                : { ...patch, content: patch.content.slice(0, MAX_PIN_CONTENT) })
              : p)),
          },
        });
        void flushV2();
      },
      /**
       * The reader typing into a pin.
       *
       * Not `updatePinPage` with a content patch, which writes over whatever is
       * there: the FIRST hand edit has to preserve the text it replaces, or a
       * pin the assistant wrote is gone the moment somebody fixes a typo in it.
       * `applyManualEdit` owns that rule and the one that follows from it —
       * every edit after the first folds into the same working version rather
       * than filling the history with keystrokes.
       */
      editPinPage: (storyId, pinId, content) => {
        const list = get().pinsByStory[storyId];
        if (!list) return;
        const capped = content.slice(0, MAX_PIN_CONTENT);
        const next = list.map(p => (p.id === pinId ? editActivePage(p, capped) : p));
        // Reference-equal when the edit changed nothing — no write, no version.
        if (next.every((p, i) => p === list[i])) return;
        set({ pinsByStory: { ...get().pinsByStory, [storyId]: next } });
        void flushV2();
      },

      setPinActivePage: (storyId, pinId, index) => {
        const list = get().pinsByStory[storyId];
        if (!list) return;
        set({
          pinsByStory: {
            ...get().pinsByStory,
            [storyId]: list.map(p => (p.id === pinId ? turnTo(p, index) : p)),
          },
        });
        void flushV2();
      },
      removePinPage: (storyId, pinId, index) => {
        const list = get().pinsByStory[storyId];
        if (!list) return;
        set({
          pinsByStory: {
            ...get().pinsByStory,
            [storyId]: list.map(p => (p.id === pinId ? removePage(p, index) : p)),
          },
        });
        void flushV2();
      },
      movePinPage: (storyId, pinId, index, direction) => {
        const list = get().pinsByStory[storyId];
        if (!list) return;
        set({
          pinsByStory: {
            ...get().pinsByStory,
            [storyId]: list.map(p => (p.id === pinId ? movePage(p, index, direction) : p)),
          },
        });
        void flushV2();
      },
      /**
       * Fold one pin into another as extra pages, and delete the one that moved.
       *
       * The destructive half is here rather than in `pinBook` because it is a
       * decision about the reader's dock, not about the shape of a book — and
       * because a pure merge that also deleted its argument could not be tested
       * without a store.
       */
      mergePinPages: (storyId, targetId, sourceId) => {
        const list = get().pinsByStory[storyId];
        const source = list?.find(p => p.id === sourceId);
        if (!list || !source || targetId === sourceId) return;
        const merged = list
          .map(p => (p.id === targetId ? mergeInto(p, source, newId) : p))
          .filter(p => p.id !== sourceId);
        const sets = get().pinSetsByStory[storyId];
        set({
          pinsByStory: { ...get().pinsByStory, [storyId]: merged },
          // The pin it became a page of is the one that stands in for it now,
          // so a set that listed the source is not quietly left short.
          ...(sets ? {
            pinSetsByStory: {
              ...get().pinSetsByStory,
              [storyId]: sets.map(set => ({
                ...set,
                docked: set.docked.filter(id => id !== sourceId),
                inContext: set.inContext.filter(id => id !== sourceId),
              })),
            },
          } : {}),
        });
        void flushV2();
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
        void flushV2();
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
        void flushV2();
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
        void flushV2();
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
        void flushV2();
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
        void flushV2();
      },
      setActivePinSet: (storyId, setId) => {
        const active = { ...get().activePinSetByStory };
        if (setId) active[storyId] = setId;
        else delete active[storyId];
        set({ activePinSetByStory: active });
        void flushV2();
      },

      setZoneBuilderOpen: (zoneBuilderOpen) =>
        set({ zoneBuilderOpen, ...(zoneBuilderOpen ? {} : { editingZoneId: null }) }),
      openZoneBuilder: (editingZoneId) => set({ editingZoneId, zoneBuilderOpen: true }),
      /*
       * Zones write through, like every other thing the reader makes by hand.
       *
       * They did not, and the symptom was "my context zones are gone after a
       * restart". Building a zone is minutes of deliberate work, and the 400ms
       * debounce is only ever safe for state the app produces on its own: an
       * IndexedDB write cannot hold up a window close, so a zone saved and
       * then closed on was a zone that had never been written. `addTask` below
       * has carried this comment since it was written; zones were the fifth
       * feature in this file to learn it the hard way.
       */
      addZone: (storyId, zone) => {
        const now = Date.now();
        const next: ContextZone = { ...zone, id: newId(), createdAt: now, updatedAt: now };
        const list = [...(get().zonesByStory[storyId] ?? []), next].slice(-MAX_ZONES_PER_STORY);
        const touched = [storyId, ...Object.keys(get().zonesByStory).filter(k => k !== storyId)];
        set({
          zonesByStory: pruneStories({ ...get().zonesByStory, [storyId]: list }, touched),
        });
        void flushV2();
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
        void flushV2();
      },
      removeZone: (storyId, zoneId) => {
        const list = get().zonesByStory[storyId];
        if (!list) return;
        const next = list.filter(z => z.id !== zoneId);
        const all = { ...get().zonesByStory, [storyId]: next };
        if (next.length === 0) delete all[storyId];
        set({ zonesByStory: all });
        void flushV2();
      },

      addPocket: (storyId, pocket) => {
        const now = Date.now();
        const next: ContextPocket = { ...pocket, id: newId(), createdAt: now, updatedAt: now };
        const list = [...(get().pocketsByStory[storyId] ?? []), next].slice(-MAX_POCKETS_PER_STORY);
        const touched = [storyId, ...Object.keys(get().pocketsByStory).filter(k => k !== storyId)];
        set({ pocketsByStory: pruneStories({ ...get().pocketsByStory, [storyId]: list }, touched) });
        // Deliberate work, so it writes through rather than waiting on the
        // debounce — the same lesson zones learned the hard way.
        void flushV2();
        return next.id;
      },
      updatePocket: (storyId, pocketId, patch) => {
        const list = get().pocketsByStory[storyId];
        if (!list) return;
        set({
          pocketsByStory: {
            ...get().pocketsByStory,
            [storyId]: list.map(p =>
              (p.id === pocketId ? { ...p, ...patch, updatedAt: Date.now() } : p)),
          },
        });
        void flushV2();
      },
      removePocket: (storyId, pocketId) => {
        const list = get().pocketsByStory[storyId];
        if (!list) return;
        const next = list.filter(p => p.id !== pocketId);
        const all = { ...get().pocketsByStory, [storyId]: next };
        if (!next.length) delete all[storyId];
        /*
         * A step naming a deleted pocket is left alone.
         *
         * `planProblems` reports it by position and the panel shows it, which
         * tells the reader something happened; silently deleting the step would
         * shorten their plan with no trace, and re-making the pocket would not
         * bring it back.
         */
        set({ pocketsByStory: all });
        void flushV2();
      },

      addTask: (storyId, task) => {
        const now = Date.now();
        const next: ZoneTask = { ...task, id: newId(), createdAt: now, updatedAt: now };
        const list = [...(get().tasksByStory[storyId] ?? []), next].slice(-MAX_TASKS_PER_STORY);
        const touched = [storyId, ...Object.keys(get().tasksByStory).filter(k => k !== storyId)];
        set({ tasksByStory: pruneStories({ ...get().tasksByStory, [storyId]: list }, touched) });
        // A task is a thing the reader authored by hand, so it writes through
        // rather than waiting on the debounce — see the note on flushV2.
        void flushV2();
        return next.id;
      },
      updateTask: (storyId, taskId, updates) => {
        const list = get().tasksByStory[storyId];
        if (!list) return;
        set({
          tasksByStory: {
            ...get().tasksByStory,
            [storyId]: list.map(t =>
              t.id === taskId ? { ...t, ...updates, updatedAt: Date.now() } : t),
          },
        });
        void flushV2();
      },
      removeTask: (storyId, taskId) => {
        const list = get().tasksByStory[storyId];
        if (!list) return;
        const next = list.filter(t => t.id !== taskId);
        const all = { ...get().tasksByStory, [storyId]: next };
        if (next.length === 0) delete all[storyId];
        set({ tasksByStory: all });
        void flushV2();
      },
      recordTaskRun: (storyId, taskId, sections, pinVersion) => {
        const list = get().tasksByStory[storyId];
        if (!list) return;
        set({
          tasksByStory: {
            ...get().tasksByStory,
            [storyId]: list.map(t =>
              t.id === taskId
                ? { ...t, lastRun: { at: Date.now(), sections, pinVersion } }
                : t),
          },
        });
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
      editTurn: (storyId, threadId, turnId, text) => {
        const list = get().chatThreadsByStory[storyId];
        // A blank edit would leave a bubble with nothing in it and, on a user
        // turn, send an empty message on the next regenerate. Deleting is a
        // separate, deliberate action.
        if (!list || !text.trim()) return;
        set({
          chatThreadsByStory: {
            ...get().chatThreadsByStory,
            [storyId]: list.map(t =>
              t.id === threadId
                ? {
                    ...t, updatedAt: Date.now(),
                    turns: t.turns.map(tr => {
                      if (tr.id !== turnId) return tr;
                      const variants = [...tr.variants];
                      variants[tr.activeVariant] = text;
                      return { ...tr, variants };
                    }),
                  }
                : t),
          },
        });
        void flushV2();
      },
      removeTurn: (storyId, threadId, turnId) => {
        const list = get().chatThreadsByStory[storyId];
        if (!list) return;
        set({
          chatThreadsByStory: {
            ...get().chatThreadsByStory,
            [storyId]: list.map(t =>
              t.id === threadId
                ? { ...t, turns: t.turns.filter(tr => tr.id !== turnId), updatedAt: Date.now() }
                : t),
          },
        });
        void flushV2();
      },

      addCowritePreset: (preset) => {
        const now = Date.now();
        const next: CowritePreset = { ...preset, builtIn: false, id: newId(), createdAt: now, updatedAt: now };
        set({ cowritePresets: [...get().cowritePresets, next] });
        void flushV2();
        return next.id;
      },
      updateCowritePreset: (id, updates) => {
        set({
          cowritePresets: get().cowritePresets.map(p =>
            (p.id === id && !p.builtIn ? { ...p, ...updates, updatedAt: Date.now() } : p)),
        });
        void flushV2();
      },
      removeCowritePreset: (id) => {
        set({ cowritePresets: get().cowritePresets.filter(p => p.id !== id) });
        void flushV2();
      },

      setDirectorEnabled: (storyId, on) => {
        const next = { ...get().directorEnabledByStory };
        if (on) next[storyId] = true; else delete next[storyId];
        set({ directorEnabledByStory: next });
      },
      putStoryRead: (storyId, read) =>
        set({ storyReadByStory: { ...get().storyReadByStory, [storyId]: read } }),

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
      addAskTurn: (storyId, turn) => {
        const thread = readThread(get().askByStory[storyId]);
        set({ askByStory: { ...get().askByStory, [storyId]: [...thread, turn] } });
      },
      setReactionPoints: (storyId, key, rec) => {
        const byKey = get().reactionsByStory[storyId] ?? {};
        const prev = byKey[key];
        // Re-scouting the same passage keeps what was already said; a CHANGED
        // passage starts clean, because the old offsets now point at different
        // words and a line spoken at them would land on the wrong moment.
        const lines = prev?.hash === rec.hash ? prev.lines : {};
        set({
          reactionsByStory: {
            ...get().reactionsByStory,
            [storyId]: { ...byKey, [key]: { ...rec, lines } },
          },
        });
      },
      addReactionLine: (storyId, key, pointId, line) => {
        const byKey = get().reactionsByStory[storyId] ?? {};
        const rec = byKey[key];
        if (!rec) return;
        set({
          reactionsByStory: {
            ...get().reactionsByStory,
            [storyId]: { ...byKey, [key]: { ...rec, lines: { ...rec.lines, [pointId]: line } } },
          },
        });
        // Written through: a spoken line cost a model call, and a reader
        // scrolling back expects to find what was said at that beat.
        void flushV2();
      },
      clearReactions: (storyId, key, pointId) => {
        if (!key) {
          const next = { ...get().reactionsByStory };
          delete next[storyId];
          set({ reactionsByStory: next });
          void flushV2();
          return;
        }
        const byKey = get().reactionsByStory[storyId];
        const rec = byKey?.[key];
        if (!rec) return;
        const next = { ...byKey };
        if (pointId) {
          // A re-roll: forget the LINE, keep the moment. The scout already
          // decided this was worth breaking in on and re-asking it would cost a
          // second call to be told the same thing.
          const lines = { ...rec.lines };
          delete lines[pointId];
          next[key] = { ...rec, lines };
        } else {
          delete next[key];
        }
        set({ reactionsByStory: { ...get().reactionsByStory, [storyId]: next } });
        void flushV2();
      },

      clearAskThread: (storyId) => {
        const next = { ...get().askByStory };
        delete next[storyId];
        set({ askByStory: next });
      },

      setSandboxGuidance: (storyId, guidance) => {
        set({ sandboxGuidanceByStory: { ...get().sandboxGuidanceByStory, [storyId]: guidance } });
      },
      setSandboxPacket: (storyId, packet, guidance) => {
        set({ sandboxPacketByStory: { ...get().sandboxPacketByStory, [storyId]: { packet, guidance } } });
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

      addSceneArt: (storyId, messageId, art) => {
        const byMsg = get().artByStory[storyId] ?? {};
        const list = [...(byMsg[messageId] ?? []), art];
        set({ artByStory: { ...get().artByStory, [storyId]: { ...byMsg, [messageId]: list } } });
        // A picture costs a GPU render — the same argument as tags and visitors.
        void flushV2();
      },
      removeSceneArt: (storyId, messageId, artId) => {
        const byMsg = get().artByStory[storyId];
        if (!byMsg?.[messageId]) return;
        const rest = byMsg[messageId].filter(a => a.id !== artId);
        const next = { ...byMsg };
        if (rest.length) next[messageId] = rest; else delete next[messageId];
        set({ artByStory: { ...get().artByStory, [storyId]: next } });
        void flushV2();
      },

      // All three write through rather than debounce, for the same reason
      // `setStoryTags` does: saves are batched on a 400ms timer and an
      // IndexedDB write cannot hold up a page unload. A visitor costs a model
      // call to make and a careful read to correct — losing one to a reload a
      // third of a second later is not a tradeoff anybody would accept.
      // Crossings go through the pure helpers so the duplicate rule (a link
      // drawn backwards is the same link) lives in one tested place rather than
      // being re-derived here.
      addCrossing: (c) => {
        set({ crossings: addCrossingTo(get().crossings, c) });
        void flushV2();
      },
      updateCrossing: (id, patch) => {
        set({ crossings: updateCrossingIn(get().crossings, id, patch) });
        void flushV2();
      },
      removeCrossing: (id) => {
        set({ crossings: removeCrossingFrom(get().crossings, id) });
        void flushV2();
      },
      setCrossingBoard: (crossingBoard) => set({ crossingBoard }),
      setCrossingBoardOpen: (crossingBoardOpen) => set({ crossingBoardOpen }),

      addThroughline: (t) => {
        set({ throughlines: [...get().throughlines, t] });
        void flushV2();
      },
      updateThroughline: (id, patch) => {
        set({ throughlines: get().throughlines.map(t => (t.id === id ? { ...t, ...patch } : t)) });
        void flushV2();
      },
      removeThroughline: (id) => {
        set({ throughlines: get().throughlines.filter(t => t.id !== id) });
        void flushV2();
      },
      addArc: (id, arc) => {
        set({
          throughlines: get().throughlines.map(t => (t.id === id
            // A story belongs to one arc. Re-adding it moves nothing and
            // duplicates nothing — two arcs with one story id would make the
            // spoiler clamp non-deterministic (see utils/throughline).
            ? (t.arcs.some(a => a.storyId === arc.storyId)
              ? t
              : { ...t, arcs: renumberArcs([...orderedArcs(t), arc]) })
            : t)),
        });
        void flushV2();
      },
      updateArc: (id, storyId, patch) => {
        set({
          throughlines: get().throughlines.map(t => (t.id === id
            ? { ...t, arcs: t.arcs.map(a => (a.storyId === storyId ? { ...a, ...patch } : a)) }
            : t)),
        });
        void flushV2();
      },
      removeArc: (id, storyId) => {
        set({
          throughlines: get().throughlines.map(t => (t.id === id
            ? { ...t, arcs: renumberArcs(orderedArcs(t).filter(a => a.storyId !== storyId)) }
            : t)),
        });
        void flushV2();
      },
      reorderArc: (id, storyId, direction) => {
        set({
          throughlines: get().throughlines.map(t => (t.id === id
            ? { ...t, arcs: moveArcIn(t, storyId, direction) }
            : t)),
        });
        void flushV2();
      },

      addVisitor: (storyId, visitor) => {
        const list = get().visitorsByStory[storyId] ?? [];
        set({ visitorsByStory: { ...get().visitorsByStory, [storyId]: [...list, visitor] } });
        void flushV2();
      },
      updateVisitor: (storyId, visitorId, patch) => {
        const list = get().visitorsByStory[storyId];
        if (!list) return;
        set({
          visitorsByStory: {
            ...get().visitorsByStory,
            [storyId]: list.map(v => (v.id === visitorId ? { ...v, ...patch } : v)),
          },
        });
        void flushV2();
      },
      removeVisitor: (storyId, visitorId) => {
        const list = get().visitorsByStory[storyId];
        if (!list) return;
        set({ visitorsByStory: { ...get().visitorsByStory, [storyId]: list.filter(v => v.id !== visitorId) } });
        void flushV2();
      },

      setAppearance: (storyId, character, text) => {
        const key = character.trim().toLowerCase();
        if (!key) return;
        const byChar = { ...(get().appearanceByStory[storyId] ?? {}) };
        if (text.trim()) byChar[key] = text.trim(); else delete byChar[key];
        set({ appearanceByStory: { ...get().appearanceByStory, [storyId]: byChar } });
      },
      setArtSeed: (storyId, character, seed) => {
        const key = character.trim().toLowerCase();
        if (!key) return;
        const byChar = { ...(get().artSeedByStory[storyId] ?? {}) };
        if (seed == null) delete byChar[key]; else byChar[key] = seed;
        set({ artSeedByStory: { ...get().artSeedByStory, [storyId]: byChar } });
      },

      // Both write through rather than debounce, for the same reason visitors
      // and art do: saves are batched on a 400ms timer and an IndexedDB write
      // cannot hold up a page unload. Marking a span is a deliberate act — the
      // reader picked the words by hand — and losing it to a reload a third of
      // a second later is not a tradeoff anybody would accept. Caught by the
      // e2e that reloads after marking, which is the only place it shows.
      addEmphasisMark: (storyId, messageId, mark) => {
        const text = mark.text.trim();
        if (!text) return;
        const byMsg = get().emphasisMarksByStory[storyId] ?? {};
        // One treatment per span — re-marking the same words replaces the old.
        const kept = (byMsg[messageId] ?? []).filter(m => m.text !== text);
        const list = [...kept, { ...mark, text, id: newId() }];
        set({
          emphasisMarksByStory: { ...get().emphasisMarksByStory, [storyId]: { ...byMsg, [messageId]: list } },
          tasteMarks: learn(get().tasteMarks, { text, kind: mark.kind, track: 'emphasis', at: Date.now() }),
        });
        void flushV2();
      },
      setFunctionRead: (storyId, messageId, hash, fns) => {
        const byMsg = get().functionsByStory[storyId] ?? {};
        if (byMsg[messageId]?.hash === hash) return; // already read, unchanged
        set({
          functionsByStory: {
            ...get().functionsByStory,
            [storyId]: { ...byMsg, [messageId]: { hash, fns } },
          },
        });
        // A cached READ, not a deliberate edit — the 400ms debounce is the
        // right home for it, unlike a mark the reader made by hand.
      },

      clearEmphasisMarkFor: (storyId, messageId, text) => {
        const byMsg = get().emphasisMarksByStory[storyId];
        const list = byMsg?.[messageId];
        if (!list?.length) return;
        const t = text.trim();
        // Same containment rule as the perform marks: clearing works whether
        // the reader re-selects the exact span or a little more around it.
        const next = list.filter(m => !(m.text === t || t.includes(m.text) || m.text.includes(t)));
        if (next.length === list.length) return;
        set({
          emphasisMarksByStory: { ...get().emphasisMarksByStory, [storyId]: { ...byMsg, [messageId]: next } },
          tasteMarks: forget(get().tasteMarks, list.filter(m => !next.includes(m)), 'emphasis'),
        });
        void flushV2();
      },

      // The three below write through for the same reason the two above do, and
      // they did not until now — the debounce trap has bitten this app four
      // times. Marking a span is deliberate: the reader picked the words by
      // hand, and a 400ms IndexedDB write cannot hold up a page unload.
      addPerformMark: (storyId, messageId, mark) => {
        const text = mark.text.trim();
        if (!text) return;
        const byMsg = get().performMarksByStory[storyId] ?? {};
        // One direction per span — re-marking the same words replaces the old call.
        const kept = (byMsg[messageId] ?? []).filter(m => m.text !== text);
        const list = [...kept, { ...mark, text, id: newId() }];
        set({
          performMarksByStory: { ...get().performMarksByStory, [storyId]: { ...byMsg, [messageId]: list } },
          tasteMarks: learn(get().tasteMarks, { text, kind: mark.kind, track: 'perform', at: Date.now() }),
        });
        void flushV2();
      },
      removePerformMark: (storyId, messageId, markId) => {
        const byMsg = get().performMarksByStory[storyId];
        if (!byMsg?.[messageId]) return;
        const gone = byMsg[messageId].filter(m => m.id === markId);
        set({
          performMarksByStory: { ...get().performMarksByStory, [storyId]: { ...byMsg, [messageId]: byMsg[messageId].filter(m => m.id !== markId) } },
          tasteMarks: forget(get().tasteMarks, gone, 'perform'),
        });
        void flushV2();
      },
      clearPerformMarkFor: (storyId, messageId, text) => {
        const byMsg = get().performMarksByStory[storyId];
        const list = byMsg?.[messageId];
        if (!list?.length) return;
        const t = text.trim();
        // Drop anything the selection covers, so clearing works whether the
        // reader re-selects the exact span or a little more around it.
        const next = list.filter(m => !(m.text === t || t.includes(m.text) || m.text.includes(t)));
        if (next.length === list.length) return;
        set({
          performMarksByStory: { ...get().performMarksByStory, [storyId]: { ...byMsg, [messageId]: next } },
          tasteMarks: forget(get().tasteMarks, list.filter(m => !next.includes(m)), 'perform'),
        });
        void flushV2();
      },

      clearTaste: () => { set({ tasteMarks: [] }); void flushV2(); },

      adoptCut: (storyId, wants) => {
        const state = get() as unknown as Record<string, unknown>;
        const patch: Record<string, unknown> = {};
        for (const { slice, value } of wants) {
          // Only slices this store actually has. A Cut is already filtered on
          // the way in (`parseCut`), and this is the second gate: a name that
          // is not a real slice must not become one by arriving in a file.
          if (!(slice in state)) continue;
          const current = state[slice];
          const share = value[storyId];
          if (share === undefined) continue;
          if (!current || typeof current !== 'object' || Array.isArray(current)) continue;
          patch[slice] = { ...(current as Record<string, unknown>), [storyId]: share };
        }
        if (!Object.keys(patch).length) return;
        set(patch as never);
        // Written through: opening a Cut is the reader receiving something, and
        // losing it to a reload would look exactly like a corrupt file.
        void flushV2();
      },

      addAnnotation: (storyId, annotation) => {
        const now = Date.now();
        const next: Annotation = { ...annotation, id: newId(), createdAt: now, updatedAt: now };
        const list = [...(get().annotationsByStory[storyId] ?? []), next];
        const touched = [storyId, ...Object.keys(get().annotationsByStory).filter(k => k !== storyId)];
        set({
          annotationsByStory: pruneStories({ ...get().annotationsByStory, [storyId]: list }, touched),
        });
        void flushV2();
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
        void flushV2();
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
);

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

/**
 * The persisted shape at the last successful write. Diffing against this is
 * what keeps a write small: an immutable `set()` replaces only the objects it
 * touched, so every untouched story compares equal by reference and costs
 * nothing.
 */
let lastSaved: SliceBag = {};
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving: Promise<void> = Promise.resolve();
let hydrated = false;

/** Consecutive failed writes. Reset by any success. */
let consecutiveFailures = 0;
/** How many in a row before the reader is told. See the catch in writeNow. */
const FAILURES_BEFORE_ALARM = 3;

const writeNow = (): Promise<void> => {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!hydrated) return saving;
  const next = pickPersisted(useAuraV2Store.getState() as unknown as SliceBag);
  const ops = diffSlices(lastSaved, next);
  if (!ops.length) return saving;
  // Move the baseline forward BEFORE awaiting, so writes that land during the
  // transaction are diffed against what we're about to store, not against a
  // stale snapshot — otherwise they'd be written twice.
  const previous = lastSaved;
  lastSaved = next;
  saving = saving
    .then(() => applyOps(ops))
    .then(() => { consecutiveFailures = 0; })
    .catch(e => {
      // Roll the baseline back so these records are retried on the next write
      // instead of being silently lost — the failure mode the old localStorage
      // layer had, and the reason for this whole change.
      lastSaved = previous;
      console.error('v2 store: save failed, will retry', e);

      /**
       * Tell the reader, but only once the retries have stopped helping.
       *
       * A single failed write is usually nothing — a transaction that lost a
       * race, a tab suspended mid-save — and the retry above fixes it before
       * anyone could have read a warning about it. Alarming on that would
       * train readers to dismiss this message, which is precisely the message
       * they must not learn to dismiss.
       *
       * Three in a row is different: that is quota, or eviction, or a broken
       * database, and it will not fix itself. At that point the reader is
       * annotating a story that is no longer being saved and needs to know
       * now, while there is still time to export a backup.
       */
      if (++consecutiveFailures === FAILURES_BEFORE_ALARM) {
        alertSaveFailed('your notes, pins and edits');
      }
    });
  return saving;
};

const scheduleSave = () => {
  if (!hydrated) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void writeNow(); }, 400);
};

/**
 * Load the reader's saved data and start persisting changes.
 *
 * Called before the app renders (see `main.tsx`), so the first paint sees the
 * same state the old synchronous localStorage read used to provide — no window
 * in which a component reads an empty codex and writes that emptiness back.
 */
export const hydrateV2 = async (): Promise<void> => {
  if (hydrated) return;
  const { state } = await loadV2();
  if (Object.keys(state).length) useAuraV2Store.setState(state as never);
  lastSaved = pickPersisted(useAuraV2Store.getState() as unknown as SliceBag);
  const wrong = misdeclaredSlices(lastSaved);
  if (wrong.length) {
    console.error(
      `v2 store: these slices are declared per-story but are not story-keyed — `
      + `they will be sharded on the wrong key: ${wrong.join(', ')}`,
    );
  }
  hydrated = true;
  useAuraV2Store.subscribe(scheduleSave);
  if (typeof window !== 'undefined') {
    // IndexedDB writes can't block an unload, so lean on `visibilitychange`,
    // which fires while the page can still finish work. With a 400ms debounce
    // the exposure is a fraction of a second of the most recent edit.
    document.addEventListener('visibilitychange', () => { if (document.hidden) void writeNow(); });
    window.addEventListener('pagehide', () => { void writeNow(); });
  }
};

/** Flush any pending write immediately. Exposed for tests. */
export const flushV2 = (): Promise<void> => writeNow();
