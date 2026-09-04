import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlignLeft, Brain, ChevronDown, Clapperboard, Download, EyeOff, FileText, Focus, ImageIcon, LayoutTemplate, Loader2, MessageSquareQuote,
  Headphones, MessageCircle, Music2, Palette, PauseCircle, Play, PlayCircle, Quote, RefreshCw, Save, Server, Sparkles, Square, Terminal, Trash2, Type,
  Pause, Plus, Popcorn, Share2, UserRound, Volume2, Wand2, X, Zap, ZoomIn, Database, Compass,
} from 'lucide-react';
import { castOf } from '../utils/askCharacter';
import { MAGNIFIER_STYLES } from '../utils/readingFocus';
import { ColorableChannel, MagnifierStyle, MarkupPreset, STREAM_EFFECTS, StoredChannel } from '../types';
import {
  CHARACTER_COLOR_NONE, MARKUP_CHANNELS, MARKUP_COLORS, isDefaultMarkup, sanitizeMarkupPresets,
} from '../utils/markupStyles';
import { InviteSheet } from './InviteSheet';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { useSceneDirectorStore } from '../stores/useSceneDirectorStore';
import { customFamilyFor, useFontStore } from '../stores/useFontStore';
import { useSpriteStore } from '../stores/useSpriteStore';
import { useBackdropStore } from '../stores/useBackdropStore';
import { EMOTION_BUCKETS, EmotionBucket } from '../lib/spriteStorage';
import { directorCoverage, enrichAll, retryCurrentPage, stopEnrich } from '../utils/sceneDirectorRunner';
import { ttsSupported, useVoices } from '../hooks/useTTS';
import { KNOWN_KOKORO_VOICES, kokoroSpeak, listKokoroVoices } from '../utils/kokoro';
import { AMBIENT_SOUNDS } from '../utils/ambient';
import { ACCENTS, THEMES } from '../themes';
import {
  downloadBlob, downloadText, exportStoryWithEdits, safeFilename, storyToMarkdown,
} from '../utils/exporter';
import { exportStoryHtml } from '../utils/htmlExport';
import { CutSummary, buildCut, cutFilename, cutToText, describeCut } from '../utils/cut';
import { embedFontsFor, resolveExportFont } from '../utils/fontEmbed';
import { AudiobookModal } from './AudiobookModal';
import { AudioLibraryModal } from './AudioLibraryModal';
import { ServiceDot, ServicesSection } from './ServiceStatus';
import { SceneImageSettings } from './SceneImageSettings';
import { useService } from '../services/useService';
import { attachSceneArt, walkStory } from '../utils/storyWalk';
import { artDataUri } from '../lib/artStorage';
import { resolveTheme, accentHex } from '../themes';
import { cn } from '../utils/cn';
import { READING_MODE_DEFS, modeDef, modeDiff, modeMatches } from '../utils/readingModes';
import { selectTaste, tasteBlock } from '../utils/tasteBlock';

const readImageFile = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

/** Upload / preview / clear one profile picture. */
const AvatarUpload = ({
  label, value, onPick,
}: {
  label: string;
  value?: string;
  onPick: (dataUrl: string | undefined) => void;
}) => {
  const inputRef = React.useRef<HTMLInputElement>(null);
  return (
    <div className="flex items-center gap-3 text-sm">
      <button
        onClick={() => inputRef.current?.click()}
        className="w-10 h-10 rounded-full overflow-hidden ring-2 ring-app-border bg-app-text/10 flex items-center justify-center shrink-0 hover:ring-accent transition"
        title={`Set ${label} picture`}
      >
        {value
          ? <img src={value} alt={label} className="w-full h-full object-cover" />
          : <UserRound size={16} className="opacity-60" />}
      </button>
      <span className="flex-1">{label}</span>
      {value && (
        <button onClick={() => onPick(undefined)} className="text-xs text-muted hover:text-red-500">
          Remove
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (f) onPick(await readImageFile(f));
          e.target.value = '';
        }}
      />
    </div>
  );
};

const ExportWithEditsButton = ({ story }: { story: import('../types').Story }) => {
  const overridesByStory = useAuraV2Store(s => s.overridesByStory);
  const overrides = overridesByStory[story.id];
  if (!overrides || overrides.length === 0) return null;

  const ext = story.format === 'sillytavern' ? 'jsonl' : story.format === 'kobold' ? 'json' : 'json';
  return (
    <button
      onClick={() => {
        const text = exportStoryWithEdits(story, overrides);
        const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
        downloadBlob(`${safeFilename(story.title)}-edited.${ext}`, blob);
      }}
      className="flex items-center gap-2 p-2 min-h-11 rounded-lg hover:bg-app-text/5 transition-colors text-sm"
    >
      <Download size={16} />
      <span>Export with edits applied ({overrides.length})</span>
    </button>
  );
};

/** Opens the audiobook renderer for the current story. */
const AudiobookButton = () => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        data-testid="open-audiobook"
        className="flex items-center gap-2 p-2 min-h-11 rounded-lg hover:bg-app-text/5 transition-colors text-sm"
      >
        <Headphones size={16} />
        <span>Render as an audiobook (.mp3)</span>
      </button>
      {open && <AudiobookModal onClose={() => setOpen(false)} />}
    </>
  );
};

/**
 * Opens the generated-sound library. The clips were searchable by the Director
 * and invisible to the reader — no way to hear what you had, or throw away a
 * miss, or ask for one thing in particular.
 */
const AudioLibraryButton = () => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        data-testid="open-audio-library"
        className="flex items-center gap-2 p-2 min-h-11 rounded-lg hover:bg-app-text/5 transition-colors text-sm"
      >
        <Music2 size={16} />
        <span>Browse the sound library…</span>
        <ServiceDot id="audio" />
      </button>
      {open && <AudioLibraryModal onClose={() => setOpen(false)} />}
    </>
  );
};

/**
 * Export the story as one self-contained HTML page.
 *
 * Everything the reader configured comes along — theme, accent, the Lens layer,
 * name substitution, their highlights, and the Director's per-scene mood — so
 * the file reads the way the app does. It is the one export that is meant to be
 * handed to somebody else, which is why it embeds rather than links: a file
 * that fetches anything when opened is a file that leaks who opened it.
 */
