/**
 * One walk over a whole story, resolved the way the reader actually sees it.
 *
 * `storyToMarkdown` — the only whole-story serialiser there has ever been —
 * walks `story.messages` raw: it ignores the Lens override layer (so an export
 * silently discards every rewrite the reader made), ignores `processText` (so
 * `{{user}}`, `[OOC: …]` and metadata tags leak through), ignores `hidden`, and
 * flattens chains. Every one of those is a difference between the file you get
 * and the story you were reading.
 *
 * This is that walk done once, properly, for the exporters to share — the HTML
 * export and the audiobook must not disagree about what the story says.
 */

import type { Chain, Message, MessageOverride, Story } from '../types';
import { resolveContent } from './lens';
import { processText } from './textProcessor';

export interface WalkOptions {
  /** Lens overrides + whether the curated view is on. */
  overrides?: MessageOverride[];
  lensOn?: boolean;
  /** Passed through to `processText`, so the export matches the screen. */
  hideMetadata?: boolean;
  substituteNames?: boolean;
  oocHandling?: 'show' | 'hide' | 'dim';
  smartTypography?: boolean;
  /** Include messages the reader has hidden. Off by default. */
  includeHidden?: boolean;
}

export interface WalkedMessage {
  id: string;
  name: string;
  role: 'user' | 'ai';
  /** Resolved, processed text — markdown, not HTML. */
  text: string;
  images: string[];
  /** Speaker portrait, when the story has one. Always a data URL. */
  avatar?: string;
}

export interface WalkedChapter {
  /** 1-based, for "Chapter 3". */
  index: number;
  /** A scene label when one is known, else undefined — callers title it. */
  label?: string;
  messages: WalkedMessage[];
}

export interface WalkedStory {
  title: string;
  characterName?: string;
  userName?: string;
  chapters: WalkedChapter[];
  /** Every message, flat, for callers that do not care about chapters. */
  messages: WalkedMessage[];
  wordCount: number;
  /**
   * The face of the story, for an export's cover — the character's portrait,
   * else the story's own image. Only ever a data URL: an export that reached
   * out to a remote host for its cover would break the one hard rule the
   * exporters have.
   */
  coverImage?: string;
}

/**
 * @param chains the reader's derived chains (chains are computed at open time,
 *   never stored, so they have to be passed in rather than read off the story).
 */
export const walkStory = (
  story: Story,
  chains: Chain[],
  opts: WalkOptions = {},
): WalkedStory => {
  const chapters: WalkedChapter[] = [];
  const flat: WalkedMessage[] = [];
  let wordCount = 0;

  const resolve = (msg: Message): WalkedMessage | null => {
    if (msg.hidden && !opts.includeHidden) return null;
    const raw = resolveContent(msg, opts.overrides, opts.lensOn ?? false);
    const text = processText(raw, {
      hideMetadata: opts.hideMetadata && !msg.hidden,
      substituteNames: opts.substituteNames,
      characterName: story.characterName,
      userName: story.userName,
      oocHandling: opts.oocHandling,
      smartTypography: opts.smartTypography,
      role: msg.role,
    }).processedText.trim();
    if (!text) return null;
    wordCount += text.split(/\s+/).length;
    // Portraits, in the order the reader sees them: the message's own, then a
    // per-character one (group chats), then the story's side-wide avatar.
    const avatar = msg.avatar
      ?? story.characterAvatars?.[msg.name]
      ?? (msg.role === 'user' ? story.userAvatar : story.characterAvatar)
      ?? (msg.role === 'ai' ? story.avatar : undefined);
    return { id: msg.id, name: msg.name, role: msg.role, text, images: msg.images ?? [], avatar };
  };

  // Chains are the reading structure — a chapter is a chain. Falling back to
  // the flat message list keeps this usable for a caller that has no chains
  // yet (the library, for instance, which never derives them).
  const source: Chain[] = chains.length
    ? chains
    : [{ id: 'all', messages: story.messages, starred: false }];

  for (const chain of source) {
    const messages = chain.messages.map(resolve).filter((m): m is WalkedMessage => !!m);
    if (!messages.length) continue;
    chapters.push({ index: chapters.length + 1, messages });
    flat.push(...messages);
  }

  const cover = [
    story.characterAvatar,
    story.avatar,
    story.characterName ? story.characterAvatars?.[story.characterName] : undefined,
  ].find(src => typeof src === 'string' && src.startsWith('data:'));

  return {
    title: story.title,
    characterName: story.characterName,
    userName: story.userName,
    chapters,
    messages: flat,
    wordCount,
    coverImage: cover,
  };
};

/** Rough listening/reading time, for an export's front matter. */
export const minutesFor = (words: number, wordsPerMinute = 150): number =>
  Math.max(1, Math.round(words / wordsPerMinute));

/**
 * Fold generated scene art into the walk, as `data:` URIs.
 *
 * Generated pictures live as blobs in their own IndexedDB, which is right for
 * the app and useless to an export: `htmlExport` accepts only `data:` (see
 * `isSelfContained`), because a file that reaches out to `blob:` or anywhere
 * else the moment somebody opens it is not self-contained no matter what the
 * footer claims. So the bytes are inlined HERE, once, during the walk both
 * exporters already share.
 *
 * Async and therefore separate from `walkStory`, which is pure and synchronous
 * and used in places that have no business awaiting IndexedDB.
 *
 * @param resolve injected so this is testable without a browser.
 */
export const attachSceneArt = async (
  walked: WalkedStory,
  artByMessage: Record<string, { id: string }[]> | undefined,
  resolve: (artId: string) => Promise<string | null>,
): Promise<WalkedStory> => {
  if (!artByMessage) return walked;
  // One pass over the flat list; chapters share the same message objects, so
  // mutating a copy in place would desynchronise the two views of the story.
  const extras = new Map<string, string[]>();
  for (const m of walked.messages) {
    const rows = artByMessage[m.id];
    if (!rows?.length) continue;
    const uris: string[] = [];
    for (const row of rows) {
      const uri = await resolve(row.id);
      // A picture whose bytes have gone is left out rather than exported as a
      // broken image on somebody else's screen.
      if (uri && uri.startsWith('data:')) uris.push(uri);
    }
    if (uris.length) extras.set(m.id, uris);
  }
  if (!extras.size) return walked;

  const patch = (m: WalkedMessage): WalkedMessage => {
    const extra = extras.get(m.id);
    return extra ? { ...m, images: [...m.images, ...extra] } : m;
  };
  return {
    ...walked,
    messages: walked.messages.map(patch),
    chapters: walked.chapters.map(ch => ({ ...ch, messages: ch.messages.map(patch) })),
  };
};
