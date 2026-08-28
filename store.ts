import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  AppConfig, AppState, Chain, ChainStarSettings, Message, Story, StoryFormat, StoryTimeline, UiMode,
} from './types';
import { ParsedCard, parseCompanionCard, parseFile } from './utils/parser';
import { deleteStory, getAllStoryMetas, getStory, putStory } from './lib/storage';
import { parseCut } from './utils/cut';
import { openCut } from './utils/openCut';
import {
  MIN_SHARED_PREFIX, groupBranchFamilies, timelineMessages, toTimeline,
} from './utils/branchMerge';
import { configForMode, nearestMode } from './utils/readingModes';
import {
  VIEW_GROUP, VIEW_ORDER, isReadingView, moveView, resolveVisibleViews, toggleView,
} from './utils/viewBar';
import { MARKUP_DEFAULTS, sanitizeMarkupPresets } from './utils/markupStyles';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const buildChains = (
  messages: Message[],
  format: StoryFormat,
  stars?: Record<string, ChainStarSettings>,
): Chain[] => {
  const chains: Chain[] = [];
  let current: Chain | null = null;

  const startChain = (msg: Message) => {
    if (current) chains.push(current);
    const id = `chain-${msg.id}`;
    current = {
      id,
      messages: [msg],
      starred: !!stars?.[id],
      starSettings: stars?.[id],
    };
  };

  messages.forEach(msg => {
    // Kobold saves are continuous prose: every action is its own "page".
    // Documents open a new chain (page) at each chapter break (startsChain).
    if (!current || msg.role === 'user' || format === 'kobold' || msg.startsChain) {
      startChain(msg);
    } else {
      current.messages.push(msg);
    }
  });
  if (current) chains.push(current);
  return chains;
};

const collectStars = (chains: Chain[]): Record<string, ChainStarSettings> => {
  const stars: Record<string, ChainStarSettings> = {};
  chains.forEach(c => {
    if (c.starred) stars[c.id] = c.starSettings ?? {};
  });
  return stars;
};

/** Messages up to and including position [ci][mi], respecting the layout. */
const visibleThrough = (
  chains: Chain[], ci: number, mi: number, layoutMode: 'continuous' | 'paginated',
): Message[] => {
  const out: Message[] = [];
  if (layoutMode === 'continuous') {
    for (let c = 0; c < ci; c++) out.push(...chains[c].messages);
  }
  out.push(...(chains[ci]?.messages.slice(0, mi + 1) ?? []));
  return out;
};

const nextPosition = (chains: Chain[], ci: number, mi: number) => {
  if (chains[ci] && mi + 1 < chains[ci].messages.length) return { ci, mi: mi + 1 };
  if (ci + 1 < chains.length) return { ci: ci + 1, mi: 0 };
  return null;
};

const prevPosition = (chains: Chain[], ci: number, mi: number) => {
  if (mi > 0) return { ci, mi: mi - 1 };
  if (ci > 0) return { ci: ci - 1, mi: chains[ci - 1].messages.length - 1 };
  return null;
};

/** Messages shown before the message at [ci][mi] starts streaming. */
const visibleBefore = (
  chains: Chain[], ci: number, mi: number, layoutMode: 'continuous' | 'paginated',
): Message[] => {
  const prev = prevPosition(chains, ci, mi);
  if (!prev) return [];
  // In paginated mode a new chain starts a fresh page.
  if (layoutMode === 'paginated' && prev.ci !== ci) return [];
  return visibleThrough(chains, prev.ci, prev.mi, layoutMode);
};

const findMessage = (chains: Chain[], id: string) => {
  for (let c = 0; c < chains.length; c++) {
    const m = chains[c].messages.findIndex(msg => msg.id === id);
    if (m !== -1) return { ci: c, mi: m };
  }
  return null;
};

const newId = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const CONFIG_KEYS: (keyof AppConfig)[] = [
  'theme', 'accentColor', 'fontFamily', 'fontSize', 'textColor', 'bgColor', 'animationStyle', 'streamEffect',
  'expressiveText', 'cinematicPacing', 'expressiveIntensity', 'dropCaps', 'sceneTheming',
  'sceneSoundscapes', 'emotionalTts', 'sceneEmphasis', 'scenePerformance', 'aiRepairFormatting',
  'hideMetadata', 'showImages', 'autofocusAutoZoom', 'focusMagnifier', 'magnifierStyle',
  'askCharacter', 'onboarded',
  'playbackSpeed', 'autoStream', 'autoFormat', 'autoFormatRules', 'statRules',
  'paragraphSpacing', 'dialogueOwnLine', 'smartTypography',
  'styleQuotes', 'substituteNames', 'dialogueColor', 'dialogueStyle', 'dialogueAnimation',
  'markupPresets', 'characterColorsEnabled', 'characterColors', 'characterChannelColors',
  'contentWidth', 'oocHandling', 'phoneDialogueOnly', 'themeEffects', 'livingBackground',
  'readingMode', 'visibleViews',
  'revealMode', 'messagePause', 'pauseAtPageEnd', 'ttsEnabled', 'ttsVoiceURI', 'ttsRate',
  'ttsPitch', 'ttsFollowSpeed', 'ttsMultiVoice', 'ttsDialogueOnly', 'aiBaseUrl', 'aiApiKey', 'aiModel', 'aiAdvanced',
  'ttsEngine', 'kokoroBaseUrl', 'kokoroApiKey', 'kokoroVoice', 'kokoroUserVoice', 'ttsVoiceByCharacter',
  'liveReaction', 'liveReactor', 'liveReactionVisibility', 'liveReactionFreeze',
  'liveReactionFrame',
  'audioBaseUrl', 'audioCuesEnabled', 'audioLiveGen', 'sceneMusic', 'musicVolume', 'sfxPermissiveness',
  'imageBaseUrl', 'imageApiKey', 'imageAdapter', 'imageModel', 'comfyWorkflow', 'comfyMapping',
  'imagePreset', 'imageNegativeExtra',
  'autoCastVoices', 'ambientEnabled', 'ambientVolume', 'ambientByTheme',
  'uiMode',
];

const pickConfig = (state: AppState): AppConfig => {
  const config = {} as Record<string, unknown>;
  CONFIG_KEYS.forEach(k => { config[k] = state[k]; });
  return config as unknown as AppConfig;
};