const ExportAsPageButton = () => {
  const store = useAppStore();
  const v2 = useAuraV2Store();
  const customFonts = useFontStore(f => f.fonts);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const story = store.currentStory;
  if (!story) return null;

  const run = async () => {
    setBusy(true);
    setNote(null);
    try {
      const themeDef = resolveTheme(store.theme, store.bgColor, store.textColor);
      const font = resolveExportFont(
        store.theme,
        themeDef.font,
        store.fontFamily,
        customFamilyFor(store.fontFamily, customFonts),
      );
      // Fetched once, HERE — the export may use the network; the exported file
      // never may. A failure drops back to the stack rather than failing.
      const walked = await attachSceneArt(
        walkStory(story, store.chains, {
          overrides: v2.overridesByStory[story.id],
          lensOn: !!v2.lensOnByStory[story.id],
          hideMetadata: store.hideMetadata,
          fontColorMode: store.fontColorMode,
          substituteNames: store.substituteNames,
          oocHandling: store.oocHandling,
          smartTypography: store.smartTypography,
        }),
        v2.artByStory[story.id],
        artDataUri,
      );
      // The story's own text decides which character subsets are worth
      // embedding — a Latin chat has no use for the Cyrillic ones.
      // A bounded sample: enough prose to see every alphabet the story uses,
      // without building a second copy of the whole thing in memory.
      let sample = story.title;
      for (const m of walked.messages) {
        sample += ` ${m.name} ${m.text}`;
        if (sample.length > 200_000) break;
      }
      const fonts = await embedFontsFor(font, sample);

      const { html, droppedImages } = exportStoryHtml(walked, {
        theme: themeDef,
        fontColorMode: store.fontColorMode,
        accent: accentHex(store.accentColor) || undefined,
        typography: {
          stack: font.stack,
          fontSize: store.fontSize,
          contentWidth: store.contentWidth,
          paragraphSpacing: store.paragraphSpacing,
          faceCss: fonts.css,
        },
        // Opens in whichever reading layout you are in; the page can switch.
        layout: store.viewMode === 'chat' ? 'chat' : 'storybook',
        scenes: v2.sceneByStory[story.id],
        // The reader's own marking of the page travels with it.
        readerMarks: {
          emphasis: v2.emphasisMarksByStory[story.id],
          sfx: v2.sfxMarksByStory[story.id],
          perform: v2.performMarksByStory[story.id],
        },
        highlights: story.highlights,
        sceneMood: store.sceneTheming,
        streaming: true,
        markup: {
          dialogueColor: store.dialogueColor,
          dialogueStyle: store.dialogueStyle,
          dialogueAnimation: store.dialogueAnimation,
          markupPresets: store.markupPresets,
          characterColors: store.characterColors,
          characterChannelColors: store.characterChannelColors,
          characterColorsEnabled: store.characterColorsEnabled,
        },
      });

      downloadBlob(
        `${safeFilename(story.title)}.html`,
        new Blob([html], { type: 'text/html;charset=utf-8' }),
      );

      const bits = [
        fonts.faces > 0 ? `${fonts.faces} font file${fonts.faces === 1 ? '' : 's'} embedded` : null,
        fonts.incomplete ? 'some fonts could not be fetched, so the page falls back to a similar face' : null,
        droppedImages > 0 ? `${droppedImages} linked image${droppedImages === 1 ? '' : 's'} left out` : null,
      ].filter(Boolean);
      setNote(bits.length
        ? `Exported — ${bits.join('; ')}.`
        : 'Exported — one file, nothing loaded from the network.');
    } catch (e) {
      setNote(`Export failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        onClick={() => void run()}
        disabled={busy}
        data-testid="export-html"
        className="flex items-center gap-2 p-2 min-h-11 rounded-lg hover:bg-app-text/5 transition-colors text-sm disabled:opacity-50"
      >
        {busy ? <Loader2 size={16} className="animate-spin" /> : <FileText size={16} />}
        <span>{busy ? 'Embedding fonts…' : 'Export as a readable page (.html)'}</span>
      </button>
      {note && <p className="text-[11px] text-muted px-2 leading-snug">{note}</p>}
    </>
  );
};

/**
 * Export a Cut — the story plus the way it was directed, as one file another
 * copy of Aeia can open.
 *
 * The sibling of the HTML export, and the answer to a different question. That
 * one makes a page anybody can read anywhere; this one makes a file that opens
 * HERE, with the five views, the weather and the performance intact, and with
 * no endpoint, no key and no hardware needed to see any of it — because the
 * direction is already baked.
 *
 * It says what it contains before it writes, in counts rather than adjectives,
 * because a file meant to be handed to somebody else has to be inspectable
 * first. What it will never contain is the reader's own notes: see
 * `NEVER_IN_A_CUT` in `utils/cut.ts`.
 */
const ExportCutButton = () => {
  const store = useAppStore();
  const v2 = useAuraV2Store();
  const [note, setNote] = useState<string | null>(null);
  const [preview, setPreview] = useState<CutSummary | null>(null);

  const story = store.currentStory;
  if (!story) return null;

  const make = () => buildCut(story, v2 as unknown as Record<string, unknown>, {
    presentation: { readingMode: store.readingMode, viewMode: store.viewMode, theme: store.theme },
  });

  const run = () => {
    try {
      const cut = make();
      downloadBlob(cutFilename(story.title), new Blob([cutToText(cut)], { type: 'application/json' }));
      setPreview(null);
      setNote('Saved. Anyone with Aeia Reader can open it — no endpoint needed.');
    } catch (e) {
      setNote(`Export failed: ${(e as Error).message}`);
    }
  };

  const summary = preview;
  return (
    <>
      <button
        onClick={() => { setNote(null); setPreview(preview ? null : describeCut(make())); }}
        data-testid="export-cut"
        className="flex items-center gap-2 p-2 min-h-11 rounded-lg hover:bg-app-text/5 transition-colors text-sm"
      >
        <Share2 size={16} />
        <span>Export as a Cut (.cut.json)</span>
      </button>
      {summary && (
        <div
          className="mx-2 rounded-lg border border-app-border/70 p-2 flex flex-col gap-1.5"
          data-testid="cut-preview"
        >
          <p className="text-[11px] text-muted leading-snug">
            <b>{summary.passages.toLocaleString()}</b> passages ·{' '}
            <b>{summary.words.toLocaleString()}</b> words ·{' '}
            <b>{summary.directed.toLocaleString()}</b> directed ·{' '}
            <b>{summary.marks.toLocaleString()}</b> hand marks ·{' '}
            <b>{summary.edits.toLocaleString()}</b> Lens edits ·{' '}
            <b>{Math.max(1, Math.round(summary.bytes / 1024)).toLocaleString()} KB</b>
          </p>
          <p className="text-[11px] text-muted leading-snug">
            Your notes stay here: highlights, margin notes, interviews, companion
            reactions and anyone you brought in from another chat are not in the file.
          </p>
          {summary.art > 0 && (
            <p className="text-[11px] text-muted leading-snug">
              Your {summary.art} generated picture{summary.art === 1 ? '' : 's'} stay
              here too — a Cut carries the direction, not the media.
            </p>
          )}
          <button
            onClick={run}
            data-testid="cut-confirm"
            className="self-start px-2.5 py-1 rounded-md text-[11px] bg-accent/15 text-accent font-medium"
          >
            Save it
          </button>
        </div>
      )}
      {note && <p className="text-[11px] text-muted px-2 leading-snug">{note}</p>}
    </>
  );
};

/**
 * Stage backdrops: scene images keyed by a location word ("forest", "tavern",
 * a mood like "ominous", or "default"). The Director's location read picks
 * the matching backdrop on the Stage.
 */
const BackdropSection = () => {
  const storyId = useAppStore(s => s.currentStory?.id);
  const allBackdrops = useBackdropStore(s => s.backdrops);
  // Only this chat's backdrops — they never cross chats.
  const backdrops = allBackdrops.filter(b => b.storyId === storyId);
  const urls = useBackdropStore(s => s.urls);
  const addBackdrop = useBackdropStore(s => s.addBackdrop);
  const removeBackdrop = useBackdropStore(s => s.removeBackdrop);
  const bdError = useBackdropStore(s => s.error);
  const [keyword, setKeyword] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <Section title="Stage backdrops">
      <div className="flex items-center gap-2 text-xs">
        <input
          type="text"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="location word… (forest, tavern, default)"
          className="flex-1 min-w-0 bg-app-text/5 border border-app-border rounded-md px-2 min-h-10 outline-none focus:border-accent/50"
        />
        <button
          onClick={() => { if (keyword.trim()) fileRef.current?.click(); }}
          disabled={!keyword.trim()}
          className="px-2.5 min-h-10 rounded-md bg-accent/15 text-accent font-medium hover:bg-accent/25 disabled:opacity-40"
        >
          Upload
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/webp,image/jpeg"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f && keyword.trim() && storyId) { void addBackdrop(storyId, keyword, f); setKeyword(''); }
            e.target.value = '';
          }}
        />
      </div>
      {bdError && <span className="text-[11px] text-red-400">{bdError}</span>}
      {backdrops.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {backdrops.map(b => (
            <div key={b.id} className="relative group w-20">
              <img src={urls[b.id]} alt={b.keyword} className="w-20 h-12 object-cover rounded-md border border-app-border" />
              <span className="block text-center text-[9px] text-muted truncate">{b.keyword}</span>
              <button
                onClick={() => void removeBackdrop(b.id)}
                className="absolute -top-1.5 -right-1.5 hidden group-hover:flex w-4 h-4 items-center justify-center rounded-full bg-red-500 text-white text-[9px]"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <span className="text-[11px] text-muted">
        When the Scene Director places a scene somewhere whose name contains
        your word, that image becomes the Stage's background — “forest.png as
        the forest” with zero setup. A “default” backdrop covers the rest.
      </span>
    </Section>
  );
};

/**
 * Compact per-character expression slots, shown right under a character's
 * profile-picture row. One image per feeling; on the Stage, the Director's
 * read swaps the character to the matching expression.
 */
const ExpressionStrip = ({ character, spriteKey }: { character: string; spriteKey?: string }) => {
  const storyId = useAppStore(s => s.currentStory?.id);
  const sprites = useSpriteStore(s => s.sprites);
  const urls = useSpriteStore(s => s.urls);
  const addSprite = useSpriteStore(s => s.addSprite);
  const removeSprite = useSpriteStore(s => s.removeSprite);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<EmotionBucket | null>(null);

  // The storage key can be namespaced (the reader's own sprites live under
  // "user:<name>") so two rows can never share a set by accident. Scoped to this
  // chat via storyId — a set uploaded here never appears in another chat.
  const storeAs = spriteKey ?? character;
  const key = storeAs.trim().toLowerCase();
  const bySlot = new Map(sprites.filter(s => s.storyId === storyId && s.character === key).map(s => [s.emotion, s]));

  return (
    <div className="flex items-center gap-1.5 pl-[3.25rem] -mt-1">
      <span className="text-[9px] uppercase tracking-wider text-muted mr-0.5">
        Stage · {character}
      </span>
      {EMOTION_BUCKETS.map(b => {
        const sprite = bySlot.get(b);
        return (
          <div key={b} className="relative group shrink-0">
            <button
              title={sprite
                ? `${character} · ${b} — click to replace, × to remove`
                : `Upload ${character}'s "${b}" expression for the Stage`}
              onClick={() => { setPending(b); fileRef.current?.click(); }}
              onContextMenu={(e) => { e.preventDefault(); if (sprite) void removeSprite(sprite.id); }}
              className={cn(
                'w-6 h-6 rounded-md overflow-hidden border flex items-center justify-center text-[8px]',
                'relative before:absolute before:-inset-1.5 before:content-[\'\']',
                sprite ? 'border-accent/60' : 'border-app-border border-dashed opacity-50 hover:opacity-100',
              )}
            >
              {sprite
                ? <img src={urls[sprite.id]} alt={b} className="w-full h-full object-cover" />
                : b[0].toUpperCase()}
            </button>
            {sprite && (
              <button
                title={`Remove ${character}'s "${b}" expression`}
                onClick={() => void removeSprite(sprite.id)}
                className="absolute -top-1.5 -right-1.5 hidden group-hover:flex w-3.5 h-3.5 items-center justify-center rounded-full bg-red-500 text-white text-[8px] leading-none z-10"
              >
                ×
              </button>
            )}
          </div>
        );
      })}
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/webp,image/jpeg,image/gif"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f && pending && storyId) void addSprite(storyId, storeAs, pending, f);
          setPending(null);
          e.target.value = '';
        }}
      />
    </div>
  );
};

/** Version, build time and platform — one line, copyable. */
const BuildStamp = () => {
  const [copied, setCopied] = useState(false);
  const built = useMemo(() => {
    try {
      return new Date(__BUILD_TIME__).toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    } catch {
      return __BUILD_TIME__;
    }
  }, []);
  const where = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
    ? 'desktop' : 'web';
  const line = `Aeia ${__APP_VERSION__} · ${where} · built ${built}`;

  return (
    <button
      onClick={() => {
        void navigator.clipboard?.writeText(line).then(
          () => { setCopied(true); window.setTimeout(() => setCopied(false), 1400); },
          () => { /* the OS said no; the line is on screen to read */ },
        );
      }}
      title="Copy this line — it says exactly which build you are running"
      data-testid="build-stamp"
      className="text-[10px] text-muted/70 hover:text-muted text-left pt-3"
    >
      {copied ? 'copied' : line}
    </button>
  );
};

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div>
    <label className="text-xs font-bold uppercase tracking-wider text-muted mb-2 block">
      {title}
    </label>
    <div className="flex flex-col gap-2">{children}</div>
  </div>
);

/**
 * A section that folds itself away when the reader's mode has no use for it.
 *
 * Scene Images and Services are two of the longest panels here — an image
 * backend, an adapter, a model, a workflow, a mapping, plus a live status
 * readout per service. In Plain and Lit none of it does anything: those modes
 * generate no images and drive no scene backends, so it is a wall of
 * configuration for machinery that is switched off.
 *
 * Folded, not removed. The reader who wants to set up a backend *before*
 * turning the mode on has to be able to, and a setting you cannot find is worse
 * than one you have to scroll past. The header says what is inside and one
 * click opens it.
 *
 * Re-seeded when `startClosed` changes, so switching Plain → Cinema opens these
 * without a reload, and going back closes them again. It does not fight the
 * reader mid-session: toggling it by hand sticks until the mode itself changes.
 */
const FoldedSection = ({
  title, hint, startClosed, children,
}: {
  title: string;
  /** One line on what is inside, shown while folded. */
  hint?: string;
  startClosed: boolean;
  children: React.ReactNode;
}) => {
  const [open, setOpen] = useState(!startClosed);
  useEffect(() => { setOpen(!startClosed); }, [startClosed]);
  return (
    <div>
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        data-testid={`section-${title.toLowerCase().replace(/\s+/g, '-')}`}
        className="w-full flex items-center gap-1.5 mb-2 text-left group"
      >
        <span className="text-xs font-bold uppercase tracking-wider text-muted group-hover:text-app-text transition-colors">
          {title}
        </span>
        <ChevronDown
          size={13}
          className={cn('text-muted transition-transform', open && 'rotate-180')}
        />
      </button>
      {open
        ? <div className="flex flex-col gap-2">{children}</div>
        : hint && <p className="text-[11px] text-muted -mt-1 mb-1">{hint}</p>}
    </div>
  );
};

/**
 * A collapsed drawer for the individual keys a reading mode owns. They are all
 * still here and still reachable — they just stop being the front door, which is
 * the whole point of the mode. Opens automatically once the reader has diverged,
 * so a "· modified" badge always has something to explain it.
 */
const Advanced = ({
  label = 'Advanced', open, children,
}: { label?: string; open?: boolean; children: React.ReactNode }) => {
  const [expanded, setExpanded] = useState(!!open);
  return (
    <div className="rounded-lg border border-app-border/60">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-2 min-h-10 text-[11px] text-muted hover:text-app-text transition-colors"
      >
        <span className="uppercase tracking-wide">{label}</span>
        <ChevronDown size={13} className={cn('transition-transform', expanded && 'rotate-180')} />
      </button>
      {expanded && <div className="flex flex-col gap-2 px-2 pb-2">{children}</div>}
    </div>
  );
};

/**
 * The front door. One choice that produces a coherent result, instead of a
 * dozen switches the reader has to assemble into a taste.
 */
const ReadingModeSection = () => {
  const store = useAppStore();
  const mode = store.readingMode;
  const matches = modeMatches(store, mode);
  const diff = modeDiff(store, mode);
  return (
    <Section title="Reading mode">
      <div className="grid grid-cols-2 gap-2">
        {READING_MODE_DEFS.map(def => (
          <button
            key={def.mode}
            onClick={() => store.setReadingMode(def.mode)}
            data-testid={`reading-mode-${def.mode}`}
            aria-pressed={mode === def.mode}
            className={cn(
              'py-1.5 min-h-11 text-xs rounded-md border transition-colors',
              mode === def.mode
                ? 'border-accent bg-accent/10 text-accent font-bold'
                : 'border-transparent bg-app-text/5 hover:bg-app-text/10',
            )}
          >
            {def.label}
          </button>
        ))}
      </div>
      <span className="text-[11px] text-muted" data-testid="reading-mode-hint">
        {modeDef(mode).hint}
      </span>
      {!matches && (
        <span className="text-[11px] text-amber-600 dark:text-amber-400" data-testid="reading-mode-modified">
          {modeDef(mode).label} · modified — you've changed {diff.length} of its
          settings by hand. Picking a mode again restores the whole set.
        </span>
      )}
    </Section>
  );
};

