/**
 * The bridge between the agent's tool surface and this app's stores.
 *
 * `utils/agentTools.ts` is pure on purpose — it takes a `ToolContext` of plain
 * functions and knows nothing about zustand, IndexedDB or React, which is what
 * lets its whole surface be tested with `tsx`. This is the other half: the one
 * place that reads the real stores and hands them over in that shape.
 *
 * Two things it is careful about, both of which are the difference between the
 * agent seeing the story and seeing something adjacent to it:
 *
 * **It reads what the READER reads.** Message text goes through `resolveContent`
 * (so a Lens rewrite is what the agent sees, exactly as on the page) and through
 * the live streaming buffer (so the passage arriving right now reads true). An
 * agent quoting the raw JSON back at a reader who has rewritten it is quoting a
 * version of the story that no longer exists for them.
 *
 * **A write goes through `flushV2`.** A pin version is a deliberate edit, and
 * the trap this app has hit four times is that an IndexedDB write cannot hold
 * up a page unload — so anything the reader would be upset to lose writes
 * through instead of waiting on the 400ms debounce.
 */

import { useAppStore } from '../store';
import { GUIDE_SETTINGS } from '../utils/agentTools';
import { VIEW_ORDER, viewAllowed } from '../utils/viewBar';
import type { UiMode, ViewMode } from '../types';
import { flushV2, useAuraV2Store } from '../stores/useAuraV2Store';
import { buildZoneBody, flatWithIndex, zoneSummary } from '../utils/contextZone';
import { resolveContent } from '../utils/lens';
import { makeProposal, proposalProblem, type LensProposal } from '../utils/lensProposal';
import type { MessageRow, ToolContext } from '../utils/agentTools';
import type { Message } from '../types';

/** Hits `story.search` returns before the tool's own limit applies. */
const SEARCH_SCAN_CAP = 400;

/**
 * Where a proposed Lens edit goes.
 *
 * Not the store — that is the whole point. A proposal lands in the panel's own
 * state, is shown to the reader beside the original, and only becomes a
 * `setOverride` when they say so. Passing the sink in rather than reaching for
 * a store keeps that true by construction: this module has no way to apply one.
 */
export type ProposalSink = (p: LensProposal) => void;


/**
 * Panels the guide may open, and how.
 *
 * A table rather than a switch inside the tool, so "what can the guide reach"
 * is answerable by reading one list. Everything here just puts a panel on
 * screen; none of it changes data, and the reader closes any of them with the
 * same X they would use otherwise.
 */
export const GUIDE_PANELS = [
  'settings', 'codex', 'sheets', 'ai', 'frame', 'multiverse', 'branching',
  'backup', 'sync', 'tour', 'library',
] as const;

export const openGuidePanel = (panel: string): boolean => {
  const app = useAppStore.getState();
  const v2 = useAuraV2Store.getState();
  switch (panel) {
    case 'settings': app.setSettingsOpen(true); return true;
    case 'ai': app.setAiOpen(true); return true;
    case 'codex': v2.setCodexOpen(true); return true;
    case 'sheets': v2.setSheetsOpen(true); return true;
    case 'library': app.closeStory(); return true;
    // These four are opened by the panels that own them, and the store has no
    // flag for them. Rather than invent one, the guide says where to click —
    // which is what it would have to do for anything it cannot reach anyway.
    case 'frame': case 'multiverse': case 'branching': case 'backup':
    case 'sync': case 'tour':
      return false;
    default: return false;
  }
};

/**
 * Assemble the context for one turn.
 *
 * A function rather than a hook, called at send time: every accessor reads
 * `getState()` when the tool runs, so a tool sees the store as it is at that
 * moment rather than as it was when the component last rendered. That matters
 * inside a loop — step four must see the pin version step two wrote.
 */
