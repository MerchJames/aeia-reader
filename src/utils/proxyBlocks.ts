/**
 * The reader's settings, turned into a plan for one prompt.
 *
 * `proxyMaterial.ts` orders the blocks and `promptPipeline.ts` places them;
 * this is the adapter between those two pure modules and the stores the
 * material actually lives in. It is the only impure part of the request
 * pipeline, which is why it is this short.
 *
 * ── The zone caveat ────────────────────────────────────────────────────────
 *
 * A pin, a sheet and a codex entry carry their own text. A Context Zone does
 * not — it is a set of message ids, and turning it into a prompt block needs
 * the story's chains, which exist only while that story is open. So a zone is
 * rendered when its story is on screen and left out when it is not, rather than
 * loading a whole story off disk inside the request path of every message the
 * reader sends. The picker only offers what this can actually deliver.
 */

import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { buildZoneBody } from './contextZone';
import { resolveContent } from './lens';
import { gatherBlocks, EMPTY_INPUT, type MaterialInput, type MaterialPick } from './proxyMaterial';
import { DEFAULT_BUDGET, type PromptPlan } from './promptPipeline';
import type { AppState } from '../types';

/** Which story the pipelines draw from: the named one, else the open one. */
export const proxyStory = (app: AppState): string =>
  app.proxyStoryId || app.currentStory?.id || '';

/**
 * Everything available to put in a prompt, gathered from the stores.
 *
 * Shared by the picker and the request pipeline on purpose: the list the reader
 * chooses from and the list the prompt is built from must be the same list, or
 * the picker becomes a menu of things that may or may not arrive.
 */
export const proxyMaterialInput = (app: AppState): MaterialInput => {
  const storyId = proxyStory(app);
  if (!storyId) return EMPTY_INPUT;

  const v2 = useAuraV2Store.getState();
  const open = app.currentStory;

  const zones: MaterialInput['zones'] = [];
  if (open?.id === storyId) {
    const chains = useAppStore.getState().chains;
    const overrides = v2.overridesByStory[storyId];
    for (const zone of v2.zonesByStory[storyId] ?? []) {
      const built = buildZoneBody(
        zone, chains,
        // The Lens forced on: the reader's rewrites are what the story says
        // now, whatever their reading toggle happens to be set to.
        m => resolveContent(m, overrides, true),
        open.timelines ?? [],
      );
      if (!built.empty) zones.push({ id: zone.id, name: zone.name, body: built.body });
    }
  }

  return {
    pins: (v2.pinsByStory[storyId] ?? []).map(p => ({
      id: p.id, title: p.title, content: p.content,
    })),
    sets: (v2.pinSetsByStory?.[storyId] ?? []).map(s => ({
      id: s.id, name: s.name, inContext: s.inContext ?? [],
    })),
    activeSetId: v2.activePinSetByStory?.[storyId],
    sheets: (v2.sheetsByStory[storyId] ?? []).map(s => ({
      id: s.id, title: s.title, columns: s.columns, rows: s.rows,
    })),
    codex: (v2.codexByStory[storyId] ?? []).map(c => ({
      id: c.id, name: c.name, kind: c.kind, summary: c.summary,
    })),
    // Highlights live on the story record rather than in the v2 slices, so they
    // are only reachable while it is open. Same rule as zones, same reason.
    highlights: open?.id === storyId
      ? (open.highlights ?? []).map(h => ({ id: h.id, text: h.text, note: h.note }))
      : [],
    zones,
  };
};

/** Everything the request pipeline will do to this prompt. */
export const proxyBlocks = (app: AppState): PromptPlan => {
  const pick = app.proxyMaterial as MaterialPick;
  const budget = app.proxyBudget ?? DEFAULT_BUDGET;
  const drop = app.proxyDrop?.split('\n').map(s => s.trim()).filter(Boolean);

  if (!proxyStory(app)) {
    // No story named and none open. Nothing is injected rather than something
    // guessed at: a prompt silently carrying another story's pins is a very
    // confusing thing to be debugging at eleven at night.
    return { blocks: [], budget, drop, instructionLast: app.proxyInstructionLast };
  }

  return {
    blocks: gatherBlocks(proxyMaterialInput(app), pick),
    budget,
    drop,
    instructionLast: app.proxyInstructionLast,
  };
};
