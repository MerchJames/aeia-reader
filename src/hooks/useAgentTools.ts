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
import { flushV2, useAuraV2Store } from '../stores/useAuraV2Store';
import { buildZoneBody, flatWithIndex, zoneSummary } from '../utils/contextZone';
import { resolveContent } from '../utils/lens';
import type { MessageRow, ToolContext } from '../utils/agentTools';
import type { Message } from '../types';

/** Hits `story.search` returns before the tool's own limit applies. */
const SEARCH_SCAN_CAP = 400;

/**
 * Assemble the context for one turn.
 *
 * A function rather than a hook, called at send time: every accessor reads
 * `getState()` when the tool runs, so a tool sees the store as it is at that
 * moment rather than as it was when the component last rendered. That matters
 * inside a loop — step four must see the pin version step two wrote.
 */
export const buildToolContext = (storyId: string): ToolContext => {
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
  };
};
