/**
 * Scene Director runner — the impure glue between the stores and the pure
 * enrichment lib. Gathers passages from the currently-open story (resolved
 * through Lens edits so hashes match what the reader sees), runs them through
 * the Director, and streams the descriptors into the cache with live progress.
 *
 * Only one run happens at a time (guarded by the runtime store). A single
 * module-level AbortController lets the UI stop an in-flight run.
 */

import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { useSceneDirectorStore } from '../stores/useSceneDirectorStore';
import { resolveContent } from './lens';
import { EnrichConfig, enrichPassages, ScenePassage, selectStale } from './sceneDirector';
import { StoryRead, isStoryReadStale, readStory } from './storyRead';
import { tasteBlock } from './tasteBlock';

let controller: AbortController | null = null;

/** AI config for enrichment, or null when no endpoint/model is configured. */
const aiConfig = (): EnrichConfig | null => {
  const app = useAppStore.getState();
  if (!app.aiBaseUrl || !app.aiModel) return null;
  return {
    base: app.aiBaseUrl,
    key: app.aiApiKey,
    model: app.aiModel,
    card: app.currentStory?.card,
  };
};

/** Map a story's messages to passages, skipping the reader's own (user) turns. */
const toPassages = (messages: { id: string; name: string; role: string }[], storyId: string): ScenePassage[] => {
  const v2 = useAuraV2Store.getState();
  const overrides = v2.overridesByStory[storyId];
  const lensOn = !!v2.lensOnByStory[storyId];
  const out: ScenePassage[] = [];
  for (const m of messages) {
    if (m.role === 'user') continue;
    out.push({ messageId: m.id, name: m.name, content: resolveContent(m as any, overrides, lensOn) });
  }
  return out;
};

/** Every AI passage in the open story. */
export const passagesForStory = (): ScenePassage[] => {
  const app = useAppStore.getState();
  if (!app.currentStory) return [];
  return toPassages(app.chains.flatMap(c => c.messages), app.currentStory.id);
};

/** AI passages on the page/chapter the reader is currently on. */
export const currentPagePassages = (): ScenePassage[] => {
  const app = useAppStore.getState();
  const chain = app.chains[app.currentChainIndex];
  if (!app.currentStory || !chain) return [];
  return toPassages(chain.messages, app.currentStory.id);
};

/** Count of directed (fresh) vs. total AI passages in the open story. */
export const directorCoverage = (storyId: string): { directed: number; total: number } => {
  const all = passagesForStory();
  const cache = useAuraV2Store.getState().sceneByStory[storyId];
  const stale = selectStale(all, cache).length;
  return { directed: all.length - stale, total: all.length };
};

/**
 * The story's location just BEFORE the first stale passage — the nearest
 * already-read location upstream. Seeds continuity so enriching a page picks up
 * where the last page left off instead of guessing a fresh, unrelated place.
 */
const seedLocation = (storyId: string, firstStaleId?: string): string | undefined => {
  if (!firstStaleId) return undefined;
  const all = passagesForStory();
  const cache = useAuraV2Store.getState().sceneByStory[storyId] ?? {};
  const idx = all.findIndex(p => p.messageId === firstStaleId);
  for (let i = idx - 1; i >= 0; i--) {
    const loc = cache[all[i].messageId]?.location;
    if (loc) return loc;
  }
  return undefined;
};

/**
 * The story's whole-story read, taken once and cached.
 *
 * Costs one extra request per story (not per passage) and grounds every batch
 * that follows, so the Director can weight a cue by the arc instead of by local
 * punctuation. A failure is not fatal: enrichment runs ungrounded, exactly as it
 * did before this pass existed.
 */
const ensureStoryRead = async (
  storyId: string,
  cfg: EnrichConfig,
  signal: AbortSignal,
): Promise<StoryRead | undefined> => {
  const all = passagesForStory();
  const cached = useAuraV2Store.getState().storyReadByStory[storyId];
  if (!isStoryReadStale(cached, all)) return cached;
  const read = await readStory(all, cfg, signal);
  if (read && !signal.aborted) {
    useAuraV2Store.getState().putStoryRead(storyId, read);
    return read;
  }
  // Keep using a stale read rather than none — an out-of-date arc still weights
  // better than no arc, and it will be replaced on the next successful run.
  return cached;
};

/** Abort any in-flight run. */
export const stopEnrich = (): void => {
  controller?.abort();
  controller = null;
  useSceneDirectorStore.getState().end();
};

/**
 * Enrich the given passages (only the stale/missing ones). No-ops when nothing
 * is stale, no endpoint is set, or a run is already going. Persists each batch
 * as it lands so progress is visible and a stop keeps what was read.
 */
const run = async (storyId: string, passages: ScenePassage[]): Promise<void> => {
  const cfg = aiConfig();
  if (!cfg) return;
  const dir = useSceneDirectorStore.getState();
  if (dir.running) return;

  const cache = useAuraV2Store.getState().sceneByStory[storyId];
  const stale = selectStale(passages, cache);
  if (stale.length === 0) return;

  controller = new AbortController();
  dir.begin(storyId, stale.length);
  try {
    const storyRead = await ensureStoryRead(storyId, cfg, controller.signal);
    if (controller.signal.aborted) return;
    await enrichPassages(stale, cfg, {
      signal: controller.signal,
      storyRead,
      // Built once per run, not per batch: the log cannot change mid-run, and a
      // stable block keeps every batch in a run sharing a prompt prefix.
      taste: tasteBlock(useAuraV2Store.getState().tasteMarks),
      prevLocation: seedLocation(storyId, stale[0]?.messageId),
      onBatch: (descriptors, done, _total, unread) => {
        if (descriptors.length) useAuraV2Store.getState().putScenes(storyId, descriptors);
        useSceneDirectorStore.getState().advance(done, unread);
      },
    });
  } finally {
    useSceneDirectorStore.getState().end();
    controller = null;
  }
};

/** Manual "Enrich all" — read every stale passage in the story. */
export const enrichAll = (storyId: string): Promise<void> => run(storyId, passagesForStory());

/** Auto (hybrid) — read the current page/chapter's stale passages. */
export const enrichCurrentPage = (storyId: string): Promise<void> => run(storyId, currentPagePassages());

/**
 * Manual "retry this page" — throw away the current page's cached descriptors so
 * they read as stale, then re-run the Director on them. Lets the reader ask for a
 * fresh take when the auto pass gave a weak read. No-ops if a run is in flight.
 */
export const retryCurrentPage = (storyId: string): Promise<void> => {
  if (useSceneDirectorStore.getState().running) return Promise.resolve();
  const passages = currentPagePassages();
  const store = useAuraV2Store.getState();
  for (const p of passages) store.clearScenes(storyId, p.messageId);
  return run(storyId, passages);
};
