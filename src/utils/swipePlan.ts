/**
 * Which alternate of each message an export carries.
 *
 * SillyTavern stores every regeneration of a message as a "swipe", but it will
 * only let you move between them on the LAST message in the chat. Wanting
 * version 2 of message twelve, with everything after it left alone, means
 * branching the chat and pasting by hand — so the alternates are all sat there
 * in the file, and none of them is reachable.
 *
 * They are reachable here. A plan is one number per message: which alternate
 * that message shows. Nothing else moves. Choosing version 2 of message twelve
 * changes message twelve, and messages one through eleven and thirteen onward
 * are exactly as they were — which is the whole point, and the thing ST's own
 * model of a chat cannot express.
 *
 * Pure: no store, no React. `Record<messageId, index>` is deliberately the same
 * shape as the reader's live `swipeSelections`, so what you picked while
 * reading can seed an export plan and an export plan can be handed back to the
 * reader, without either having to know about the other.
 */

import type { Message } from '../types';

/** messageId → index into that message's `swipes`. */
export type SwipePlan = Record<string, number>;

/** A message that actually has something to choose between. */
export interface Alternate {
  id: string;
  name: string;
  /** Position in reading order, 1-based — the number the app shows elsewhere. */
  index: number;
  swipes: string[];
  /** The one currently chosen. */
  active: number;
  /** True when the plan moves this message off the version ST would show. */
  moved: boolean;
}

/**
 * Which alternate a message is on.
 *
 * Falls back to locating the current content inside `swipes`, because a chat
 * that has never been touched here has no plan at all and ST's own choice is
 * still the right answer. `indexOf` rather than a stored default: `swipe_id` is
 * not something the importer keeps, and the content is authoritative anyway.
 */
export const activeIndex = (msg: Message, plan: SwipePlan = {}): number => {
  const planned = plan[msg.id];
  const count = msg.swipes?.length ?? 0;
  if (planned !== undefined && planned >= 0 && planned < count) return planned;
  const found = msg.swipes?.indexOf(msg.content) ?? -1;
  return found >= 0 ? found : 0;
};

/** The content a message shows under a plan. */
export const resolveSwipe = (msg: Message, plan: SwipePlan = {}): string => {
  if (!msg.swipes || msg.swipes.length < 2) return msg.content;
  return msg.swipes[activeIndex(msg, plan)] ?? msg.content;
};

/** Every message worth offering a choice on, in reading order. */
export const alternates = (messages: readonly Message[], plan: SwipePlan = {}): Alternate[] => {
  const out: Alternate[] = [];
  messages.forEach((msg, i) => {
    if (!msg.swipes || msg.swipes.length < 2) return;
    const active = activeIndex(msg, plan);
    out.push({
      id: msg.id,
      name: msg.name,
      index: i + 1,
      swipes: msg.swipes,
      active,
      // "Moved" means moved off what the FILE shows, not off swipe 0 — a chat
      // where ST last landed on version 3 is not three messages edited.
      moved: active !== (msg.swipes.indexOf(msg.content) >= 0 ? msg.swipes.indexOf(msg.content) : 0),
    });
  });
  return out;
};

/**
 * Drop anything a plan names that no longer exists.
 *
 * A plan outlives the story it was made against — a re-import, a branch merge,
 * an edited swipe list. An index past the end of `swipes` would otherwise fall
 * through `resolveSwipe`'s `?? msg.content` and silently export the wrong
 * version while the panel showed the right one.
 */
export const clampPlan = (plan: SwipePlan, messages: readonly Message[]): SwipePlan => {
  const byId = new Map(messages.map(m => [m.id, m]));
  const out: SwipePlan = {};
  for (const [id, idx] of Object.entries(plan)) {
    const msg = byId.get(id);
    const count = msg?.swipes?.length ?? 0;
    if (count > 1 && Number.isInteger(idx) && idx >= 0 && idx < count) out[id] = idx;
  }
  return out;
};

/**
 * The messages with a plan applied — for the exporters that walk
 * `story.messages` rather than the reader's chains.
 *
 * Returns the SAME array when the plan changes nothing, so a caller can use
 * reference equality to skip work, and so an export with no plan is provably
 * the export it always was.
 */
export const applyPlan = (messages: readonly Message[], plan: SwipePlan): Message[] => {
  const clamped = clampPlan(plan, messages);
  if (!Object.keys(clamped).length) return messages as Message[];
  let changed = false;
  const out = messages.map(m => {
    const content = resolveSwipe(m, clamped);
    if (content === m.content) return m;
    changed = true;
    return { ...m, content };
  });
  return changed ? out : (messages as Message[]);
};

/** One line for a panel: how much of the story a plan actually moves. */
export const planSummary = (messages: readonly Message[], plan: SwipePlan): string => {
  const alts = alternates(messages, plan);
  if (!alts.length) return 'No message in this story has alternates.';
  const moved = alts.filter(a => a.moved).length;
  const total = alts.length;
  const has = total === 1 ? '1 message has' : `${total} messages have`;
  return moved === 0
    ? `${has} alternates; none changed.`
    : `${moved} of ${total} changed.`;
};
