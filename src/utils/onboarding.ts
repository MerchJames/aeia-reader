/**
 * The first-run tour.
 *
 * Aura has grown a lot of surface — ten views, a reading-mode ladder, a Scene
 * Director, a Sandbox, an interview panel — and almost all of it is tastefully
 * hidden by design. That is right for the tenth session and wrong for the
 * first: someone who has just dropped in a chat log has no way to know any of
 * it is there. So the tour exists to say what is on offer once, with concrete
 * examples, and then get out of the way.
 *
 * It is DATA, not markup, for two reasons: the steps can be unit-tested (a step
 * cannot advertise a view that no longer exists), and the component stays a
 * dumb renderer.
 *
 * Ethos, in case this is ever expanded: the tour is skippable at every step,
 * never blocks the library, and never claims an AI feature is required —
 * everything Aura does has a working AI-free path, and the tour says so.
 */

import type { ViewMode } from '../types';

/** A live demonstration rendered inside a step. Showing beats describing. */
export type OnboardingDemo =
  | 'typing'      // words arriving at reading speed
  | 'customize'   // theme + accent + reading mode, applied for real
  | 'kinetic'     // the Director bending the reveal
  | 'autofocus'   // the dimmed page and the magnifier following the words
  | 'sandbox'     // a composed scene, from the real composer
  | 'branches'    // a fork in the story
  | 'audio'       // voices, soundscapes, and where they come from
  | 'connect'     // slot in an endpoint and read a passage with it
  | 'pins'        // a pinned artifact on the dock
  | 'company'     // a companion breaking in on a line as it arrives
  | 'visitor'     // a visitor's brief, with the two lines that matter marked
  | 'export';     // a real exported file, made by the real exporter