const Toggle = ({
  icon, label, value, onChange, accent, hint, testId,
}: {
  icon: React.ReactNode;
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  accent?: boolean;
  /** One line explaining what the switch actually does, under the label. */
  hint?: string;
  testId?: string;
}) => (
  <button
    onClick={() => onChange(!value)}
    aria-pressed={value}
    data-testid={testId}
    className={cn(
      'flex items-center justify-between gap-2 p-2 min-h-11 rounded-lg hover:bg-app-text/5 transition-colors text-sm text-left',
      accent && 'font-bold text-amber-600 dark:text-amber-400 bg-amber-500/10',
    )}
  >
    <div className="flex items-center gap-2 min-w-0">
      {icon}
      <span className="min-w-0">
        <span className="block">{label}</span>
        {hint && <span className="block text-xs font-normal text-app-text/45 leading-snug">{hint}</span>}
      </span>
    </div>
    <span className={cn(
      'w-9 h-5 rounded-full p-0.5 transition-colors',
      value ? 'bg-accent' : 'bg-app-text/20',
    )}>
      <span className={cn(
        'block w-4 h-4 rounded-full bg-white shadow transition-transform',
        value && 'translate-x-4',
      )} />
    </span>
  </button>
);

/**
 * One markup channel: what the mark looks like written, and the three knobs.
 *
 * The mark itself is shown in a monospace chip beside the label because the
 * NAME of a channel is not what the reader recognises — `****` is. A reader
 * scanning this panel is looking for the punctuation they keep seeing in their
 * own logs, not for our word for it.
 */
const ChannelRow = ({
  channel, preset, onChange,
}: {
  channel: { id: StoredChannel; label: string; mark: string; hint: string; sample: string };
  preset: MarkupPreset;
  onChange: (patch: Partial<MarkupPreset>) => void;
}) => {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="rounded-lg border border-app-border/60" data-testid={`markup-${channel.id}`}>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-2 py-2 text-sm text-left hover:bg-app-text/5 rounded-lg"
      >
        <code className="shrink-0 px-1.5 py-0.5 rounded bg-app-text/10 font-mono text-[11px]">
          {channel.mark}
        </code>
        <span className="flex-1 min-w-0">
          <span className="block">{channel.label}</span>
          <span className="block text-[10px] opacity-60 truncate">{channel.hint}</span>
        </span>
        <span className="opacity-50 text-xs">{open ? '\u2212' : '+'}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 px-2 pb-2.5">
          <SelectRow
            label="Style"
            value={preset.style}
            onChange={(v) => onChange({ style: v as MarkupPreset['style'] })}
            testId={`markup-${channel.id}-style`}
            options={[
              { value: 'normal', label: 'Normal' },
              { value: 'italic', label: 'Italic' },
              { value: 'bold', label: 'Bold' },
              { value: 'bold-italic', label: 'Bold Italic' },
            ]}
          />
          <SelectRow
            label="Animation"
            value={preset.animation}
            onChange={(v) => onChange({ animation: v as MarkupPreset['animation'] })}
            testId={`markup-${channel.id}-animation`}
            options={[
              { value: 'none', label: 'None' },
              { value: 'zoom', label: 'Zoom' },
              { value: 'pulse', label: 'Pulse' },
              { value: 'wave', label: 'Wave' },
              { value: 'glow', label: 'Glow' },
              { value: 'rise', label: 'Rise' },
            ]}
          />
          <SelectRow
            label="Color"
            value={preset.color}
            onChange={(v) => onChange({ color: v })}
            testId={`markup-${channel.id}-color`}
            options={MARKUP_COLORS.map(c => ({ value: c.value, label: c.label }))}
          />
          <code className="px-1 font-mono text-[10px] opacity-50">{channel.sample}</code>
        </div>
      )}
    </div>
  );
};

/**
 * Optional layer on top of the channel colors above: color speech/asides/
 * beats/shouts by WHO said or thought them instead of one fixed color for
 * everyone. Off by default — every channel keeps behaving exactly as
 * configured above until this is turned on.
 */
const CHARACTER_COLOR_OPTIONS = [
  { value: '', label: 'Auto' },
  ...MARKUP_COLORS.filter(c => c.value),
  { value: CHARACTER_COLOR_NONE, label: 'No color' },
];

/** The advanced, per-channel layer: a specific action for a specific
 *  character, e.g. Kara's dialogue stays her color but her thoughts don't. */
const CHARACTER_CHANNELS: { id: ColorableChannel; label: string }[] = [
  { id: 'speech', label: 'Speech' },
  { id: 'aside', label: 'Aside' },
  { id: 'bold', label: 'Beat' },
  { id: 'shout', label: 'Shout' },
];

const CHARACTER_CHANNEL_OPTIONS = [
  { value: '', label: 'Same as character' },
  ...MARKUP_COLORS.filter(c => c.value),
  { value: CHARACTER_COLOR_NONE, label: 'No color' },
];

/**
 * One character's color, plus a collapsed-by-default "Advanced" disclosure
 * for per-channel overrides — so a reader who only wants the simple case
 * (one color per character) never sees the extra four dropdowns.
 */