export const buildToolContext = (storyId: string, sink?: ProposalSink): ToolContext => {
  const flat = () => {
    const app = useAppStore.getState();
    const v2 = useAuraV2Store.getState();
    const overrides = v2.overridesByStory[storyId];
    const lensOn = !!v2.lensOnByStory[storyId];
    const text = (m: Message) =>
      (m.id === app.streamingMessage?.id ? app.streamedText : resolveContent(m, overrides, lensOn));
    return { entries: flatWithIndex(app.chains), text };
  };

  const rows = (msgs: { msg: Message; index: number }[], text: (m: Message) => string): MessageRow[] =>
    msgs.map(f => ({ index: f.index, name: f.msg.name, content: text(f.msg) }));

  return {
    get messageCount() {
      return useAppStore.getState().chains.reduce((n, c) => n + c.messages.length, 0);
    },

    listPins: () => (useAuraV2Store.getState().pinsByStory[storyId] ?? []).map(p => ({
      id: p.id,
      title: p.title,
      format: p.format,
      content: p.content,
      versionCount: p.versions?.length ?? 1,
      activeVersion: p.activeVersion ?? 0,
      inContext: p.inContext,
    })),

    listZones: () => {
      const app = useAppStore.getState();
      const timelines = app.currentStory?.timelines ?? [];
      return (useAuraV2Store.getState().zonesByStory[storyId] ?? []).map(z => ({
        id: z.id,
        name: z.name,
        summary: zoneSummary(z, app.chains, timelines),
      }));
    },

    buildZone: (zoneId) => {
      const zone = (useAuraV2Store.getState().zonesByStory[storyId] ?? []).find(z => z.id === zoneId);
      if (!zone) return null;
      const app = useAppStore.getState();
      const { text } = flat();
      const built = buildZoneBody(zone, app.chains, text, app.currentStory?.timelines ?? []);
      return {
        name: zone.name,
        body: built.body,
        messageCount: built.messageCount,
        branchlineCount: built.branchlineCount,
        empty: built.empty,
      };
    },

    readStory: (from, to) => {
      const { entries, text } = flat();
      return rows(entries.filter(f => f.index >= from && f.index <= to), text);
    },

    searchStory: (query, limit) => {
      const { entries, text } = flat();
      const needle = query.toLowerCase();
      const hits: { msg: Message; index: number }[] = [];
      // Scanning stops at a cap rather than reading a 500-message log twice per
      // step; the tool's own `limit` is usually reached long before this.
      for (let i = 0; i < entries.length && i < SEARCH_SCAN_CAP && hits.length < limit; i++) {
        if (text(entries[i].msg).toLowerCase().includes(needle)) hits.push(entries[i]);
      }
      return rows(hits, text);
    },

    listCodex: () => (useAuraV2Store.getState().codexByStory[storyId] ?? []).map(e => ({
      name: e.name,
      kind: e.kind,
      aliases: e.aliases,
      summary: e.summary,
      mentions: e.mentions,
    })),

    listSheets: () => (useAuraV2Store.getState().sheetsByStory[storyId] ?? []).map(s => ({
      id: s.id,
      title: s.title,
      columns: s.columns,
      rowCount: s.rows.length,
      rows: s.rows,
    })),

    createPin: (title, content, format) => {
      // '' when the per-story cap refused it — the tool turns that into a
      // failed result the model can read, rather than reporting a pin that
      // does not exist.
      const id = useAuraV2Store.getState().addPin(storyId, {
        title, content, format,
        // Docked so the reader SEES what was made. A pin created off-screen is
        // indistinguishable from nothing having happened.
        docked: true,
        inContext: false,
      });
      if (id) void flushV2();
      return id;
    },

    addPinVersion: (pinId, content, instruction) => {
      const v2 = useAuraV2Store.getState();
      if (!(v2.pinsByStory[storyId] ?? []).some(p => p.id === pinId)) return null;
      v2.addPinVersion(storyId, pinId, { content, source: 'ai', instruction });
      void flushV2();
      // Read back rather than counting: the store caps version history and
      // trims from the middle, so the number that matters is the one it kept.
      const after = (useAuraV2Store.getState().pinsByStory[storyId] ?? []).find(p => p.id === pinId);
      return after ? (after.activeVersion ?? 0) + 1 : null;
    },

    listLens: () => {
      const app = useAppStore.getState();
      const v2 = useAuraV2Store.getState();
      const overrides = v2.overridesByStory[storyId] ?? [];
      if (!overrides.length) return [];
      const byId = new Map(overrides.map(o => [o.messageId, o]));
      return flatWithIndex(app.chains)
        .filter(f => byId.has(f.msg.id))
        .map(f => {
          const o = byId.get(f.msg.id)!;
          return {
            index: f.index,
            name: f.msg.name,
            original: f.msg.content,
            content: o.content,
            note: o.note,
          };
        });
    },

    proposeLens: (target, content, note) => {
      const app = useAppStore.getState();
      const v2 = useAuraV2Store.getState();
      const entry = flatWithIndex(app.chains).find(f => f.index === target);
      if (!entry) return null;
      // Rewrite what the reader is LOOKING AT, so successive edits build on each
      // other instead of silently reverting to the imported text.
      const before = resolveContent(
        entry.msg, v2.overridesByStory[storyId], !!v2.lensOnByStory[storyId],
      );
      const proposal = makeProposal({
        messageId: entry.msg.id,
        index: entry.index,
        name: entry.msg.name,
        before,
        after: content,
        kind: 'revision',
        instruction: note || undefined,
        source: 'ai',
      });
      const problem = proposalProblem(proposal);
      // An echoed passage never reaches the queue — the tool turns this into a
      // failed result and the model gets another go.
      if (problem) return { index: entry.index, name: entry.msg.name, before, noop: true };
      sink?.(proposal);
      return { index: entry.index, name: entry.msg.name, before, noop: false };
    },

    /* ---- The guide's three, added only when it is switched on ---- */

    readerPlace: () => {
      const app = useAppStore.getState();
      const flatEntries = flatWithIndex(app.chains);
      let here = 0;
      for (let c = 0; c < app.currentChainIndex && c < app.chains.length; c++) {
        here += app.chains[c].messages.length;
      }
      here += app.currentMessageIndex;
      const entry = flatEntries[here];
      return {
        screen: app.screen,
        view: app.viewMode,
        uiMode: app.uiMode,
        readingMode: app.readingMode,
        story: app.currentStory
          ? { title: app.currentStory.title, messages: app.currentStory.messages.length }
          : null,
        // The passage they are actually looking at, so "this bit" means
        // something. Trimmed hard: the guide needs to know WHERE they are, and
        // handing it the whole message every turn is a different feature.
        at: entry
          ? { index: entry.index, name: entry.msg.name, excerpt: entry.msg.content.slice(0, 200) }
          : null,
        aiConnected: !!(app.aiBaseUrl && app.aiModel),
      };
    },

    goTo: ({ view, uiMode, panel }) => {
      const app = useAppStore.getState();
      const done: string[] = [];

      if (uiMode) {
        if (!['read', 'cowrite', 'scenes', 'all'].includes(uiMode)) {
          return { ok: false, error: `No workspace preset called “${uiMode}”.` };
        }
        app.setUiMode(uiMode as UiMode);
        done.push(`workspace preset → ${uiMode}`);
      }

      if (view) {
        if (!VIEW_ORDER.includes(view as ViewMode)) {
          return { ok: false, error: `No view called “${view}”.`, views: [...VIEW_ORDER] };
        }
        if (!app.currentStory) {
          return {
            ok: false,
            error: 'No story is open, so there is no view to switch to.',
            hint: 'Tell the reader to open one from the library first.',
          };
        }
        /**
         * A preset can hide the view being asked for.
         *
         * Switching anyway would drop the reader on a view whose button is not
         * on the bar — they would have no way back to it and no idea how they
         * got there. Widening the preset first is what a person helping would
         * do, and it is said out loud in the result so the guide can mention it.
         */
        if (!viewAllowed(view as ViewMode, useAppStore.getState().uiMode)) {
          app.setUiMode('all');
          done.push('workspace preset → all, because the view is hidden in the current one');
        }
        app.setViewMode(view as ViewMode);
        done.push(`view → ${view}`);
      }

      if (panel) {
        const opened = openGuidePanel(panel);
        if (!opened) {
          return { ok: false, error: `No panel called “${panel}”.`, panels: [...GUIDE_PANELS] };
        }
        done.push(`opened ${panel}`);
      }

      return { ok: true, did: done, now: useAppStore.getState().viewMode };
    },

    setSetting: (key, value) => {
      const app = useAppStore.getState() as unknown as Record<string, unknown>;
      const setter = `set${key.charAt(0).toUpperCase()}${key.slice(1)}`;
      const fn = app[setter];
      if (typeof fn !== 'function') {
        return { ok: false, error: `“${key}” cannot be changed from here.` };
      }
      const was = app[key];
      // Numbers arrive as strings from a text protocol more often than not.
      const spec = GUIDE_SETTINGS.find(s => s.key === key);
      let next: unknown = value;
      if (spec?.kind === 'number') {
        const n = typeof value === 'number' ? value : Number(String(value));
        if (!Number.isFinite(n)) return { ok: false, error: `“${value}” is not a number.` };
        next = n;
      } else if (spec?.kind === 'boolean') {
        next = value === true || value === 'true' || value === 1 || value === '1';
      } else {
        next = String(value);
      }
      (fn as (v: unknown) => void)(next);
      // Read back rather than trust the call: a setter that clamps or rejects
      // has the last word, and the guide should report what actually happened
      // rather than what it asked for.
      const now = (useAppStore.getState() as unknown as Record<string, unknown>)[key];
      return { ok: true, key, was, now, changed: was !== now };
    },
  };
};