let persistTimer: ReturnType<typeof setTimeout> | null = null;

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => {
      /** Snapshot current reading state back onto the story record. */
      const buildStorySnapshot = (): Story | null => {
        const { currentStory, chains, currentChainIndex, currentMessageIndex } = get();
        if (!currentStory) return null;
        // While a timeline (attached branch) is being read, the chains show
        // the overlay — NEVER write that back over the trunk's messages.
        const messages = currentStory.activeTimeline
          ? currentStory.messages
          : chains.flatMap(c => c.messages);
        let readCount = 0;
        for (let c = 0; c < currentChainIndex; c++) readCount += chains[c]?.messages.length ?? 0;
        readCount += currentMessageIndex + (get().streamingMessage ? 0 : 1);
        return {
          ...currentStory,
          messages,
          messageCount: messages.length,
          stars: collectStars(chains),
          progress: { chainIndex: currentChainIndex, messageIndex: currentMessageIndex },
          progressPct: messages.length
            ? Math.min(100, Math.round((readCount / messages.length) * 100))
            : 0,
        };
      };

      const persistNow = () => {
        const snapshot = buildStorySnapshot();
        if (!snapshot) return;
        set({
          currentStory: snapshot,
          library: get().library.map(m =>
            m.id === snapshot.id
              ? {
                  ...m,
                  progress: snapshot.progress,
                  progressPct: snapshot.progressPct,
                  messageCount: snapshot.messageCount,
                }
              : m,
          ),
        });
        void putStory(snapshot).catch(e => console.error('Failed to save story', e));
      };

      const schedulePersist = () => {
        if (persistTimer) clearTimeout(persistTimer);
        persistTimer = setTimeout(persistNow, 800);
      };

      return {
        /* ----- config defaults ----- */
        theme: 'dark',
        accentColor: '',
        fontFamily: 'theme',
        fontSize: 16,
        textColor: '#ffffff',
        bgColor: '#111827',
        animationStyle: 'typewriter',
        streamEffect: 'none',
        expressiveText: false,
        cinematicPacing: false,
        expressiveIntensity: 'subtle',
        dropCaps: false,
        sceneTheming: false,
        sceneSoundscapes: false,
        emotionalTts: false,
        sceneEmphasis: false,
        scenePerformance: false,
        aiRepairFormatting: true,
        hideMetadata: true,
        showImages: true,
        autofocusAutoZoom: true,
        focusMagnifier: false,
        magnifierStyle: 'light',
        askCharacter: false,
        onboarded: false,
        playbackSpeed: 50,
        autoStream: true,
        autoFormat: true,
        autoFormatRules: [],
        statRules: [],
        paragraphSpacing: true,
        dialogueOwnLine: false,
        smartTypography: false,
        styleQuotes: true,
        substituteNames: true,
        revealMode: 'character',
        messagePause: 400,
        pauseAtPageEnd: false,
        ttsEnabled: false,
        ttsVoiceURI: '',
        ttsRate: 1,
        ttsPitch: 1,
        ttsFollowSpeed: true,
        ttsMultiVoice: true,
        ttsDialogueOnly: false,
        ttsEngine: 'browser',
        kokoroBaseUrl: 'http://localhost:8880',
        audioBaseUrl: 'http://localhost:8899',
        liveReaction: false,
        liveReactor: '',
        liveReactionVisibility: 'upTo',
        liveReactionFreeze: false,
        liveReactionFrame: 'room',
        reactionHold: false,
        audioCuesEnabled: false,
        audioLiveGen: false,
        // Scene images: off until an address is set. No default port — unlike
        // the two audio services there is no single obvious one (ComfyUI is
        // 8188, an OpenAI-compatible host is anywhere), and guessing would show
        // a red "not answering" to every reader who never asked for this.
        imageBaseUrl: '',
        imageApiKey: '',
        imageAdapter: 'comfy',
        imageModel: '',
        comfyWorkflow: '',
        comfyMapping: {},
        imagePreset: 'sdxl',
        imageNegativeExtra: '',
        sceneMusic: true,
        musicVolume: 0.6,
        sfxPermissiveness: 'off',
        librarySoundscapeActive: false,
        recentSfx: [],
        midSceneLocation: null,
        kokoroApiKey: '',
        kokoroVoice: 'af_bella',
        kokoroUserVoice: 'am_michael',
        ttsVoiceByCharacter: {},
        autoCastVoices: true,
        ambientEnabled: false,
        ambientVolume: 0.35,
        ambientByTheme: {},
        dialogueColor: 'text-indigo-600 dark:text-indigo-300',
        dialogueStyle: 'normal',
        markupPresets: MARKUP_DEFAULTS,
        dialogueAnimation: 'none',
        characterColorsEnabled: false,
        characterColors: {},
        characterChannelColors: {},
        contentWidth: 0,
        oocHandling: 'show',
        phoneDialogueOnly: false,
        themeEffects: true,
        pressToAdvance: false,
        livingBackground: false,
        aiBaseUrl: '',
        aiApiKey: '',
        aiModel: '',
        aiAdvanced: {
          streaming: true,
          systemPrompt: '',
          contextTemplate: '',
          contextSize: 0,
          maxTokens: 0,
          extendedSamplers: false,
          temperature: null,
          topP: null,
          topK: null,
          minP: null,
          repetitionPenalty: null,
          frequencyPenalty: null,
          presencePenalty: null,
        },

        /* ----- library ----- */
        screen: 'library',
        library: [],
        libraryLoaded: false,
        currentStory: null,

        /* ----- playback ----- */
        chains: [],
        visibleMessages: [],
        streamingMessage: null,
        streamedText: '',
        revealComplete: false,
        currentChainIndex: 0,
        currentMessageIndex: 0,
        isStreaming: false,

        /* ----- view ----- */
        viewMode: 'chat',
        uiMode: 'read',
        readingMode: 'plain',
        visibleViews: null,
        layoutMode: 'continuous',
        searchQuery: '',
        isAutofocusMode: false,
        autofocusZoom: 1,
        autofocusPanX: 0,
        isHighlightMode: false,
        isBoxMode: false,
        reverseStream: false,
        controlsMinimized: false,
        settingsOpen: false,
        savedConfigs: {},
        ttsPending: false,
        awaitingAdvance: false,
        awaitingInput: false,
        viewHold: false,
        ttsProgress: 1,
        swipeSelections: {},
        aiOpen: false,
        lensEditTarget: null,
        lensEditFocus: null,

        /* ----- library actions ----- */

        initLibrary: async () => {
          try {
            const library = await getAllStoryMetas();
            set({ library, libraryLoaded: true });
          } catch (e) {
            console.error('Failed to load library', e);
            set({ libraryLoaded: true });
          }
        },

        importFiles: async (files: File[], cardFiles: File[] = []) => {
          const errors: string[] = [];
          const imported: Story[] = [];
          const notesEarly: string[] = [];
          // Counted before Cuts are peeled off, so "one file, open it" still
          // holds for a Cut — otherwise dropping one in lands you back on the
          // library with a note, wondering whether it worked.
          const droppedCount = files.length;

          // A Cut is a story AND the way it was directed, so it cannot go
          // through the parser — there is nothing to parse, and the direction
          // has to land in the v2 store beside the story rather than inside it.
          // Peeled off here, before anything else looks at the batch.
          const rest: File[] = [];
          for (const file of files) {
            if (!/\.cut\.json$/i.test(file.name)) { rest.push(file); continue; }
            try {
              const { cut, error } = parseCut(await file.text());
              if (!cut || error) { errors.push(`${file.name}: ${error ?? 'not a Cut'}`); continue; }
              const story = await openCut(cut);
              imported.push(story);
              const bits = Object.keys(cut.direction).length;
              notesEarly.push(
                `“${story.title}” opened from a Cut — ${bits} layer${bits === 1 ? '' : 's'} of `
                + 'direction came with it, so it reads fully with no endpoint set.',
              );
            } catch (e: any) {
              errors.push(`${file.name}: ${e?.message ?? 'could not be opened'}`);
            }
          }
          files = rest;

          // Companion character cards, matched to stories after parsing.
          const companions: ParsedCard[] = [];
          for (const cf of cardFiles) {
            try {
              companions.push(await parseCompanionCard(cf));
            } catch (e: any) {
              errors.push(e?.message ?? `${cf.name}: failed to read card`);
            }
          }
          const matchCompanion = (story: {
            characterName?: string; title: string;
          }): ParsedCard | undefined => {
            // A single card with a single story always pairs up; otherwise
            // match the card's name against the story's character / title.
            if (companions.length === 1 && files.length === 1) return companions[0];
            const norm = (s?: string) => (s ?? '').trim().toLowerCase();
            return companions.find(c =>
              norm(c.name) &&
              (norm(c.name) === norm(story.characterName) ||
               norm(story.title).includes(norm(c.name))));
          };

          // Parse everything first — branch grouping needs the whole batch.
          const notes: string[] = [...notesEarly];
          const parsedFiles: { file: File; parsed: Awaited<ReturnType<typeof parseFile>> }[] = [];
          for (const file of files) {
            try {
              const parsed = await parseFile(file);
              if (parsed.messages.length === 0) {
                errors.push(`${file.name}: no messages found`);
                continue;
              }
              parsedFiles.push({ file, parsed });
            } catch (e: any) {
              errors.push(`${file.name}: ${e?.message ?? 'failed to parse'}`);
            }
          }

          const makeStory = (
            parsed: (typeof parsedFiles)[number]['parsed'],
            messages: Message[],
            timelines?: StoryTimeline[],
          ): Story => {
            const companion = matchCompanion(parsed);
            return {
              id: newId(),
              title: parsed.title,
              format: parsed.format,
              characterName: parsed.characterName ?? companion?.info.name,
              userName: parsed.userName,
              avatar: parsed.avatar ?? companion?.avatar,
              characterAvatar: companion?.avatar,
              messages,
              messageCount: messages.length,
              importedAt: Date.now(),
              progress: null,
              highlights: [],
              stars: {},
              card: parsed.card ?? companion?.info,
              tags: (parsed.card ?? companion?.info)?.tags,
              timelines: timelines?.length ? timelines : undefined,
            };
          };

          // SillyTavern keeps each branch as its own chat file. Files in this
          // batch that share history become ONE story with attached timelines;
          // a lone file whose history matches a library story attaches to it.
          const stEntries = parsedFiles.filter(p => p.parsed.format === 'sillytavern');
          const otherEntries = parsedFiles.filter(p => p.parsed.format !== 'sillytavern');

          const tryAttachToLibrary = async (
            entry: (typeof parsedFiles)[number],
          ): Promise<boolean> => {
            const cand = { name: entry.file.name, messages: entry.parsed.messages };
            const metas = get().library.filter(m =>
              m.format === 'sillytavern' &&
              m.messageCount >= MIN_SHARED_PREFIX &&
              (!m.characterName || !entry.parsed.characterName ||
                m.characterName === entry.parsed.characterName)).slice(0, 12);
            for (const meta of metas) {
              const existing = await getStory(meta.id);
              if (!existing) continue;
              const res = toTimeline(existing.messages, cand);
              if (res === 'absorbed') {
                notes.push(`${entry.file.name} is already part of “${existing.title}” — skipped`);
                return true;
              }
              if (res) {
                const updated: Story = {
                  ...existing,
                  timelines: [...(existing.timelines ?? []), res],
                };
                await putStory(updated);
                if (get().currentStory?.id === updated.id) set({ currentStory: updated });
                notes.push(`${entry.file.name} attached as a branch of “${existing.title}”`);
                return true;
              }
            }
            return false;
          };

          try {
            const families = groupBranchFamilies(
              stEntries.map(p => ({ name: p.file.name, messages: p.parsed.messages })),
            );
            for (const fam of families) {
              const entry = stEntries[fam.trunkIndex];
              const isLone = fam.timelines.length === 0 && fam.absorbed.length === 0;
              if (isLone && (await tryAttachToLibrary(entry))) continue;
              const story = makeStory(entry.parsed, entry.parsed.messages, fam.timelines);
              await putStory(story);
              imported.push(story);
              if (fam.timelines.length > 0) {
                notes.push(`“${story.title}”: attached ${fam.timelines.length} branch${
                  fam.timelines.length === 1 ? '' : 'es'} from this batch`);
              }
              for (const name of fam.absorbed) {
                notes.push(`${name} is an earlier checkpoint of “${story.title}” — skipped`);
              }
            }
            for (const entry of otherEntries) {
              const story = makeStory(entry.parsed, entry.parsed.messages);
              await putStory(story);
              imported.push(story);
            }
          } catch (e: any) {
            errors.push(e?.message ?? 'import failed');
          }

          if (imported.length > 0) {
            const metas = imported.map(
              ({ messages: _m, highlights: _h, stars: _s, card: _c, timelines: _t, ...meta }) => meta);
            set({ library: [...metas, ...get().library] });
          }
          if (imported.length === 1 && droppedCount === 1) {
            await get().openStory(imported[0].id);
          }
          return { imported: imported.length, errors, notes };
        },

        setActiveTimeline: (timelineId) => {
          const cs = get().currentStory;
          if (!cs || (cs.activeTimeline ?? null) === timelineId) return;
          // Landing point: the fork where the chosen path diverges (or where
          // the one being left diverged, when returning to the trunk).
          const landmark = cs.timelines?.find(
            t => t.id === (timelineId ?? cs.activeTimeline));
          const story: Story = { ...cs, activeTimeline: timelineId };
          const msgs = timelineMessages(story);
          const chains = buildChains(msgs, story.format, story.stars);
          const target = Math.min(landmark?.forkIndex ?? 0, Math.max(0, msgs.length - 1));
          let ci = 0, mi = 0, seen = 0;
          outer: for (let c = 0; c < chains.length; c++) {
            for (let m = 0; m < chains[c].messages.length; m++) {
              if (seen === target) { ci = c; mi = m; break outer; }
              seen++;
            }
          }
          const vm = get().viewMode;
          set({
            currentStory: story,
            chains,
            currentChainIndex: ci,
            currentMessageIndex: mi,
            visibleMessages: visibleThrough(chains, ci, mi, get().layoutMode),
            streamingMessage: null,
            streamedText: '',
            isStreaming: false,
            // "Read this timeline" means READ — leave list views for the text.
            viewMode: isReadingView(vm) ? vm : 'chat',
          });
          schedulePersist();
        },

        removeTimeline: (timelineId) => {
          const cs = get().currentStory;
          if (!cs) return;
          if ((cs.activeTimeline ?? null) === timelineId) get().setActiveTimeline(null);
          const now = get().currentStory!;
          const story: Story = {
            ...now,
            timelines: (now.timelines ?? []).filter(t => t.id !== timelineId),
          };
          set({ currentStory: story });
          void putStory(story).catch(e => console.error('Failed to save story', e));
        },

        snipTimelineToStory: async (timelineId) => {
          const cs = get().currentStory;
          const tl = cs?.timelines?.find(t => t.id === timelineId);
          if (!cs || !tl) return;
          // A COPY — the tree it came from is untouched.
          const messages = [...cs.messages.slice(0, tl.forkIndex), ...tl.messages]
            .map(m => ({ ...m }));
          const story: Story = {
            id: newId(),
            title: `${cs.title} · ${tl.name}`,
            format: cs.format,
            characterName: cs.characterName,
            userName: cs.userName,
            avatar: cs.avatar,
            characterAvatar: cs.characterAvatar,
            userAvatar: cs.userAvatar,
            characterAvatars: cs.characterAvatars,
            messages,
            messageCount: messages.length,
            importedAt: Date.now(),
            progress: null,
            highlights: [],
            stars: {},
            card: cs.card,
            tags: cs.tags,
          };
          await putStory(story);
          const { messages: _m, highlights: _h, stars: _s, card: _c, ...meta } = story;
          set({ library: [meta, ...get().library] });
        },

        openStory: async (id: string) => {
          const story = await getStory(id);
          if (!story) return;

          const { autoStream, layoutMode, viewMode } = get();
          // Read through the story's active timeline (attached branch), if any.
          const chains = buildChains(timelineMessages(story), story.format, story.stars);
          const proseFormat = story.format === 'kobold' || story.format === 'document';
          const readingView = isReadingView(viewMode)
            ? viewMode
            : (proseFormat ? 'storybook' : 'chat');

          const base = {
            currentStory: story,
            chains,
            screen: 'reader' as const,
            viewMode: readingView,
            searchQuery: '',
            streamedText: '',
            reverseStream: false,
          };

          const p = story.progress;
          const resumeTarget = p ? chains[p.chainIndex]?.messages[p.messageIndex] : undefined;

          if (resumeTarget && p) {
            // Resume: everything before the saved position is shown, the saved
            // message streams next.
            set({
              ...base,
              visibleMessages: visibleBefore(chains, p.chainIndex, p.messageIndex, layoutMode),
              streamingMessage: resumeTarget,
              currentChainIndex: p.chainIndex,
              currentMessageIndex: p.messageIndex,
              isStreaming: autoStream,
            });
          } else if (autoStream) {
            set({
              ...base,
              visibleMessages: [],
              streamingMessage: chains[0]?.messages[0] ?? null,
              currentChainIndex: 0,
              currentMessageIndex: 0,
              isStreaming: true,
            });
          } else {
            const ci = layoutMode === 'continuous' ? chains.length - 1 : 0;
            const mi = (chains[ci]?.messages.length ?? 1) - 1;
            set({
              ...base,
              visibleMessages: visibleThrough(chains, ci, mi, layoutMode),
              streamingMessage: null,
              currentChainIndex: ci,
              currentMessageIndex: mi,
              isStreaming: false,
            });
          }
        },

        closeStory: () => {
          if (persistTimer) clearTimeout(persistTimer);
          persistNow();
          set({
            screen: 'library',
            currentStory: null,
            chains: [],
            visibleMessages: [],
            streamingMessage: null,
            streamedText: '',
            currentChainIndex: 0,
            currentMessageIndex: 0,
            isStreaming: false,
            isAutofocusMode: false,
            searchQuery: '',
          });
        },

        deleteStoryById: async (id: string) => {
          await deleteStory(id);
          set({ library: get().library.filter(m => m.id !== id) });
          if (get().currentStory?.id === id) {
            set({
              screen: 'library', currentStory: null, chains: [], visibleMessages: [],
              streamingMessage: null, streamedText: '', isStreaming: false,
            });
          }
        },

        renameStory: async (id, title) => {
          const name = title.trim();
          if (!name) return;
          // Written to the stored record AND to the in-memory copies, so the
          // library card, the header and the next boot all agree at once.
          const stored = await getStory(id);
          if (stored) await putStory({ ...stored, title: name });
          set({
            library: get().library.map(m => (m.id === id ? { ...m, title: name } : m)),
            currentStory: get().currentStory?.id === id
              ? { ...get().currentStory!, title: name }
              : get().currentStory,
          });
        },

        persistStoryState: () => schedulePersist(),

        /* ----- playback actions ----- */

        setIsStreaming: (on) => {
          if (!on) {
            set({ isStreaming: false, awaitingAdvance: false });
            schedulePersist();
            return;
          }
          const { streamingMessage, chains, currentChainIndex: ci, currentMessageIndex: mi, layoutMode } = get();
          if (chains.length === 0) return;

          if (streamingMessage) {
            set({ isStreaming: true });
            return;
          }
          // Paused with the current position fully shown: continue with the
          // next message, or restart from the top if we're at the end.
          const next = nextPosition(chains, ci, mi);
          if (next) {
            set({
              isStreaming: true,
              streamingMessage: chains[next.ci].messages[next.mi],
              streamedText: '',
              currentChainIndex: next.ci,
              currentMessageIndex: next.mi,
              visibleMessages: layoutMode === 'paginated' && next.ci !== ci
                ? []
                : get().visibleMessages,
            });
          } else {
            set({
              isStreaming: true,
              visibleMessages: [],
              streamingMessage: chains[0]?.messages[0] ?? null,
              streamedText: '',
              currentChainIndex: 0,
              currentMessageIndex: 0,
            });
          }
        },

        setPlaybackSpeed: (playbackSpeed) => set({ playbackSpeed }),

        advanceMessage: () => {
          const {
            chains, currentChainIndex: ci, currentMessageIndex: mi,
            streamingMessage, visibleMessages, layoutMode,
          } = get();
          if (!streamingMessage) {
            set({ isStreaming: false });
            return;
          }
          const committed = [...visibleMessages, streamingMessage];
          const next = nextPosition(chains, ci, mi);
          if (!next) {
            set({ visibleMessages: committed, streamingMessage: null, streamedText: '', isStreaming: false });
            schedulePersist();
            return;
          }
          // Optionally stop at the end of each page; play/next-page resumes.
          if (next.ci !== ci && get().layoutMode === 'paginated' && get().pauseAtPageEnd) {
            set({ visibleMessages: committed, streamingMessage: null, streamedText: '', isStreaming: false });
            schedulePersist();
            return;
          }
          set({
            visibleMessages: layoutMode === 'paginated' && next.ci !== ci ? [] : committed,
            streamingMessage: chains[next.ci].messages[next.mi],
            streamedText: '',
            currentChainIndex: next.ci,
            currentMessageIndex: next.mi,
          });
          schedulePersist();
        },

        updateStreamedText: (streamedText) => set({ streamedText, revealComplete: false }),

        finishCurrentMessage: (fullText) => {
          const { streamingMessage } = get();
          // Commit the PROCESSED text the reveal was showing (paragraph spacing,
          // dialogue-own-line, name substitution) — not the raw content, which
          // would flip the just-finished message back to unformatted source.
          if (streamingMessage) {
            set({ streamedText: fullText ?? streamingMessage.content, revealComplete: true });
          }
        },

        resetPlayback: () => {
          const { autoStream, layoutMode, chains } = get();
          if (chains.length === 0) return;
          if (autoStream) {
            set({
              visibleMessages: [],
              streamingMessage: chains[0]?.messages[0] ?? null,
              streamedText: '',
              currentChainIndex: 0,
              currentMessageIndex: 0,
              isStreaming: false,
            });
          } else {
            const ci = layoutMode === 'continuous' ? chains.length - 1 : 0;
            const mi = (chains[ci]?.messages.length ?? 1) - 1;
            set({
              visibleMessages: visibleThrough(chains, ci, mi, layoutMode),
              streamingMessage: null,
              streamedText: '',
              currentChainIndex: ci,
              currentMessageIndex: mi,
              isStreaming: false,
            });
          }
          schedulePersist();
        },

        restreamFromId: (id) => {
          const { chains, layoutMode, viewMode } = get();
          const pos = findMessage(chains, id);
          if (!pos) return;
          set({
            visibleMessages: visibleBefore(chains, pos.ci, pos.mi, layoutMode),
            streamingMessage: chains[pos.ci].messages[pos.mi],
            streamedText: '',
            currentChainIndex: pos.ci,
            currentMessageIndex: pos.mi,
            isStreaming: true,
            viewMode: viewMode === 'overview' || viewMode === 'highlights' ? 'chat' : viewMode,
          });
          schedulePersist();
        },

        jumpToMessage: (id) => {
          const { chains, layoutMode, viewMode } = get();
          const pos = findMessage(chains, id);
          if (!pos) return;
          set({
            visibleMessages: visibleThrough(chains, pos.ci, pos.mi, layoutMode),
            streamingMessage: null,
            streamedText: '',
            currentChainIndex: pos.ci,
            currentMessageIndex: pos.mi,
            isStreaming: false,
            viewMode: viewMode === 'overview' || viewMode === 'highlights' ? 'chat' : viewMode,
          });
          schedulePersist();
        },

        fastForward: () => {
          const { chains, layoutMode, currentChainIndex } = get();
          if (chains.length === 0) return;
          const ci = layoutMode === 'paginated' ? currentChainIndex : chains.length - 1;
          const mi = (chains[ci]?.messages.length ?? 1) - 1;
          set({
            visibleMessages: visibleThrough(chains, ci, mi, layoutMode),
            streamingMessage: null,
            streamedText: '',
            currentChainIndex: ci,
            currentMessageIndex: mi,
            isStreaming: false,
          });
          schedulePersist();
        },

        nextPage: () => {
          const { chains, currentChainIndex, autoStream } = get();
          const target = currentChainIndex + 1;
          if (target >= chains.length) return;
          const chain = chains[target];
          if (autoStream) {
            set({
              visibleMessages: [],
              streamingMessage: chain.messages[0],
              streamedText: '',
              currentChainIndex: target,
              currentMessageIndex: 0,
              isStreaming: true,
            });
          } else {
            set({
              visibleMessages: chain.messages,
              streamingMessage: null,
              streamedText: '',
              currentChainIndex: target,
              currentMessageIndex: chain.messages.length - 1,
              isStreaming: false,
            });
          }
          schedulePersist();
        },

        prevPage: () => {
          const { chains, currentChainIndex, autoStream } = get();
          const target = currentChainIndex - 1;
          if (target < 0) return;
          const chain = chains[target];
          if (autoStream) {
            set({
              visibleMessages: [],
              streamingMessage: chain.messages[0],
              streamedText: '',
              currentChainIndex: target,
              currentMessageIndex: 0,
              isStreaming: true,
            });
          } else {
            set({
              visibleMessages: chain.messages,
              streamingMessage: null,
              streamedText: '',
              currentChainIndex: target,
              currentMessageIndex: chain.messages.length - 1,
              isStreaming: false,
            });
          }
          schedulePersist();
        },

        /* ----- chains ----- */

        reorderChains: (newChains) => {
          set({ chains: newChains });
          schedulePersist();
        },

        toggleStarChain: (chainId) => {
          set({
            chains: get().chains.map(c =>
              c.id === chainId ? { ...c, starred: !c.starred } : c,
            ),
          });
          schedulePersist();
        },

        updateStarSettings: (chainId, settings) => {
          set({
            chains: get().chains.map(c =>
              c.id === chainId ? { ...c, starSettings: { ...c.starSettings, ...settings } } : c,
            ),
          });
          schedulePersist();
        },

        /* ----- highlights ----- */

        addHighlight: (highlight) => {
          const { currentStory } = get();
          if (!currentStory) return;
          set({
            currentStory: {
              ...currentStory,
              highlights: [...(currentStory.highlights ?? []), highlight],
            },
          });
          schedulePersist();
        },

        removeHighlight: (id) => {
          const { currentStory } = get();
          if (!currentStory) return;
          set({
            currentStory: {
              ...currentStory,
              highlights: (currentStory.highlights ?? []).filter(h => h.id !== id),
            },
          });
          schedulePersist();
        },

        /* ----- view / settings ----- */

        setViewMode: (viewMode) => set({ viewMode }),
        setUiMode: (uiMode) => set({ uiMode }),

        // Picking a mode WRITES its keys and records the choice. Everything it
        // touches stays individually reachable in Advanced; changing one there
        // leaves the intent alone and surfaces as "… · modified".
        setReadingMode: (readingMode) => set({ ...configForMode(readingMode), readingMode }),

        // The bar is the reader's from the first pin: `visibleViews` starts null
        // (follow the preset) and any edit resolves it to an explicit list that
        // the preset never overwrites again.
        toggleVisibleView: (view) => {
          const { visibleViews, uiMode, viewMode } = get();
          set({ visibleViews: toggleView(resolveVisibleViews(visibleViews, uiMode, viewMode), view) });
        },
        moveVisibleView: (view, direction) => {
          const { visibleViews, uiMode, viewMode } = get();
          set({ visibleViews: moveView(resolveVisibleViews(visibleViews, uiMode, viewMode), view, direction) });
        },
        resetVisibleViews: () => set({ visibleViews: null }),

        setLayoutMode: (layoutMode) => {
          const { chains, currentChainIndex: ci, currentMessageIndex: mi, streamingMessage } = get();
          if (chains.length === 0) {
            set({ layoutMode });
            return;
          }
          if (streamingMessage) {
            set({ layoutMode, visibleMessages: visibleBefore(chains, ci, mi, layoutMode) });
          } else {
            set({ layoutMode, visibleMessages: visibleThrough(chains, ci, mi, layoutMode) });
          }
        },

        setTheme: (theme) => set({ theme }),
        setAccentColor: (accentColor) => set({ accentColor }),
        setShowImages: (showImages) => set({ showImages }),
        setAutofocusAutoZoom: (autofocusAutoZoom) => set({ autofocusAutoZoom }),
        setFocusMagnifier: (focusMagnifier) => set({ focusMagnifier }),
        setMagnifierStyle: (magnifierStyle) => set({ magnifierStyle }),
        setAskCharacter: (askCharacter) => set({ askCharacter }),
        setOnboarded: (onboarded) => set({ onboarded }),
        setFontFamily: (fontFamily) => set({ fontFamily }),
        setFontSize: (fontSize) => set({ fontSize }),
        setTextColor: (textColor) => set({ textColor, theme: 'custom' }),
        setBgColor: (bgColor) => set({ bgColor, theme: 'custom' }),
        setAnimationStyle: (animationStyle) => set({ animationStyle }),
        setStreamEffect: (streamEffect) => set({ streamEffect }),
        setExpressiveText: (expressiveText) => set({ expressiveText }),
        setCinematicPacing: (cinematicPacing) => set({ cinematicPacing }),
        setExpressiveIntensity: (expressiveIntensity) => set({ expressiveIntensity }),
        setDropCaps: (dropCaps) => set({ dropCaps }),
        setSceneTheming: (sceneTheming) => set({ sceneTheming }),
        setSceneSoundscapes: (sceneSoundscapes) => set({ sceneSoundscapes }),
        setEmotionalTts: (emotionalTts) => set({ emotionalTts }),
        setSceneEmphasis: (sceneEmphasis) => set({ sceneEmphasis }),
        setScenePerformance: (scenePerformance) => set({ scenePerformance }),
        setAiRepairFormatting: (aiRepairFormatting) => set({ aiRepairFormatting }),
        setHideMetadata: (hideMetadata) => set({ hideMetadata }),
        setAutoStream: (autoStream) => set({ autoStream }),
        setAutoFormat: (autoFormat) => set({ autoFormat }),
        setStyleQuotes: (styleQuotes) => set({ styleQuotes }),
        setSubstituteNames: (substituteNames) => set({ substituteNames }),
        setParagraphSpacing: (paragraphSpacing) => set({ paragraphSpacing }),
        setDialogueOwnLine: (dialogueOwnLine) => set({ dialogueOwnLine }),
        setSmartTypography: (smartTypography) => set({ smartTypography }),
        setRevealMode: (revealMode) => set({ revealMode }),
        setMessagePause: (messagePause) => set({ messagePause }),
        setPauseAtPageEnd: (pauseAtPageEnd) => set({ pauseAtPageEnd }),
        setTtsEnabled: (ttsEnabled) => set({ ttsEnabled }),
        setTtsVoiceURI: (ttsVoiceURI) => set({ ttsVoiceURI }),
        setTtsRate: (ttsRate) => set({ ttsRate }),
        setTtsPitch: (ttsPitch) => set({ ttsPitch }),
        setTtsFollowSpeed: (ttsFollowSpeed) => set({ ttsFollowSpeed }),
        setTtsMultiVoice: (ttsMultiVoice) => set({ ttsMultiVoice }),
        setTtsDialogueOnly: (ttsDialogueOnly) => set({ ttsDialogueOnly }),
        setTtsPending: (ttsPending) => set({ ttsPending }),
        setTtsProgress: (ttsProgress) => set({ ttsProgress }),
        setTtsEngine: (ttsEngine) => set({ ttsEngine }),
        setKokoroBaseUrl: (kokoroBaseUrl) => set({ kokoroBaseUrl }),
        setAudioBaseUrl: (audioBaseUrl) => set({ audioBaseUrl }),
        setImageBaseUrl: (imageBaseUrl) => set({ imageBaseUrl }),
        setImageApiKey: (imageApiKey) => set({ imageApiKey }),
        setImageAdapter: (imageAdapter) => set({ imageAdapter }),
        setImageModel: (imageModel) => set({ imageModel }),
        // A new workflow invalidates the node pins that referenced the old
        // one's ids — keeping them would silently write the prompt into
        // whatever node happens to share that number in the new graph.
        setComfyWorkflow: (comfyWorkflow) => set({ comfyWorkflow, comfyMapping: {} }),
        setComfyMapping: (comfyMapping) => set({ comfyMapping }),
        setImagePreset: (imagePreset) => set({ imagePreset }),
        setImageNegativeExtra: (imageNegativeExtra) => set({ imageNegativeExtra }),
        setLiveReaction: (liveReaction) => set({ liveReaction }),
        setLiveReactor: (liveReactor) => set({ liveReactor }),
        setLiveReactionVisibility: (liveReactionVisibility) => set({ liveReactionVisibility }),
        setLiveReactionFreeze: (liveReactionFreeze) => set({ liveReactionFreeze }),
        setLiveReactionFrame: (liveReactionFrame) => set({ liveReactionFrame }),
        setReactionHold: (reactionHold) => set({ reactionHold }),
        setAudioCuesEnabled: (audioCuesEnabled) => set({ audioCuesEnabled }),
        setAudioLiveGen: (audioLiveGen) => set({ audioLiveGen }),
        setSceneMusic: (sceneMusic) => set({ sceneMusic }),
        setMusicVolume: (musicVolume) => set({ musicVolume }),
        setSfxPermissiveness: (sfxPermissiveness) => set({ sfxPermissiveness }),
        setLibrarySoundscapeActive: (librarySoundscapeActive) => set({ librarySoundscapeActive }),
        pushRecentSfx: (e) => set((s) => ({ recentSfx: [{ ...e, at: Date.now() }, ...s.recentSfx].slice(0, 4) })),
        clearRecentSfx: () => set({ recentSfx: [] }),
        setMidSceneLocation: (midSceneLocation) => set({ midSceneLocation }),
        setKokoroApiKey: (kokoroApiKey) => set({ kokoroApiKey }),
        setKokoroVoice: (kokoroVoice) => set({ kokoroVoice }),
        setKokoroUserVoice: (kokoroUserVoice) => set({ kokoroUserVoice }),
        setCharacterVoice: (name, voice) => {
          const next = { ...get().ttsVoiceByCharacter };
          if (voice) next[name] = voice;
          else delete next[name];
          set({ ttsVoiceByCharacter: next });
        },
        setAutoCastVoices: (autoCastVoices) => set({ autoCastVoices }),
        setAmbientEnabled: (ambientEnabled) => set({ ambientEnabled }),
        setAmbientVolume: (ambientVolume) => set({ ambientVolume }),
        setThemeAmbient: (theme, value) => {
          const next = { ...get().ambientByTheme };
          if (value) next[theme] = value;
          else delete next[theme];
          set({ ambientByTheme: next });
        },
        setAwaitingAdvance: (awaitingAdvance) => set({ awaitingAdvance }),
        setAwaitingInput: (awaitingInput) => set({ awaitingInput }),
        setViewHold: (viewHold) => set({ viewHold }),
        setPressToAdvance: (pressToAdvance) => set({ pressToAdvance }),
        advanceOnInput: () => {
          if (!get().awaitingInput) return;
          set({ awaitingInput: false });
          get().advanceMessage();
        },
        setSearchQuery: (searchQuery) => set({ searchQuery }),
        setIsAutofocusMode: (isAutofocusMode) =>
          set({
            isAutofocusMode,
            // Auto-zoom: entering focus zooms in on the streaming line.
            autofocusZoom: isAutofocusMode && get().autofocusAutoZoom ? 1.4 : 1,
            autofocusPanX: 0,
          }),
        setAutofocusZoom: (autofocusZoom) => set({ autofocusZoom }),
        setAutofocusPanX: (autofocusPanX) => set({ autofocusPanX }),
        setIsHighlightMode: (isHighlightMode) => set({ isHighlightMode }),
        setIsBoxMode: (isBoxMode) => set({ isBoxMode }),
        setReverseStream: (reverseStream) => set({ reverseStream }),
        setControlsMinimized: (controlsMinimized) => set({ controlsMinimized }),
        setSettingsOpen: (settingsOpen) => set({ settingsOpen }),

        setDialogueColor: (dialogueColor) => set({ dialogueColor }),
        setDialogueStyle: (dialogueStyle) => set({ dialogueStyle }),
        /* One channel at a time, rebuilt through the sanitiser so a blob from a
         * build that knew different channels can never leak through. */
        setMarkupPreset: (channel, patch) => set({
          markupPresets: sanitizeMarkupPresets({
            ...get().markupPresets,
            [channel]: { ...get().markupPresets[channel], ...patch },
          }),
        }),
        resetMarkupPresets: () => set({ markupPresets: MARKUP_DEFAULTS }),
        setDialogueAnimation: (dialogueAnimation) => set({ dialogueAnimation }),
        setCharacterColorsEnabled: (characterColorsEnabled) => set({ characterColorsEnabled }),
        setCharacterColor: (name, color) => {
          const next = { ...get().characterColors };
          if (color) next[name] = color;
          else delete next[name];
          set({ characterColors: next });
        },
        setCharacterChannelColor: (name, channel, color) => {
          const next = { ...get().characterChannelColors };
          const forChar = { ...next[name] };
          if (color) forChar[channel] = color;
          else delete forChar[channel];
          if (Object.keys(forChar).length) next[name] = forChar;
          else delete next[name];
          set({ characterChannelColors: next });
        },
        setContentWidth: (contentWidth) => set({ contentWidth }),
        setOocHandling: (oocHandling) => set({ oocHandling }),
        setPhoneDialogueOnly: (phoneDialogueOnly) => set({ phoneDialogueOnly }),
        setThemeEffects: (themeEffects) => set({ themeEffects }),
        setLivingBackground: (livingBackground) => set({ livingBackground }),

        setStoryAvatar: (who, dataUrl) => {
          const { currentStory } = get();
          if (!currentStory) return;
          const field = who === 'character' ? 'characterAvatar' : 'userAvatar';
          set({
            currentStory: { ...currentStory, [field]: dataUrl },
            library: get().library.map(m =>
              m.id === currentStory.id ? { ...m, [field]: dataUrl } : m,
            ),
          });
          schedulePersist();
        },

        setCharacterAvatar: (name, dataUrl) => {
          const { currentStory } = get();
          if (!currentStory) return;
          const next: Record<string, string | undefined> = {
            ...currentStory.characterAvatars,
            [name]: dataUrl,
          };
          if (!dataUrl) delete next[name];
          const characterAvatars = Object.fromEntries(
            Object.entries(next).filter(([, v]) => v !== undefined),
          ) as Record<string, string>;
          set({
            currentStory: { ...currentStory, characterAvatars },
            library: get().library.map(m =>
              m.id === currentStory.id ? { ...m, characterAvatars } : m,
            ),
          });
          schedulePersist();
        },

        setAiBaseUrl: (aiBaseUrl) => set({ aiBaseUrl }),
        setAiApiKey: (aiApiKey) => set({ aiApiKey }),
        setAiModel: (aiModel) => set({ aiModel }),
        setAiOpen: (aiOpen) => set({ aiOpen }),
        setLensEditTarget: (lensEditTarget) => set({ lensEditTarget, ...(lensEditTarget ? { aiOpen: true } : {}) }),
        setLensEditFocus: (lensEditFocus) => set({ lensEditFocus }),
        /* One action rather than two calls, so the focus can never be left
         * behind on the next Lens edit — a stale quote would silently redirect
         * a revision at a span the reader is no longer looking at. */
        sendToRewrite: (messageId, focus) =>
          set({ lensEditTarget: messageId, lensEditFocus: focus.trim() || null, aiOpen: true }),
        setAiAdvanced: (patch) => set({ aiAdvanced: { ...get().aiAdvanced, ...patch } }),

        selectSwipe: (messageId, index) => {
          const { chains } = get();
          const findM = (cs: typeof chains, id: string) =>
            cs.flatMap(c => c.messages).find(m => m.id === id);
          let changed = false;
          const newChains = chains.map(c => ({
            ...c,
            messages: c.messages.map(m => {
              if (m.id === messageId && m.swipes && m.swipes[index] != null) {
                changed = true;
                return { ...m, content: m.swipes[index] };
              }
              return m;
            }),
          }));
          if (!changed) return;
          const updated = findM(newChains, messageId);
          set({
            chains: newChains,
            swipeSelections: { ...get().swipeSelections, [messageId]: index },
            visibleMessages: get().visibleMessages.map(m =>
              m.id === messageId ? updated ?? m : m),
            ...(get().streamingMessage?.id === messageId
              ? { streamingMessage: updated ?? get().streamingMessage, streamedText: '' }
              : {}),
          });
          schedulePersist();
        },

        updateHighlight: (id, updates) => {
          const { currentStory } = get();
          if (!currentStory) return;
          set({
            currentStory: {
              ...currentStory,
              highlights: (currentStory.highlights ?? []).map(h =>
                h.id === id ? { ...h, ...updates } : h),
            },
          });
          schedulePersist();
        },

        addAutoFormatRule: (rule) =>
          set({ autoFormatRules: [...get().autoFormatRules, rule] }),
        updateAutoFormatRule: (id, updates) =>
          set({
            autoFormatRules: get().autoFormatRules.map(r =>
              r.id === id ? { ...r, ...updates } : r,
            ),
          }),
        removeAutoFormatRule: (id) =>
          set({ autoFormatRules: get().autoFormatRules.filter(r => r.id !== id) }),
        moveAutoFormatRule: (id, direction) => {
          const rules = [...get().autoFormatRules];
          const idx = rules.findIndex(r => r.id === id);
          const target = idx + direction;
          if (idx === -1 || target < 0 || target >= rules.length) return;
          [rules[idx], rules[target]] = [rules[target], rules[idx]];
          set({ autoFormatRules: rules });
        },
        importAutoFormatRules: (rules) => {
          const existing = new Set(get().autoFormatRules.map(r => r.id));
          const incoming = rules.map(r => ({
            ...r,
            id: existing.has(r.id) ? newId() : r.id,
          }));
          set({ autoFormatRules: [...get().autoFormatRules, ...incoming] });
        },

        addStatRule: (rule) =>
          set({ statRules: [...get().statRules, rule] }),
        updateStatRule: (id, updates) =>
          set({
            statRules: get().statRules.map(r =>
              r.id === id ? { ...r, ...updates } : r),
          }),
        removeStatRule: (id) =>
          set({ statRules: get().statRules.filter(r => r.id !== id) }),
        moveStatRule: (id, direction) => {
          const rules = [...get().statRules];
          const idx = rules.findIndex(r => r.id === id);
          const target = idx + direction;
          if (idx === -1 || target < 0 || target >= rules.length) return;
          [rules[idx], rules[target]] = [rules[target], rules[idx]];
          set({ statRules: rules });
        },

        saveConfig: (name) =>
          set({ savedConfigs: { ...get().savedConfigs, [name]: pickConfig(get()) } }),
        loadConfig: (name) => {
          const config = get().savedConfigs[name];
          if (config) set({ ...config });
        },
        deleteConfig: (name) => {
          const configs = { ...get().savedConfigs };
          delete configs[name];
          set({ savedConfigs: configs });
        },
      };
    },
    {
      name: 'aura-reader-settings',
      version: 2,
      migrate: (persisted: unknown, version: number) => {
        const state = persisted as Record<string, unknown> | undefined;
        if (!state) return state as never;
        // v0 → v1: 'sans' used to double as "follow the theme's font"; that
        // meaning moved to the explicit 'theme' value, so old defaults keep
        // their themed fonts.
        if (version < 1 && state.fontFamily === 'sans') state.fontFamily = 'theme';
        // v1 → v2: reading modes + the curated view bar. Both are labels put
        // OVER an existing setup, never a rewrite of it — an existing reader
        // must open on exactly the page they closed, not one pixel different.
        if (version < 2) {
          // Their config as-is decides the label; nothing is written back.
          state.readingMode = nearestMode(state as never);
          // Pin what their old preset was already showing, so the bar is
          // unchanged on first launch. They can unpin from there.
          const uiMode = (state.uiMode as UiMode) ?? 'all';
          state.visibleViews = VIEW_ORDER.filter(
            v => uiMode === 'all' || VIEW_GROUP[v] === 'read' || VIEW_GROUP[v] === uiMode,
          );
        }
        return state as never;
      },
      partialize: (state) => ({
        ...pickConfig(state),
        savedConfigs: state.savedConfigs,
        viewMode: isReadingView(state.viewMode) ? state.viewMode : 'chat',
        layoutMode: state.layoutMode,
        controlsMinimized: state.controlsMinimized,
      }),
    },
  ),
);