const CharacterColorRow = ({ name }: { name: string }) => {
  const store = useAppStore();
  const [open, setOpen] = useState(false);
  const channelColors = store.characterChannelColors[name];
  const overrideCount = channelColors ? Object.keys(channelColors).length : 0;

  return (
    <div className="flex flex-col gap-1">
      <SelectRow
        label={name}
        value={store.characterColors[name] ?? ''}
        onChange={(v) => store.setCharacterColor(name, v || undefined)}
        testId={`character-color-${name}`}
        options={CHARACTER_COLOR_OPTIONS}
      />
      <button
        onClick={() => setOpen(o => !o)}
        data-testid={`character-color-${name}-advanced`}
        className={cn(
          'self-start ml-24 -mt-1 px-1.5 py-0.5 text-[10px] rounded hover:bg-app-text/10',
          overrideCount > 0 ? 'text-accent' : 'opacity-50',
        )}
      >
        Advanced{overrideCount > 0 ? ` (${overrideCount})` : ''} {open ? '−' : '+'}
      </button>
      {open && (
        <div className="ml-24 pl-2 border-l border-app-border/40 flex flex-col gap-1.5">
          {CHARACTER_CHANNELS.map(ch => (
            <SelectRow
              key={ch.id}
              label={ch.label}
              value={channelColors?.[ch.id] ?? ''}
              onChange={(v) => store.setCharacterChannelColor(name, ch.id, v || undefined)}
              testId={`character-color-${name}-${ch.id}`}
              options={CHARACTER_CHANNEL_OPTIONS}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const CharacterColorSection = () => {
  const store = useAppStore();
  const story = store.currentStory;
  const names = useMemo(() => {
    if (!story) return [];
    const cast = castOf(story.messages, story.userName);
    return [story.userName || 'You', ...cast];
  }, [story]);

  return (
    <Section title="Character Colors">
      <Toggle
        icon={<Palette size={16} />}
        label="Color by character"
        hint="Each speaker's dialogue, asides, beats and shouts use their own color instead of one color for everyone."
        value={store.characterColorsEnabled}
        onChange={store.setCharacterColorsEnabled}
        testId="character-colors-toggle"
      />
      {store.characterColorsEnabled && (
        story && names.length > 0 ? (
          <div className="flex flex-col gap-2.5 px-1">
            {names.map(name => (
              <CharacterColorRow key={name} name={name} />
            ))}
            <span className="text-[11px] text-muted px-1">
              Auto assigns each character a consistent color automatically; No
              color always falls back to the channel's own color above.
              Advanced lets one character's specific action (their dialogue,
              asides, beats or shouts) use a different color than the rest of
              theirs.
            </span>
          </div>
        ) : (
          <p className="px-1 text-[11px] opacity-60">
            Open a story to assign colors per character — until then, everyone
            gets an automatically assigned color.
          </p>
        )
      )}
    </Section>
  );
};

const SelectRow = ({
  label, value, onChange, options, testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  testId?: string;
}) => (
  <div className="flex gap-2 items-center text-sm">
    <span className="w-24 shrink-0">{label}</span>
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      data-testid={testId}
      className="flex-1 bg-app-text/5 border border-app-border rounded-md px-2 min-h-10 outline-none min-w-0"
    >
      {options.map(o => (
        <option key={o.value} value={o.value} className="text-black bg-white">
          {o.label}
        </option>
      ))}
    </select>
  </div>
);

let previewAudio: HTMLAudioElement | null = null;
const previewVoice = async (base: string, key: string, voice: string, onErr: (m: string) => void) => {
  try {
    const blob = await kokoroSpeak(base, key, voice, 'The lantern swung once, twice — then went dark.', 1);
    previewAudio?.pause();
    previewAudio = new Audio(URL.createObjectURL(blob));
    void previewAudio.play();
  } catch (e: any) {
    onErr(e?.message ?? 'Preview failed — check the Kokoro server URL.');
  }
};

/** Kokoro engine: server connection, default/user voices, and a per-character
 *  voice map so each speaker reads in their own voice. */
const KokoroSettings = () => {
  const store = useAppStore();
  const [voices, setVoices] = useState<string[]>(KNOWN_KOKORO_VOICES);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);

  const characters = useMemo(() => {
    const names = new Set<string>();
    (store.currentStory?.messages ?? []).forEach(m => { if (m.role === 'ai' && m.name) names.add(m.name); });
    return [...names].slice(0, 40);
  }, [store.currentStory]);

  const load = async () => {
    setLoading(true); setError('');
    try {
      const v = await listKokoroVoices(store.kokoroBaseUrl, store.kokoroApiKey);
      setVoices(v); setLoaded(true);
    } catch (e: any) {
      setError(e?.message ?? 'Could not reach the Kokoro server.');
    } finally {
      setLoading(false);
    }
  };

  const voiceOptions = (withDefault?: string) => [
    ...(withDefault ? [{ value: '', label: withDefault }] : []),
    ...voices.map(v => ({ value: v, label: v })),
  ];

  const VoiceRow = ({ label, value, onChange, defaultLabel }: {
    label: string; value: string; onChange: (v: string) => void; defaultLabel?: string;
  }) => (
    <div className="flex gap-2 items-center text-sm">
      <span className="w-24 shrink-0 truncate" title={label}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 bg-app-text/5 border border-app-border rounded-md px-2 min-h-10 outline-none min-w-0"
      >
        {voiceOptions(defaultLabel).map(o => (
          <option key={o.value || 'default'} value={o.value} className="text-black bg-white">{o.label}</option>
        ))}
      </select>
      <button
        onClick={() => previewVoice(store.kokoroBaseUrl, store.kokoroApiKey, value || store.kokoroVoice, setError)}
        title="Preview this voice"
        className="p-1.5 rounded-md hover:bg-app-text/10 shrink-0"
      >
        <Play size={13} />
      </button>
    </div>
  );

  return (
    <div className="ml-1 pl-3 border-l border-app-border flex flex-col gap-2">
      <label className="block">
        <span className="text-xs font-bold uppercase tracking-wider text-muted flex items-center gap-1.5">
          Kokoro server URL <ServiceDot id="kokoro" />
        </span>
        <input
          type="text"
          value={store.kokoroBaseUrl}
          onChange={(e) => store.setKokoroBaseUrl(e.target.value)}
          placeholder="http://localhost:8880"
          className="mt-1 w-full bg-app-text/5 border border-app-border rounded-md px-2 py-1.5 text-sm outline-none focus:border-accent/50"
        />
      </label>
      <label className="block">
        <span className="text-xs font-bold uppercase tracking-wider text-muted">API key (optional)</span>
        <input
          type="password"
          value={store.kokoroApiKey}
          onChange={(e) => store.setKokoroApiKey(e.target.value)}
          placeholder="leave blank for local"
          className="mt-1 w-full bg-app-text/5 border border-app-border rounded-md px-2 py-1.5 text-sm outline-none focus:border-accent/50"
        />
      </label>
      <button
        onClick={load}
        disabled={loading}
        className="flex items-center justify-center gap-1.5 py-1.5 rounded-md bg-accent text-white text-sm font-medium disabled:opacity-50"
      >
        {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        {loaded ? 'Refresh voices' : 'Connect & load voices'}
      </button>
      {error && <p className="text-red-500 text-xs">{error}</p>}

      <VoiceRow label="Narrator" value={store.kokoroVoice} onChange={store.setKokoroVoice} />
      <VoiceRow label="You (user)" value={store.kokoroUserVoice} onChange={store.setKokoroUserVoice} />

      <div className="mt-1">
        <span className="text-xs font-bold uppercase tracking-wider text-muted">Character voices</span>
        {characters.length === 0 ? (
          <p className="text-[11px] text-muted leading-snug mt-1">
            Open a story to assign a voice to each character. Unassigned speakers use the narrator voice.
          </p>
        ) : (
          <div className="flex flex-col gap-2 mt-1.5">
            {characters.map(name => (
              <VoiceRow
                key={name}
                label={name}
                value={store.ttsVoiceByCharacter[name] ?? ''}
                onChange={(v) => store.setCharacterVoice(name, v)}
                defaultLabel="Narrator voice"
              />
            ))}
          </div>
        )}
      </div>

      <Toggle
        icon={<UserRound size={15} />}
        label="Auto-cast side characters"
        value={store.autoCastVoices}
        onChange={store.setAutoCastVoices}
      />
      <p className="text-[11px] text-muted leading-snug -mt-1">
        Give each unassigned side character its own distinct voice automatically. The narrator and
        the main character keep the voices above.
      </p>

      <p className="text-[11px] text-muted leading-snug">
        Run <a href="https://github.com/remsky/Kokoro-FastAPI" className="text-accent underline">Kokoro-FastAPI</a> locally
        (default <code>:8880</code>). Voices are sent per speaker as the reader streams.
      </p>
    </div>
  );
};

/** Ambient bed for the current theme: a built-in soundscape or a custom URL. */
const AmbientSettings = () => {
  const store = useAppStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const theme = store.theme;
  const themeLabel = THEMES[theme]?.label ?? theme;
  const spec = store.ambientByTheme[theme] ?? '';
  const builtin = spec.startsWith('builtin:') ? spec.slice(8) : '';
  const selectValue = builtin ? builtin : spec ? 'custom' : 'none';

  const onSelect = (v: string) => {
    if (v === 'none') store.setThemeAmbient(theme, '');
    else if (v === 'custom') store.setThemeAmbient(theme, spec && !builtin ? spec : '');
    else store.setThemeAmbient(theme, `builtin:${v}`);
  };

  return (
    <div className="ml-1 pl-3 border-l border-app-border flex flex-col gap-2">
      <div className="flex gap-2 items-center text-sm">
        <span className="w-24 shrink-0">Volume</span>
        <input
          type="range" min="0" max="1" step="0.05"
          value={store.ambientVolume}
          onChange={(e) => store.setAmbientVolume(Number(e.target.value))}
          className="flex-1 accent-[var(--app-accent)]"
        />
        <span className="font-mono w-8 text-right">{Math.round(store.ambientVolume * 100)}</span>
      </div>
      <div className="flex gap-2 items-center text-sm">
        <span className="w-24 shrink-0 truncate" title={themeLabel}>{themeLabel}</span>
        <select
          value={selectValue}
          onChange={(e) => onSelect(e.target.value)}
          className="flex-1 bg-app-text/5 border border-app-border rounded-md px-2 min-h-10 outline-none min-w-0"
        >
          <option value="none" className="text-black bg-white">None (silent)</option>
          {AMBIENT_SOUNDS.map(s => (
            <option key={s.id} value={s.id} className="text-black bg-white">{s.label}</option>
          ))}
          <option value="custom" className="text-black bg-white">Custom URL / file…</option>
        </select>
      </div>
      {selectValue === 'custom' && (
        <div className="flex gap-2 items-center">
          <input
            type="text"
            value={builtin ? '' : spec}
            onChange={(e) => store.setThemeAmbient(theme, e.target.value)}
            placeholder="https://…/ambience.mp3"
            className="flex-1 min-w-0 bg-app-text/5 border border-app-border rounded-md px-2 py-1.5 text-sm outline-none focus:border-accent/50"
          />
          <input
            type="file" accept="audio/*" ref={fileRef} className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) store.setThemeAmbient(theme, URL.createObjectURL(f));
              e.target.value = '';
            }}
          />
          <button
            onClick={() => fileRef.current?.click()}
            title="Pick a local audio file (plays this session; a URL persists across restarts)"
            className="p-1.5 rounded-md hover:bg-app-text/10 shrink-0 border border-app-border"
          >
            <FileText size={14} />
          </button>
        </div>
      )}
      <p className="text-[11px] text-muted leading-snug">
        The bed is tied to <b>{themeLabel}</b> — switch themes to give each its own atmosphere.
        Built-in soundscapes are synthesized (no downloads); a pasted URL persists, a picked file plays only this session.
      </p>
    </div>
  );
};

/**
 * What the Director has learned from this reader's own marks.
 *
 * The block is built from `tasteMarks` and spliced into every enrichment
 * prompt, which makes it exactly the kind of thing the app refuses to do
 * invisibly. Same rule as the visitor brief: the reader sees the payload,
 * verbatim, before it is ever sent, and can throw it away. A feature that
 * silently learns is a feature the reader cannot correct.
 */
const TasteControls = () => {
  const marks = useAuraV2Store(s => s.tasteMarks);
  const clearTaste = useAuraV2Store(s => s.clearTaste);
  const [show, setShow] = useState(false);
  const block = useMemo(() => tasteBlock(marks), [marks]);

  // Nothing marked yet. Say what would start it rather than showing an empty box.
  if (!block) {
    return (
      <p className="text-[11px] text-muted leading-snug">
        <b>Your marks teach it.</b> Select a span and give it a performance or a
        colour of your own, and the Director starts seeing a few of your calls
        before it reads. Clearing one of its cues teaches it just as much.
      </p>
    );
  }
  const shown = selectTaste(marks).length;
  return (
    <div className="rounded-lg border border-app-border/60 px-2 py-2 flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <button
          onClick={() => setShow(!show)}
          className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-app-text transition-colors"
          data-testid="taste-toggle"
        >
          <ChevronDown size={13} className={cn('transition-transform', show && 'rotate-180')} />
          Your marks in its prompt · {shown}
        </button>
        <button
          onClick={clearTaste}
          className="px-2 py-1 rounded-md text-[11px] bg-app-text/10 hover:bg-app-text/20"
          title="Forget every mark the Director has learned from. Your marks on the page stay exactly as they are."
          data-testid="taste-forget"
        >
          Forget
        </button>
      </div>
      {show && (
        <pre
          className="text-[10px] leading-snug text-muted whitespace-pre-wrap font-mono max-h-48 overflow-y-auto"
          data-testid="taste-block"
        >
          {block}
        </pre>
      )}
      <span className="text-[11px] text-muted leading-snug">
        Sent with every scene read, so it directs more like you do. Forgetting
        this does not touch the marks on your pages.
      </span>
    </div>
  );
};

/**
 * Live Reaction — reading with someone beside you.
 *
 * Sits under Ask Character because it is the same idea inverted: there you ask
 * and they answer, here they speak and you read. Everything about the boundary
 * is the same — anchored, clamped, reader-only, never canon.
 *
 * The two knobs that are not obvious both get a line of their own, because they
 * change what the feature IS rather than how loud it is: how much of the
 * passage they can see when they speak, and whether the page waits for them.
 */
const LiveReactionControls = () => {
  const storyId = useAppStore(s => s.currentStory?.id);
  const story = useAppStore(s => s.currentStory);
  const chains = useAppStore(s => s.chains);
  const on = useAppStore(s => s.liveReaction);
  const setOn = useAppStore(s => s.setLiveReaction);
  const reactor = useAppStore(s => s.liveReactor);
  const setReactor = useAppStore(s => s.setLiveReactor);
  const visibility = useAppStore(s => s.liveReactionVisibility);
  const setVisibility = useAppStore(s => s.setLiveReactionVisibility);
  const freeze = useAppStore(s => s.liveReactionFreeze);
  const setFreeze = useAppStore(s => s.setLiveReactionFreeze);
  const frame = useAppStore(s => s.liveReactionFrame);
  const setFrame = useAppStore(s => s.setLiveReactionFrame);
  const visitors = useAuraV2Store(s => (storyId ? s.visitorsByStory[storyId] : undefined));
  const [inviting, setInviting] = useState(false);

  // Everyone who could watch with you: the cast, plus anyone brought in.
  const who = useMemo(() => {
    const cast = castOf(chains.flatMap(c => c.messages), story?.userName);
    const guests = (visitors ?? []).map(v => v.name);
    return [...new Set([...cast, ...guests])];
  }, [chains, story?.userName, visitors]);

  const field = 'w-full bg-app-text/5 border border-app-border rounded-md px-2 py-1.5 '
    + 'text-xs outline-none focus:border-accent/50 min-h-9';

  return (
    <>
      <Toggle
        icon={<Popcorn size={16} />}
        label="Read with someone (AI)"
        hint="They watch it with you and react as it lands — one or two lines, in their voice. Nothing they say becomes part of the story."
        value={on}
        onChange={setOn}
        testId="live-reaction-toggle"
      />
      {on && (
        <div className="flex flex-col gap-1.5 px-2 pb-1">
          <label className="text-[11px] text-muted">Who is watching</label>
          <div className="flex items-center gap-1.5">
            <select
              className={field}
              value={reactor}
              onChange={(e) => setReactor(e.target.value)}
              data-testid="live-reactor"
            >
              <option value="">{story?.characterName || 'The character'}</option>
              {who.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
            {/* The same door as the interview's cast strip: the moment you are
              * choosing who watches with you is the moment you notice the person
              * you want is not on the list. */}
            <button
              onClick={() => setInviting(true)}
              title="Bring someone in from another chat, or from a card"
              data-testid="live-invite"
              className="shrink-0 grid place-items-center min-h-9 min-w-9 rounded-md border
                border-dashed border-app-text/20 text-app-text/50 hover:text-app-text
                hover:border-app-text/40"
            >
              <Plus size={14} />
            </button>
          </div>
          {inviting && (
            <InviteSheet
              onClose={() => setInviting(false)}
              onInvited={(name) => setReactor(name)}
            />
          )}

          <label className="text-[11px] text-muted mt-1">How much they can see</label>
          <select
            className={field}
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as 'upTo' | 'whole')}
            data-testid="live-visibility"
          >
            <option value="upTo">Only what you've uncovered</option>
            <option value="whole">The whole passage</option>
          </select>

          <select
            className={field}
            value={frame}
            onChange={(e) => setFrame(e.target.value as 'room' | 'phone')}
          >
            <option value="room">Beside you</option>
            <option value="phone">On the phone</option>
          </select>

          <Toggle
            icon={<Pause size={16} />}
            label="Wait for them"
            value={freeze}
            onChange={setFreeze}
          />
          <span className="text-[11px] text-muted leading-snug">
            The AI first picks the moments <b>this</b> person would break in on — no
            two companions stop at the same words — then speaks when the reveal
            reaches one, so the reaction lands mid-sentence instead of arriving
            at the end like a review. Moments and lines are cached per passage,
            so re-reading replays them rather than asking again. “Only what
            you've uncovered” is the point of it: they don't know how the
            sentence ends either. Show them the whole passage and the reaction
            comes back knowing. Off by default, they stay quiet on most passages,
            and none of it reaches the story, the Lens, or an export.
          </span>
        </div>
      )}
    </>
  );
};

/**
 * Scene Director controls (per open story). Hybrid pass: while enabled it
 * auto-reads the current page (see useSceneDirector); "Enrich all" reads the
 * rest on demand. Descriptors cache + invalidate by content hash, so edited
 * passages get re-read automatically.
 */
const SceneDirectorSection = () => {
  const storyId = useAppStore(s => s.currentStory?.id);
  const chains = useAppStore(s => s.chains);
  const aiReady = useAppStore(s => !!s.aiBaseUrl && !!s.aiModel);
  const aiBase = useAppStore(s => s.aiBaseUrl);
  const ai = useService('ai', aiBase);
  const aiDown = ai.state === 'down' ? ai.blockedReason : null;
  const enabled = useAuraV2Store(s => (storyId ? !!s.directorEnabledByStory[storyId] : false));
  const setDirectorEnabled = useAuraV2Store(s => s.setDirectorEnabled);
  const sceneCache = useAuraV2Store(s => (storyId ? s.sceneByStory[storyId] : undefined));
  const sceneTheming = useAppStore(s => s.sceneTheming);
  const setSceneTheming = useAppStore(s => s.setSceneTheming);
  const sceneSoundscapes = useAppStore(s => s.sceneSoundscapes);
  const setSceneSoundscapes = useAppStore(s => s.setSceneSoundscapes);
  const emotionalTts = useAppStore(s => s.emotionalTts);
  const setEmotionalTts = useAppStore(s => s.setEmotionalTts);
  const sceneEmphasis = useAppStore(s => s.sceneEmphasis);
  const setSceneEmphasis = useAppStore(s => s.setSceneEmphasis);
  const scenePerformance = useAppStore(s => s.scenePerformance);
  const setScenePerformance = useAppStore(s => s.setScenePerformance);
  const aiRepairFormatting = useAppStore(s => s.aiRepairFormatting);
  const askCharacter = useAppStore(s => s.askCharacter);
  const setAskCharacter = useAppStore(s => s.setAskCharacter);
  const setAiRepairFormatting = useAppStore(s => s.setAiRepairFormatting);
  const running = useSceneDirectorStore(s => s.running);
  const done = useSceneDirectorStore(s => s.done);
  const total = useSceneDirectorStore(s => s.total);
  const unread = useSceneDirectorStore(s => s.unread);
  // Open the drawer when these keys no longer agree with the chosen mode.
  const diverged = useAppStore(s => !modeMatches(s, s.readingMode));

  const coverage = useMemo(
    () => (storyId ? directorCoverage(storyId) : { directed: 0, total: 0 }),
    // Recompute when the story, its text, or the descriptor cache changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storyId, chains, sceneCache],
  );

  if (!storyId) return null;
  const complete = coverage.total > 0 && coverage.directed >= coverage.total;

  return (
    <Section title="Scene Director">
      <Toggle
        icon={<Clapperboard size={16} />}
        label="AI scene reading"
        value={enabled}
        onChange={(v) => setDirectorEnabled(storyId, v)}
      />
      {!aiReady ? (
        <span className="text-[11px] text-muted">
          Set an AI endpoint in the assistant panel to enable the Director.
        </span>
      ) : (
        <>
          {/* Configured is not the same question as answering. Enablement still
            * keys off config — a probe that is slow or flaps must never make a
            * button disappear under the reader's cursor — but a dead endpoint
            * says so here instead of failing silently on the first run. */}
          {aiDown && (
            <span className="text-[11px] text-amber-400/90 px-2" data-testid="ai-endpoint-down">
              {aiDown}
            </span>
          )}
          <div className="flex items-center justify-between text-xs px-2">
            <span className="opacity-70">
              {running
                ? `Reading… ${done}/${total}`
                : `Directed ${coverage.directed}/${coverage.total} passages`}
              {unread > 0 && (
                <span
                  className="ml-1.5 text-amber-400/90"
                  title="The model returned nothing usable for these, even after retrying them in smaller groups. Usually means the model is too small for the job — try a larger one."
                >
                  · {unread} unreadable
                </span>
              )}
            </span>
            {running ? (
              <button
                onClick={() => stopEnrich()}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] bg-app-text/10 hover:bg-app-text/20"
              >
                <Square size={11} /> Stop
              </button>
            ) : (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => void retryCurrentPage(storyId)}
                  disabled={!enabled}
                  title="Re-read the page you're on (drops its cached read and runs the Director again)"
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] bg-app-text/10 hover:bg-app-text/20 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <RefreshCw size={11} /> Retry page
                </button>
              <button
                onClick={() => void enrichAll(storyId)}
                disabled={!enabled || complete || coverage.total === 0}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] bg-accent/15 text-accent font-medium disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {complete ? 'All read' : 'Enrich all'}
              </button>
              </div>
            )}
          </div>
          <Advanced label="Set by your reading mode" open={diverged}>
            <Toggle
              icon={<Sparkles size={16} />}
              label="Adaptive theming"
              value={sceneTheming}
              onChange={setSceneTheming}
            />
            <Toggle
              icon={<Music2 size={16} />}
              label="Adaptive soundscapes"
              value={sceneSoundscapes}
              onChange={setSceneSoundscapes}
            />
            <Toggle
              icon={<Volume2 size={16} />}
              label="Emotional narration (TTS)"
              value={emotionalTts}
              onChange={setEmotionalTts}
            />
            <Toggle
              icon={<Sparkles size={16} />}
              label="Emphasize whisper / shout words"
              value={sceneEmphasis}
              onChange={setSceneEmphasis}
            />
            <Toggle
              icon={<Clapperboard size={16} />}
              label="Perform the text (pacing + kinetics)"
              value={scenePerformance}
              onChange={setScenePerformance}
            />
          </Advanced>
          <Toggle
            icon={<Wand2 size={16} />}
            label="Repair broken formatting (AI)"
            value={aiRepairFormatting}
            onChange={setAiRepairFormatting}
          />
          <Toggle
            icon={<MessageCircle size={16} />}
            label="Ask the character (AI)"
            hint="Interview them about the beat you’re on. They only know the story up to that point, and nothing they say becomes part of it."
            value={askCharacter}
            onChange={setAskCharacter}
            testId="ask-character-toggle"
          />
          <TasteControls />
          <LiveReactionControls />
          <span className="text-[11px] text-muted">
            The Director reads each passage's mood, location, and feeling so the
            reader can adapt to the scene. The current page reads automatically;
            “Enrich all” does the rest. Edited passages are re-read on their own.
            Theming tints the page to the scene's mood; soundscapes pick the
            ambient bed from it (needs ambient audio on); emotional narration
            shapes the TTS voice by the speaker's feeling (needs TTS on). Word
            emphasis italicizes/bolds individual whispered or shouted words — it's
            off by default because it can read as scattered styling. Performing
            the text lets the Director bend the reveal itself — dragging a line
            out, rushing a panic, beating between words (“In. the. end.”), holding
            a silence before a reveal, cutting speech off dead, swelling or
            trembling the words as they arrive, or unwriting them off the page.
            Strength follows the Expressive intensity preset, and with no AI read
            it falls back to reading the cadence off the punctuation. You can also
            direct any passage yourself: select the words and pick a direction —
            your call always beats the Director's on the same span. Formatting
            repair asks the AI to close cut-off dialogue and emphasis where they
            naturally end; each fix is an undoable Lens edit, and only the
            markup characters can change — never the words.
          </span>
        </>
      )}
    </Section>
  );
};