export interface OnboardingStep {
  id: string;
  /** Short heading. */
  title: string;
  /** One or two sentences. Any longer and nobody reads it. */
  body: string;
  /** Concrete lines shown in a small demo card — showing beats describing. */
  example?: string[];
  /** Views this step is about; validated against the real ViewMode list. */
  views?: ViewMode[];
  /** Marks a step that describes optional AI features, labelled as such. */
  ai?: boolean;
  /** A live demo to render with the step. */
  demo?: OnboardingDemo;
}

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  {
    id: 'welcome',
    title: 'Your chats, as something you read',
    body:
      'Aeia replays SillyTavern and Kobold logs like a book: the words arrive at '
      + 'reading speed instead of sitting in a wall of text. Everything stays on '
      + 'this device — no account, no server, nothing uploaded.',
    demo: 'typing',
  },
  {
    id: 'customize',
    title: 'Set the look first',
    body:
      'Pick a theme and an accent — these apply straight away, and everything '
      + 'here can be changed later in Settings. There are thirty-odd themes; '
      + 'these are a few to start from.',
    demo: 'customize',
  },
  {
    id: 'import',
    title: 'Bring a story in',
    body:
      'Drop files anywhere on the library, or use Import. Branch exports are '
      + 'detected and attached to the story they came from rather than landing as '
      + 'duplicates.',
    example: [
      'SillyTavern chats — .jsonl',
      'Kobold saves — .json',
      'Character cards — .png (V1/V2/V3)',
      'Plain documents — .txt, .md, .docx',
    ],
  },
  {
    id: 'read',
    title: 'One switch for how much it performs',
    body:
      'Space plays and pauses; Q and E change speed. The reading mode sets how far '
      + 'the app goes: Plain is nothing but the words, and each step adds '
      + 'atmosphere, then motion, then voice.',
    example: [
      'Plain — nothing but the text',
      'Lit — the page takes the scene’s mood',
      'Cinema — motion, weather and emphasis',
      'Performance — and it reads aloud',
    ],
  },
  {
    id: 'kinetic',
    title: 'The words can be performed',
    body:
      'With an endpoint connected, the Scene Director can bend the reveal itself — '
      + 'dragging a line out, rushing a panic, holding a silence before a turn, or '
      + 'cutting speech off dead. A staggered run lights up as it lands, so a '
      + 'deliberate pause never reads as the app hanging. Off by default.',
    ai: true,
    demo: 'kinetic',
  },
  {
    id: 'autofocus',
    title: 'Autofocus, for hands-free reading',
    body:
      'Everything but the passage in hand falls away, and the page follows the '
      + 'text as it arrives. Turn on the magnifier and a light tracks the newest '
      + 'words — the spot your eye is actually on.',
    demo: 'autofocus',
  },
  {
    id: 'views',
    title: 'Thirteen ways to read the same story',
    body:
      'The same log can be a book, a chat, a visual novel, a stage — or a game '
      + 'you sit in front of and press to continue. Three of them show its shape '
      + 'instead: a screenplay, a comic page, a map of the whole thing. Only the '
      + 'ones you pin sit on the bar; the rest live under “…”, so the top of the '
      + 'screen stays yours.',
    views: [
      'storybook', 'chat', 'book', 'script', 'panels', 'atlas', 'stage', 'vn', 'rpg', 'sandbox',
      'overview', 'highlights', 'branches',
    ],
  },
  {
    id: 'sound',
    title: 'And it can be heard',
    body:
      'Passages can be read aloud, with the voice shaped by what the scene is '
      + 'doing. Scenes can carry an ambient bed and one-shot sound, described in '
      + 'plain words rather than picked from a list.',
    demo: 'audio',
  },
  {
    id: 'company',
    title: 'Read it with someone',
    body:
      'A character can sit beside you and react as it lands. The AI picks the '
      + 'moments THEY would break in on first, so it arrives mid-sentence rather '
      + 'than at the end. Off by default; nothing they say joins the story.',
    ai: true,
    demo: 'company',
  },
  {
    id: 'visitors',
    title: 'Bring someone in from another chat',
    body:
      'Invite a character out of any story in your library — or a card with no '
      + 'chat behind it — and they join the cast here, to interview or to read '
      + 'along. Optional, and they arrive as a brief you read before it is used.',
    ai: true,
    demo: 'visitor',
  },
  {
    id: 'sandbox',
    title: 'Or let it design the page',
    body:
      'Sandbox has the model design the PRESENTATION for a beat — never the words, '
      + 'which Aeia injects itself. Optional, like the rest: this preview was '
      + 'composed by Aeia with no model at all, which is also its fallback.',
    ai: true,
    demo: 'sandbox',
  },
  {
    id: 'markup',
    title: 'Mark it up, and keep what matters',
    body:
      'Hold F and select to highlight; attach notes to any passage. Select any span '
      + 'to colour it, underline it, strike it out, or direct how it PERFORMS as it '
      + 'streams. Pin passages, tables and charts to the side dock.',
    demo: 'pins',
  },
  {
    id: 'branches',
    title: 'Every road not taken',
    body:
      'Swipes and alternates are readable as branches — follow a different version '
      + 'and keep reading from there. Separate branch files are stitched back onto '
      + 'their parent story on import.',
    demo: 'branches',
  },
  {
    id: 'ai',
    title: 'AI, entirely optional',
    body:
      'Point Aeia at any OpenAI-compatible endpoint — a local one is fine — and the '
      + 'rest wakes up. Every feature has a working AI-free fallback, and nothing '
      + 'switches itself on.',
    ai: true,
    example: [
      'Scene Director — reads each passage and dresses the page',
      'Ask a character — interview them about the beat you just read',
      'Read with someone — they react as it happens',
      'Scene art — turn a beat into a picture, prompt shown before it fires',
      'Cowrite — rank and fuse alternate beats, summarise, discuss',
    ],
    demo: 'connect',
  },
  {
    id: 'export',
    title: 'And take it with you',
    body:
      'Any story exports as ONE self-contained file — the theme, the fonts, the '
      + 'pictures and the reveal all baked in. It opens in any browser with no '
      + 'server and nothing installed, and it never fetches anything.',
    example: [
      'HTML — reads like the app, offline, on anything',
      'Markdown or plain text — for somewhere else entirely',
      'An audiobook, if you have a voice set up',
    ],
    demo: 'export',
  },
  {
    id: 'done',
    title: 'That’s the tour',
    body:
      'Defaults are deliberately quiet — turn things on as you want them, in '
      + 'Settings. You can reopen this any time from the button in the library.',
  },
] as const;

/** Steps that describe optional AI features, for labelling in the UI. */
export const isAiStep = (step: OnboardingStep): boolean => step.ai === true;