export const SettingsPanel = ({
  onOpenAutoFormat, onOpenRefine, onOpenSync, onOpenProxy, onOpenSmartExport, onOpenBackup,
}: {
  onOpenAutoFormat: () => void;
  onOpenRefine: () => void;
  onOpenSync: () => void;
  onOpenProxy: () => void;
  onOpenSmartExport: () => void;
  onOpenBackup: () => void;
}) => {
  const store = useAppStore();
  // Same sanitiser the renderer runs, so the panel can never show a channel the
  // page is not actually drawing.
  const markupPresets = useMemo(() => sanitizeMarkupPresets(store.markupPresets), [store.markupPresets]);
  const [configName, setConfigName] = useState('');
  const voices = useVoices();
  const customFonts = useFontStore(s => s.fonts);
  const addFont = useFontStore(s => s.addFont);
  const removeFont = useFontStore(s => s.removeFont);
  const fontError = useFontStore(s => s.error);
  const fontInputRef = useRef<HTMLInputElement>(null);

  if (!store.settingsOpen) return null;

  const close = () => store.setSettingsOpen(false);
  // Reveal the mode's individual keys when they no longer agree with it.
  const diverged = !modeMatches(store, store.readingMode);
  /**
   * The two modes that generate nothing and drive no backend.
   *
   * Plain is words on a page; Lit tints the page from the scene's mood and
   * stops there. Neither makes a picture or plays a sound, so the panels that
   * configure picture-making and sound live folded in both.
   */
  const quietModes = store.readingMode === 'plain' || store.readingMode === 'lit';

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={close} />

      <div className="absolute right-0 top-0 h-full w-full max-w-sm bg-surface text-app-text border-l border-app-border shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-app-border">
          <h2 className="text-lg font-bold">Settings</h2>
          <button
            onClick={close}
            aria-label="Close settings"
            className="flex items-center justify-center min-h-11 min-w-11 rounded-full hover:bg-app-text/10 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-6">
          <ReadingModeSection />

          <Section title="Appearance">
            <SelectRow
              label="Theme"
              value={store.theme}
              onChange={(v) => store.setTheme(v as any)}
              options={Object.values(THEMES).map(t => ({ value: t.id, label: t.label }))}
            />
            {store.theme === 'custom' && (
              <div className="flex gap-3 items-center text-sm pl-24 ml-2">
                <label className="flex items-center gap-1.5">
                  <input
                    type="color"
                    value={store.textColor}
                    onChange={(e) => store.setTextColor(e.target.value)}
                    className="w-7 h-7 rounded cursor-pointer"
                  />
                  Text
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="color"
                    value={store.bgColor}
                    onChange={(e) => store.setBgColor(e.target.value)}
                    className="w-7 h-7 rounded cursor-pointer"
                  />
                  Background
                </label>
              </div>
            )}
            <div className="flex gap-2 items-start text-sm">
              <span className="w-24 shrink-0 pt-1">Accent</span>
              <div className="flex flex-wrap gap-1.5 flex-1">
                {ACCENTS.map(a => (
                  <button
                    key={a.id || 'theme'}
                    title={a.label}
                    onClick={() => store.setAccentColor(a.id)}
                    className={cn(
                      'w-6 h-6 rounded-full border transition-transform hover:scale-110',
                      'relative before:absolute before:-inset-2 before:content-[\'\']',
                      store.accentColor === a.id ? 'ring-2 ring-offset-2 ring-offset-surface ring-app-text scale-110' : 'border-app-border',
                    )}
                    style={a.hex
                      ? { background: a.hex }
                      : { background: 'conic-gradient(from 0deg, #f43f5e, #f59e0b, #10b981, #0ea5e9, #8b5cf6, #f43f5e)' }}
                  />
                ))}
              </div>
            </div>
            <SelectRow
              label="Font"
              value={store.fontFamily}
              onChange={(v) => store.setFontFamily(v as any)}
              options={[
                { value: 'theme', label: 'Theme default' },
                { value: 'sans', label: 'Sans-serif' },
                { value: 'serif', label: 'Serif' },
                { value: 'mono', label: 'Monospace' },
                { value: 'slab', label: 'Slab Serif' },
                { value: 'rounded', label: 'Rounded' },
                { value: 'handwriting', label: 'Handwriting' },
                { value: 'typewriter', label: 'Typewriter' },
                { value: 'medieval', label: 'Medieval' },
                { value: 'comic', label: 'Comic' },
                { value: 'calligraphy', label: 'Calligraphy' },
                { value: 'dyslexic', label: 'OpenDyslexic' },
                ...customFonts.map(f => ({ value: `custom:${f.id}`, label: `${f.name} (yours)` })),
              ]}
            />
            <div className="flex flex-col gap-1.5 pl-24 -mt-1">
              <input
                ref={fontInputRef}
                type="file"
                accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void addFont(file).then(() => store.setFontFamily(`custom:${useFontStore.getState().fonts.at(-1)!.id}`)).catch(() => {});
                  e.target.value = '';
                }}
              />
              <button
                onClick={() => fontInputRef.current?.click()}
                className="self-start flex items-center gap-1.5 text-xs px-2.5 min-h-11 rounded-lg border border-app-border hover:bg-app-text/5 transition-colors"
              >
                <Type size={13} /> Upload font (.ttf/.otf/.woff)
              </button>
              {fontError && <p className="text-[11px] text-red-500 leading-snug">{fontError}</p>}
              {customFonts.length > 0 && (
                <div className="flex flex-col gap-1">
                  {customFonts.map(f => (
                    <div key={f.id} className="flex items-center justify-between text-xs bg-app-text/5 rounded-md px-2 py-1">
                      <span style={{ fontFamily: `"${f.family}", var(--font-sans)` }} className="truncate">{f.name}</span>
                      <button
                        onClick={() => {
                          if (store.fontFamily === `custom:${f.id}`) store.setFontFamily('theme');
                          void removeFont(f.id);
                        }}
                        className="flex items-center justify-center min-h-10 min-w-10 rounded hover:bg-red-500/10 text-muted hover:text-red-500 transition-colors shrink-0"
                        title={`Remove ${f.name}`}
                        aria-label={`Remove ${f.name}`}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 bg-app-text/5 px-3 rounded-lg justify-between py-1.5 text-sm">
              <span>Font Size</span>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => store.setFontSize(Math.max(12, store.fontSize - 1))}
                  aria-label="Smaller text"
                  className="flex items-center justify-center min-h-10 min-w-10 rounded hover:bg-app-text/10"
                >
                  −
                </button>
                <span className="font-mono w-6 text-center">{store.fontSize}</span>
                <button
                  onClick={() => store.setFontSize(Math.min(32, store.fontSize + 1))}
                  aria-label="Larger text"
                  className="flex items-center justify-center min-h-10 min-w-10 rounded hover:bg-app-text/10"
                >
                  +
                </button>
              </div>
            </div>
            <div className="flex flex-col gap-1 bg-app-text/5 px-3 py-2 rounded-lg text-sm">
              <div className="flex justify-between items-center">
                <span>Content Width</span>
                <span className="font-mono text-xs opacity-70">
                  {store.contentWidth === 0 ? 'Default' : `${store.contentWidth}px`}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={1800}
                step={40}
                value={store.contentWidth}
                onChange={(e) => store.setContentWidth(Number(e.target.value))}
                className="w-full accent-accent"
              />
              <span className="text-[11px] text-muted">
                Widen the reading column (best on desktop). 0 = theme default.
              </span>
            </div>
            <Toggle
              icon={<Sparkles size={16} />}
              label="Ambient theme effects"
              value={store.themeEffects}
              onChange={store.setThemeEffects}
            />
            <Advanced label="Set by your reading mode" open={diverged}>
              <Toggle
                icon={<Sparkles size={16} />}
                label="Living background"
                value={store.livingBackground}
                onChange={store.setLivingBackground}
              />
              <span className="text-[11px] text-muted -mt-1">
                A gentle animated backdrop suited to the theme — drifting motes,
                embers, petals, stars, or rain. Needs ambient effects on; pauses
                when your system prefers reduced motion.
              </span>
            </Advanced>
          </Section>

          <Section title="Reveal Animation">
            <div className="grid grid-cols-3 gap-2">
              {(['typewriter', 'smooth', 'magic', 'fade', 'blur', 'ink', 'glitch', 'rise', 'decrypt'] as const).map(style => (
                <button
                  key={style}
                  onClick={() => store.setAnimationStyle(style)}
                  className={cn(
                    'py-1.5 min-h-11 text-xs rounded-md border capitalize transition-colors',
                    store.animationStyle === style
                      ? 'border-accent bg-accent/10 text-accent font-bold'
                      : 'border-transparent bg-app-text/5 hover:bg-app-text/10',
                  )}
                >
                  {style === 'typewriter' ? 'Typing' : style}
                </button>
              ))}
            </div>
            <span className="text-[11px] text-muted">
              Some themes bring their own signature reveal while ambient
              effects are on (e.g. Hacker decrypts, Grimoire inks in).
            </span>
            <Advanced label="Set by your reading mode" open={diverged}>
              <div className="pt-2">
                <p className="text-xs font-medium mb-1.5 opacity-80">Streaming text effect</p>
                <div className="grid grid-cols-3 gap-2">
                  {STREAM_EFFECTS.map(effect => (
                    <button
                      key={effect}
                      onClick={() => store.setStreamEffect(effect)}
                      className={cn(
                        'py-1.5 min-h-11 text-xs rounded-md border capitalize transition-colors',
                        store.streamEffect === effect
                          ? 'border-accent bg-accent/10 text-accent font-bold'
                          : 'border-transparent bg-app-text/5 hover:bg-app-text/10',
                      )}
                    >
                      {effect === 'none' ? 'Off' : effect}
                    </button>
                  ))}
                </div>
                <span className="text-[11px] text-muted">
                  Dresses each word as it streams in — on top of (and independent
                  from) the block reveal above. Most of them animate the word's
                  arrival; “ember” instead lands it in the accent colour and lets
                  it cool into the prose, so the tail reads as heat rather than
                  motion and nothing has to be waited for.
                </span>
              </div>
              <div className="pt-2 flex flex-col gap-1">
                <p className="text-xs font-medium mb-0.5 opacity-80">Expressive reading</p>
                <Toggle
                  icon={<Type size={16} />}
                  label="Kinetic emphasis"
                  value={store.expressiveText}
                  onChange={store.setExpressiveText}
                />
                <Toggle
                  icon={<Sparkles size={16} />}
                  label="Cinematic pacing"
                  value={store.cinematicPacing}
                  onChange={store.setCinematicPacing}
                />
                {(store.expressiveText || store.cinematicPacing) && (
                  <div className="pt-1">
                    <p className="text-xs font-medium mb-1.5 opacity-80">Intensity</p>
                    <div className="grid grid-cols-3 gap-2">
                      {(['subtle', 'expressive', 'cinematic'] as const).map(level => (
                        <button
                          key={level}
                          onClick={() => store.setExpressiveIntensity(level)}
                          className={cn(
                            'py-1.5 min-h-11 text-xs rounded-md border capitalize transition-colors',
                            store.expressiveIntensity === level
                              ? 'border-accent bg-accent/10 text-accent font-bold'
                              : 'border-transparent bg-app-text/5 hover:bg-app-text/10',
                          )}
                        >
                          {level}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <span className="text-[11px] text-muted">
                  Scales shouted <span className="expr-shout" style={{ fontSize: '1em' }}>WORDS</span>,
                  dresses scene breaks, and lets the reveal linger in dialogue and
                  beat on scene changes.
                </span>
              </div>
            </Advanced>
            {/* Drop caps is typographic taste, not performance — the mode
                doesn't own it, so it stays out on the surface. */}
            <Toggle
              icon={<Type size={16} />}
              label="Drop caps"
              value={store.dropCaps}
              onChange={store.setDropCaps}
            />
            <span className="text-[11px] text-muted -mt-1">
              Opens each AI passage with a large book-style initial.
            </span>
          </Section>

          <SceneDirectorSection />

          <Section title="Reading">
            <Toggle
              icon={<Focus size={16} />}
              label="Autofocus Handsfree Mode"
              value={store.isAutofocusMode}
              onChange={store.setIsAutofocusMode}
              accent
              testId="autofocus-mode"
            />
            {store.isAutofocusMode && (
              <div className="ml-4 pl-3 border-l border-app-border flex flex-col gap-1">
                <Toggle
                  icon={<ZoomIn size={15} />}
                  label="Auto-zoom on streaming text"
                  value={store.autofocusAutoZoom}
                  onChange={(v) => {
                    store.setAutofocusAutoZoom(v);
                    store.setAutofocusZoom(v ? 1.4 : 1);
                  }}
                />
                <Toggle
                  icon={<Focus size={15} />}
                  label="Magnify the reading line"
                  hint="Lights a band around the words as they arrive and softens the rest of the passage."
                  value={store.focusMagnifier}
                  onChange={store.setFocusMagnifier}
                  testId="focus-magnifier"
                />
                {store.focusMagnifier && (
                  <SelectRow
                    label="Look"
                    value={store.magnifierStyle}
                    onChange={(v) => store.setMagnifierStyle(v as MagnifierStyle)}
                    testId="magnifier-style"
                    options={MAGNIFIER_STYLES.map(m => ({ value: m.id, label: m.label }))}
                  />
                )}
                {store.focusMagnifier && (
                  <p className="px-2 -mt-1 text-[11px] opacity-60">
                    {MAGNIFIER_STYLES.find(m => m.id === store.magnifierStyle)?.hint}
                  </p>
                )}
                <div className="flex gap-2 items-center text-sm px-2 py-1">
                  <span className="w-20 shrink-0">Zoom</span>
                  <input
                    type="range" min="0.8" max="2.5" step="0.1"
                    value={store.autofocusZoom}
                    onChange={(e) => store.setAutofocusZoom(Number(e.target.value))}
                    className="flex-1 accent-[var(--app-accent)]"
                  />
                  <span className="font-mono w-10 text-right">{store.autofocusZoom.toFixed(1)}×</span>
                </div>
              </div>
            )}
            <Toggle
              icon={<PlayCircle size={16} />}
              label="Auto-Stream"
              value={store.autoStream}
              onChange={store.setAutoStream}
            />
            <Toggle
              icon={<LayoutTemplate size={16} />}
              label="Pagination (Book Pages)"
              value={store.layoutMode === 'paginated'}
              onChange={(v) => store.setLayoutMode(v ? 'paginated' : 'continuous')}
            />
            {store.layoutMode === 'paginated' && (
              <Toggle
                icon={<PauseCircle size={16} />}
                label="Stop at End of Page"
                value={store.pauseAtPageEnd}
                onChange={store.setPauseAtPageEnd}
              />
            )}
          </Section>

          <Section title="Autoreader">
            <div className="flex gap-2 items-center text-sm">
              <span className="w-24 shrink-0">Reveal</span>
              <div className="flex flex-1 bg-app-text/5 p-1 rounded-lg">
                {(['character', 'word'] as const).map(mode => (
                  <button
                    key={mode}
                    onClick={() => store.setRevealMode(mode)}
                    className={cn(
                      'flex-1 py-1 min-h-10 text-xs rounded-md transition-colors',
                      store.revealMode === mode
                        ? 'bg-surface shadow-sm text-accent font-bold'
                        : 'opacity-60 hover:opacity-100',
                    )}
                  >
                    {mode === 'character' ? 'By letter' : 'By word'}
                  </button>
                ))}
              </div>
            </div>
            <SelectRow
              label="Msg pause"
              value={String(store.messagePause)}
              onChange={(v) => store.setMessagePause(Number(v))}
              options={[
                { value: '0', label: 'None' },
                { value: '400', label: 'Short (0.4s)' },
                { value: '1000', label: 'Medium (1s)' },
                { value: '2000', label: 'Long (2s)' },
              ]}
            />
            <Toggle
              icon={<Volume2 size={16} />}
              label="Read Aloud (TTS)"
              value={store.ttsEnabled}
              onChange={store.setTtsEnabled}
            />
            {store.ttsEnabled && (
              <>
                <SelectRow
                  label="Engine"
                  value={store.ttsEngine}
                  onChange={(v) => store.setTtsEngine(v as 'browser' | 'kokoro')}
                  options={[
                    { value: 'browser', label: 'System voices (offline)' },
                    { value: 'kokoro', label: 'Kokoro (neural, per-character)' },
                  ]}
                />
                {store.ttsEngine === 'browser' && ttsSupported() && (
                  <>
                    <SelectRow
                      label="Voice"
                      value={store.ttsVoiceURI}
                      onChange={store.setTtsVoiceURI}
                      options={[
                        { value: '', label: 'System default' },
                        ...[...voices]
                          .sort((a, b) => {
                            const rank = (v: SpeechSynthesisVoice) =>
                              /natural|online|neural/i.test(v.name) ? 0 : v.localService ? 1 : 2;
                            return rank(a) - rank(b) || a.name.localeCompare(b.name);
                          })
                          .map(v => ({
                            value: v.voiceURI,
                            label: `${/natural|online|neural/i.test(v.name) ? '★ ' : ''}${v.name} (${v.lang})`,
                          })),
                      ]}
                    />
                    <p className="text-[11px] text-muted leading-snug px-1">
                      ★ marks higher-quality "natural / online" voices. More voices come from your
                      OS — on Windows, add them in Settings → Time &amp; Language → Speech.
                    </p>
                  </>
                )}
                {store.ttsEngine === 'browser' && !ttsSupported() && (
                  <p className="text-[11px] text-amber-500 leading-snug px-1">
                    This browser has no built-in speech voices — switch the engine to Kokoro.
                  </p>
                )}
                {store.ttsEngine === 'kokoro' && <KokoroSettings />}
                {store.ttsEngine === 'kokoro' && (
                  <>
                    <Toggle
                      icon={<UserRound size={15} />}
                      label="Multi-voice dialogue"
                      value={store.ttsMultiVoice}
                      onChange={store.setTtsMultiVoice}
                    />
                    <p className="text-[11px] text-muted leading-snug px-1">
                      Reads narration in the speaker's voice and voices each character's
                      quoted dialogue in their own cast voice.
                    </p>
                  </>
                )}
                <Toggle
                  icon={<MessageSquareQuote size={15} />}
                  label="Dialogue-only"
                  value={store.ttsDialogueOnly}
                  onChange={store.setTtsDialogueOnly}
                />
                <p className="text-[11px] text-muted leading-snug px-1">
                  Voices only the quoted dialogue — in each speaker's voice — as the reveal
                  reaches each line, leaving narration silent. A conversational read instead
                  of a narrator reading everything.
                </p>
                <Toggle
                  icon={<Volume2 size={15} />}
                  label="Match reading speed"
                  value={store.ttsFollowSpeed}
                  onChange={store.setTtsFollowSpeed}
                />
                <div className="flex gap-2 items-center text-sm">
                  <span className="w-24 shrink-0">Base rate</span>
                  <input
                    type="range" min="0.5" max="2" step="0.1"
                    value={store.ttsRate}
                    onChange={(e) => store.setTtsRate(Number(e.target.value))}
                    className="flex-1 accent-[var(--app-accent)]"
                  />
                  <span className="font-mono w-8 text-right">{store.ttsRate.toFixed(1)}×</span>
                </div>
                {store.ttsEngine === 'browser' && (
                  <div className="flex gap-2 items-center text-sm">
                    <span className="w-24 shrink-0">Pitch</span>
                    <input
                      type="range" min="0" max="2" step="0.1"
                      value={store.ttsPitch}
                      onChange={(e) => store.setTtsPitch(Number(e.target.value))}
                      className="flex-1 accent-[var(--app-accent)]"
                    />
                    <span className="font-mono w-8 text-right">{store.ttsPitch.toFixed(1)}</span>
                  </div>
                )}
              </>
            )}
            <Toggle
              icon={<Music2 size={16} />}
              label="Ambient sound"
              value={store.ambientEnabled}
              onChange={store.setAmbientEnabled}
            />
            {store.ambientEnabled && <AmbientSettings />}
            <Toggle
              icon={<Music2 size={16} />}
              label="Scene audio (AI-generated SFX / music)"
              value={store.audioCuesEnabled}
              onChange={store.setAudioCuesEnabled}
            />
            {store.audioCuesEnabled && (
              <div className="flex flex-col gap-1.5 pl-1">
                <label className="text-xs text-muted flex items-center gap-1.5">
                  Audio service URL <ServiceDot id="audio" />
                </label>
                <input
                  type="text"
                  value={store.audioBaseUrl}
                  onChange={(e) => store.setAudioBaseUrl(e.target.value)}
                  placeholder="http://localhost:8899"
                  className="bg-app-text/5 border border-app-border rounded-md px-2 py-1.5 text-sm outline-none focus:border-accent/50"
                />
                <p className="text-[11px] text-muted leading-snug">
                  Runs the optional local <code>aura-audio</code> service (Stable Audio 3). When on, the
                  Scene Director searches/generates SFX, ambience &amp; music and plays them in Sandbox
                  scenes, and while reading the scene ambience bed is drawn from the generated library
                  (reused when it fits). Off → scenes use built-in procedural sounds. The reader works either way.
                </p>
                <AudioLibraryButton />
                <Toggle
                  icon={<Sparkles size={16} />}
                  label="Offer to generate scene audio"
                  value={store.audioLiveGen}
                  onChange={store.setAudioLiveGen}
                />
                <p className="text-[11px] text-muted leading-snug">
                  When a scene has no matching clip yet, offer a one-tap prompt to “set the scene” by
                  generating one (e.g. a tavern → crowd chatter). Off → the reader only ever REUSES clips
                  that already exist; nothing is generated on its own.
                </p>
                <Toggle
                  icon={<Music2 size={16} />}
                  label="Scene music"
                  value={store.sceneMusic}
                  onChange={store.setSceneMusic}
                />
                <p className="text-[11px] text-muted leading-snug">
                  Layer generated music over ambience on scenes that earn it — high tension, awe/action
                  moods, or musical places (a bard, a festival). It ducks under narration and crossfades
                  between scenes.
                </p>
                {store.sceneMusic && (
                  <label className="flex items-center gap-2 text-xs text-muted pl-1">
                    <span className="w-16 shrink-0">Music vol</span>
                    <input
                      type="range" min={0} max={1} step={0.05}
                      value={store.musicVolume}
                      onChange={(e) => store.setMusicVolume(parseFloat(e.target.value))}
                      className="flex-1 accent-current"
                    />
                    <span className="w-8 text-right tabular-nums">{Math.round(store.musicVolume * 100)}</span>
                  </label>
                )}
                <label className="flex items-center gap-2 text-xs text-muted pt-1">
                  <Zap size={16} className="shrink-0" />
                  <span className="flex-1">Sound effects</span>
                  <select
                    value={store.sfxPermissiveness}
                    onChange={(e) => store.setSfxPermissiveness(e.target.value as any)}
                    className="bg-app-text/5 border border-app-border rounded-md px-2 py-1 text-sm outline-none focus:border-accent/50"
                  >
                    <option value="off">Off</option>
                    <option value="light">Light</option>
                    <option value="medium">Medium</option>
                    <option value="immersive">Immersive</option>
                  </select>
                </label>
                <p className="text-[11px] text-muted leading-snug">
                  Fires a one-shot at charged moments as you read (a crash, a scream, a fall).
                  <b> Light</b> = 1–2, only if pivotal · <b>Medium</b> = up to 5 · <b>Immersive</b> = up to 20.
                  Reuses library clips; only generates new ones when “Offer to generate” is on.
                </p>
              </div>
            )}
          </Section>

          {/*
            * What the chat file said, as against what the story said.
            *
            * All three of these are about FIDELITY to the source rather than
            * presentation, which is why they sit together rather than being
            * scattered through Reading and Text Processing: each one is the
            * reader answering "show me what the machine wrote, or don't".
            */}
          <Section title="From the chat file">
            <Toggle
              icon={<Brain size={16} />}
              label="Show thinking"
              hint="Chain-of-thought the model recorded, in its own collapsed section."
              value={store.showReasoning}
              onChange={store.setShowReasoning}
              testId="toggle-reasoning"
            />
            <Toggle
              icon={<EyeOff size={16} />}
              label="Show hidden messages"
              hint="Entries SillyTavern marked /hide or system — including some narrator lines."
              value={store.showHiddenMessages}
              onChange={store.setShowHiddenMessages}
              testId="toggle-hidden"
            />
            <Toggle
              icon={<Palette size={16} />}
              label="Respect original colour formatting"
              hint="Keep <font color> the author wrote, instead of folding it into your own styling."
              value={store.fontColorMode !== 'ignore'}
              onChange={on => store.setFontColorMode(on ? 'original' : 'ignore')}
              testId="toggle-font-color"
            />
            {store.fontColorMode !== 'ignore' && (
              <div className="ml-4 pl-3 border-l border-app-border">
                <div className="grid grid-cols-2 gap-2">
                  {([
                    { mode: 'original' as const, label: 'As written' },
                    { mode: 'adapt' as const, label: 'Fit the theme' },
                  ]).map(opt => (
                    <button
                      key={opt.mode}
                      onClick={() => store.setFontColorMode(opt.mode)}
                      aria-pressed={store.fontColorMode === opt.mode}
                      className={cn(
                        'py-1.5 min-h-11 text-xs rounded-md border transition-colors',
                        store.fontColorMode === opt.mode
                          ? 'border-accent bg-accent/10 text-accent font-bold'
                          : 'border-transparent bg-app-text/5 hover:bg-app-text/10',
                      )}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <span className="block text-[11px] text-muted mt-1.5">
                  {store.fontColorMode === 'adapt'
                    ? 'Keeps the hue the author chose and re-lights it for this theme, so a colour picked against the opposite background is still readable.'
                    : 'Exactly the colour in the file. A colour chosen for a dark front-end may be hard to read on a light theme.'}
                </span>
              </div>
            )}
          </Section>

          <Section title="Text Processing">
            <Toggle
              icon={<Sparkles size={16} />}
              label="Auto-Format"
              value={store.autoFormat}
              onChange={store.setAutoFormat}
            />
            {store.autoFormat && (
              <div className="ml-4 pl-3 border-l border-app-border flex flex-col gap-1">
                <Toggle
                  icon={<AlignLeft size={15} />}
                  label="Paragraph spacing"
                  value={store.paragraphSpacing}
                  onChange={store.setParagraphSpacing}
                />
                <Toggle
                  icon={<MessageSquareQuote size={15} />}
                  label="Dialogue on its own line"
                  value={store.dialogueOwnLine}
                  onChange={store.setDialogueOwnLine}
                />
                <Toggle
                  icon={<Type size={15} />}
                  label="Smart typography (… —)"
                  value={store.smartTypography}
                  onChange={store.setSmartTypography}
                />
              </div>
            )}
            <Toggle
              icon={<Quote size={16} />}
              label="Style Quoted Dialogue"
              value={store.styleQuotes}
              onChange={store.setStyleQuotes}
            />
            <Toggle
              icon={<UserRound size={16} />}
              label="Replace {{user}} / {{char}}"
              value={store.substituteNames}
              onChange={store.setSubstituteNames}
            />
            <Toggle
              icon={<ImageIcon size={16} />}
              label="Show Images"
              value={store.showImages}
              onChange={store.setShowImages}
            />
            <Toggle
              icon={<FileText size={16} />}
              label="Hide Metadata Tags"
              value={store.hideMetadata}
              onChange={store.setHideMetadata}
            />
            <SelectRow
              label="OOC asides"
              value={store.oocHandling}
              onChange={(v) => store.setOocHandling(v as any)}
              options={[
                { value: 'show', label: 'Show normally' },
                { value: 'dim', label: 'Dim (muted italic)' },
                { value: 'hide', label: 'Hide entirely' },
              ]}
            />
            <button
              onClick={() => { close(); onOpenAutoFormat(); }}
              className="flex items-center justify-between p-2 rounded-lg hover:bg-app-text/5 transition-colors text-sm text-accent bg-accent/10"
            >
              <div className="flex items-center gap-2">
                <Terminal size={16} />
                <div className="text-left">
                  <span className="block">Formatting Studio</span>
                  <span className="block text-[10px] opacity-70 font-normal">
                    Force-format stats ([Health] 100 → panels) · regex rules · AI reformat
                  </span>
                </div>
              </div>
              <span>&rarr;</span>
            </button>
            <button
              onClick={() => { close(); onOpenRefine(); }}
              className="flex items-center justify-between p-2 rounded-lg hover:bg-app-text/5 transition-colors text-sm text-accent bg-accent/10"
            >
              <div className="flex items-center gap-2">
                <Wand2 size={16} />
                <div className="text-left">
                  <span className="block">Narrative Refinery</span>
                  <span className="block text-[10px] opacity-70 font-normal">
                    Extract nouns/verbs · restyle to another author · grounded, saved to Lens
                  </span>
                </div>
              </div>
              <span>&rarr;</span>
            </button>
          </Section>

          {/*
            * SillyTavern sync, off until asked for.
            *
            * Gated rather than merely tucked away: with the switch off, the
            * panel cannot be opened, the library shows no sync affordances, and
            * `useStBridge` attaches no message listener — a feature that lets
            * another window talk to this one should be inert until invited,
            * not just out of sight.
            */}
          {/* Its own section rather than a line under the AI settings.
            *
            * This is a different permission from the rest, and burying it as a
            * sub-toggle of "agent mode" would make a reader who wants help
            * finding a button hand over their pins to get it. */}
          <Section title="AI Tour Guide">
            <Toggle
              icon={<Compass size={16} />}
              label="Let the assistant show you around"
              hint="It can look up how the app works, take you to the right view, and change your display settings. It cannot touch your stories, your endpoint or your data."
              value={store.aiTourGuide}
              onChange={store.setAiTourGuide}
              testId="toggle-tour-guide"
            />
            <p className="text-[11px] text-muted leading-snug px-1">
              Needs an AI endpoint connected. Ask it things like “where are my highlights”,
              “make the text bigger”, or “what is a context zone”.
            </p>
          </Section>

          <Section title="SillyTavern">
            <Toggle
              icon={<RefreshCw size={16} />}
              label="Two-way sync"
              hint="Bring in new messages from SillyTavern and send your Lens edits back."
              value={store.stSyncEnabled}
              onChange={store.setStSyncEnabled}
              testId="toggle-st-sync"
            />
            {store.stSyncEnabled && (
              <>
                <button
                  onClick={() => { close(); onOpenSync(); }}
                  data-testid="open-sync"
                  className="flex items-center justify-between p-2 rounded-lg hover:bg-app-text/5 transition-colors text-sm text-accent bg-accent/10"
                >
                  <div className="flex items-center gap-2">
                    <RefreshCw size={16} />
                    <div className="text-left">
                      <span className="block">Sync with SillyTavern</span>
                      <span className="block text-[10px] opacity-70 font-normal">
                        Bring in new messages · send your Lens edits back · nothing moves without your say-so
                      </span>
                    </div>
                  </div>
                  <span>&rarr;</span>
                </button>
                <p className="text-[11px] text-muted leading-snug px-1">
                  Install the <b>Aeia Bridge</b> extension in SillyTavern to sync without files.
                  Without it, the same panel still works from a saved <code>.jsonl</code>.
                </p>
              </>
            )}

            {/*
              * Outside the sync gate on purpose.
              *
              * Standing in as the model endpoint is a different feature with a
              * different lifetime — it runs for a whole writing session, where
              * the sync is opened and closed. Hiding it behind the sync switch
              * would tie the two together in the reader's head as well as in
              * the settings.
              */}
            <button
              onClick={() => { close(); onOpenProxy(); }}
              data-testid="open-proxy"
              className="flex items-center justify-between p-2 rounded-lg hover:bg-app-text/5 transition-colors text-sm"
            >
              <div className="flex items-center gap-2">
                <Server size={16} />
                <div className="text-left">
                  <span className="block">Aeia as your SillyTavern endpoint</span>
                  <span className="block text-[10px] opacity-70 font-normal">
                    Experimental · desktop only · process every prompt and reply on the way through
                  </span>
                </div>
              </div>
              <span>&rarr;</span>
            </button>
          </Section>

          <Section title="Dialogue Styling">
            <SelectRow
              label="Style"
              value={store.dialogueStyle}
              onChange={(v) => store.setDialogueStyle(v as any)}
              options={[
                { value: 'normal', label: 'Normal' },
                { value: 'italic', label: 'Italic' },
                { value: 'bold', label: 'Bold' },
                { value: 'bold-italic', label: 'Bold Italic' },
              ]}
            />
            <SelectRow
              label="Animation"
              value={store.dialogueAnimation}
              onChange={(v) => store.setDialogueAnimation(v as any)}
              options={[
                { value: 'none', label: 'None' },
                { value: 'zoom', label: 'Zoom' },
                { value: 'pulse', label: 'Pulse' },
                { value: 'wave', label: 'Wave' },
                { value: 'glow', label: 'Glow' },
                { value: 'rise', label: 'Rise' },
              ]}
            />
            <SelectRow
              label="Color"
              value={store.dialogueColor}
              onChange={store.setDialogueColor}
              options={[
                { value: 'text-indigo-600 dark:text-indigo-300', label: 'Indigo' },
                { value: 'text-rose-600 dark:text-rose-300', label: 'Rose' },
                { value: 'text-emerald-600 dark:text-emerald-300', label: 'Emerald' },
                { value: 'text-amber-600 dark:text-amber-300', label: 'Amber' },
                { value: 'text-sky-600 dark:text-sky-300', label: 'Sky' },
                { value: '', label: 'Match Theme' },
              ]}
            />
            <p className="px-1 text-[11px] opacity-60">
              Double-quoted speech. The other marks in the prose have their own
              settings below.
            </p>
          </Section>

          <Section title="Other Markup">
            <p className="px-1 -mt-1 text-[11px] opacity-60">
              What the rest of the AI’s punctuation means. Each ships with a
              default and is on already — change one only if you want to.
            </p>
            {MARKUP_CHANNELS.map(ch => (
              <ChannelRow
                key={ch.id}
                channel={ch}
                preset={markupPresets[ch.id]}
                onChange={(patch) => store.setMarkupPreset(ch.id, patch)}
              />
            ))}
            {!isDefaultMarkup(markupPresets) && (
              <button
                onClick={store.resetMarkupPresets}
                data-testid="markup-reset"
                className="self-start px-2 py-1 text-[11px] rounded-md hover:bg-app-text/5 opacity-70"
              >
                Reset to defaults
              </button>
            )}
          </Section>

          <CharacterColorSection />

          {/* Not gated on an open story, and above Export. Both on purpose.
            *
            * Every section below that is wrapped in `store.currentStory &&`
            * disappears when no story is open — which is exactly the state a
            * reader is in when their library has just come up empty and they
            * are looking for the backup. The one control that could save them
            * must not be one of the things that vanishes.
            *
            * Above Export because that is what they would otherwise mistake
            * for a backup. Those write one story, as prose, for reading
            * elsewhere: they restore nothing, and they carry none of the
            * notes, pins or Lens edits attached to it. */}
          <Section title="Your library">
            <button
              onClick={() => { close(); onOpenBackup(); }}
              data-testid="open-backup"
              className="flex items-center justify-between p-2 rounded-lg hover:bg-app-text/5 transition-colors text-sm text-accent bg-accent/10"
            >
              <div className="flex items-center gap-2">
                <Database size={16} />
                <div className="text-left">
                  <span className="block">Back up &amp; restore</span>
                  <span className="block text-[10px] opacity-70 font-normal">
                    Every story with its notes, pins and edits · one file · restore it anywhere
                  </span>
                </div>
              </div>
              <span>&rarr;</span>
            </button>
            <p className="text-[11px] text-muted leading-snug px-1">
              Everything lives in this browser, and browsers can clear stored data when the
              device runs low on space. This is also where you can ask this one not to.
            </p>
          </Section>

          {store.currentStory && (
            <Section title="Profile Pictures">
              <AvatarUpload
                label={store.currentStory.userName || 'You'}
                value={store.currentStory.userAvatar}
                onPick={(url) => store.setStoryAvatar('user', url)}
              />
              <ExpressionStrip
                character={store.currentStory.userName || 'You'}
                spriteKey={`user:${store.currentStory.userName || 'You'}`}
              />
              <AvatarUpload
                label="Default character picture"
                value={store.currentStory.characterAvatar ?? store.currentStory.avatar}
                onPick={(url) => store.setStoryAvatar('character', url)}
              />
              <ExpressionStrip
                character={
                  store.currentStory.characterName
                    ?? store.currentStory.messages.find(m => m.role !== 'user')?.name
                    ?? 'Story'
                }
              />
              {(() => {
                const names = Array.from(new Set(
                  store.currentStory.messages
                    .filter(m => m.role !== 'user')
                    .map(m => m.name),
                ));
                if (names.length <= 1) return null;
                const fallback = store.currentStory.characterAvatar ?? store.currentStory.avatar;
                return (
                  <>
                    <div className="h-px bg-app-border/60 my-1" />
                    <span className="text-[11px] text-muted">Per-character overrides</span>
                    {names.map(name => (
                      <React.Fragment key={name}>
                        <AvatarUpload
                          label={name}
                          value={store.currentStory!.characterAvatars?.[name] ?? fallback}
                          onPick={(url) => store.setCharacterAvatar(name, url)}
                        />
                        <ExpressionStrip character={name} />
                      </React.Fragment>
                    ))}
                  </>
                );
              })()}
              <span className="text-[11px] text-muted">
                Shown beside messages in Chat &amp; Phone views; saved with this
                story. The small “Stage” slots hold expression images per
                feeling — the Scene Director swaps them live on the Stage
                (click to set or replace, hover for ×, or right-click to clear).
              </span>
            </Section>
          )}

          <BackdropSection />

          {store.theme === 'phone' && (
            <Section title="Phone View">
              <Toggle
                icon={<MessageSquareQuote size={16} />}
                label="Dialogue only (texting feel)"
                value={store.phoneDialogueOnly}
                onChange={store.setPhoneDialogueOnly}
              />
              <span className="text-[11px] text-muted">
                Hides narration and shows each spoken line as its own message bubble.
              </span>
            </Section>
          )}

          {/* Both folded in Plain and Lit, which drive neither. See FoldedSection. */}
          <FoldedSection
            title="Scene images"
            hint="Picture generation for scenes — backend, model and prompt presets."
            startClosed={quietModes}
          >
            <SceneImageSettings />
          </FoldedSection>

          <FoldedSection
            title="Services"
            hint="Where the AI, image, audio and voice backends live, and whether they answer."
            startClosed={quietModes}
          >
            <ServicesSection />
          </FoldedSection>

          <Section title="Saved Configurations">
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Config name…"
                value={configName}
                onChange={(e) => setConfigName(e.target.value)}
                className="flex-1 bg-app-text/5 border border-app-border rounded-md px-2 min-h-10 text-sm outline-none min-w-0"
              />
              <button
                onClick={() => {
                  if (configName.trim()) {
                    store.saveConfig(configName.trim());
                    setConfigName('');
                  }
                }}
                title="Save current settings"
                aria-label="Save current settings"
                className="flex items-center justify-center min-h-10 min-w-11 bg-accent text-white rounded-md hover:opacity-90"
              >
                <Save size={16} />
              </button>
            </div>
            {Object.keys(store.savedConfigs).map(name => (
              <div key={name} className="flex items-center gap-1">
                <button
                  onClick={() => store.loadConfig(name)}
                  className="flex-1 text-left px-2 py-1.5 text-sm hover:bg-app-text/5 rounded truncate"
                >
                  Load: <span className="font-bold">{name}</span>
                </button>
                <button
                  onClick={() => store.deleteConfig(name)}
                  className="p-1.5 text-red-500 hover:bg-red-500/10 rounded"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </Section>

          {store.currentStory && (
            <Section title="Export">
              {/* The way in, above the one-press exports.
                *
                * Those each take the WHOLE story, which is right for a backup
                * and wrong for most reasons anyone wants a file. Smart Export
                * is where you say what goes in it first — and it is listed
                * first because "all of it, as markdown" is the special case,
                * not the general one. */}
              <button
                onClick={() => { close(); onOpenSmartExport(); }}
                data-testid="open-smart-export"
                className="flex items-center justify-between p-2 rounded-lg hover:bg-app-text/5 transition-colors text-sm text-accent bg-accent/10"
              >
                <div className="flex items-center gap-2">
                  <Download size={16} />
                  <div className="text-left">
                    <span className="block">Smart Export</span>
                    <span className="block text-[10px] opacity-70 font-normal">
                      Pick the speakers, the chapters, the asides · title page · tidy first
                    </span>
                  </div>
                </div>
                <span>&rarr;</span>
              </button>
              <button
                onClick={() => {
                  const story = store.currentStory!;
                  downloadText(`${safeFilename(story.title)}.md`, storyToMarkdown(story));
                }}
                className="flex items-center gap-2 p-2 min-h-11 rounded-lg hover:bg-app-text/5 transition-colors text-sm"
              >
                <Download size={16} />
                <span>Export story as Markdown</span>
              </button>
              <ExportAsPageButton />
              <ExportCutButton />
              <AudiobookButton />
              <ExportWithEditsButton story={store.currentStory} />
            </Section>
          )}

          {/*
            * Which build is this?
            *
            * Unanswerable from inside a packaged app until now: three platforms
            * ship from three machines, and working out whether a copy had a
            * given fix in it meant grepping a compressed binary. Clicking it
            * copies the line, so a bug report can carry it.
            */}
          <BuildStamp />

          <div className="text-[11px] text-muted leading-relaxed border-t border-app-border pt-4">
            <p className="font-bold mb-1">Keyboard shortcuts</p>
            <p>Space — play/pause · ←/→ — turn pages · Q/E tap — slower/faster ·
            E hold — 3× boost · Q hold — rewind · In autofocus: W/S zoom, A/D pan,
            hold F + select text — highlight</p>
          </div>
        </div>
      </div>
    </div>
  );
};
