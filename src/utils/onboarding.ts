/**
 * The first-run tour.
 *
 * Aura has grown a lot of surface — nine views, a reading-mode ladder, a Scene
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
  | 'pins';       // a pinned artifact on the dock

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
      'Aura replays SillyTavern and Kobold logs like a book: the words arrive at '
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
      + 'cutting speech off dead. Off by default.',
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
    title: 'Nine ways to read the same story',
    body:
      'The same log can be a book, a chat, a visual novel, or a stage. Only the '
      + 'ones you pin sit on the bar — the rest live under “…”, so the top of the '
      + 'screen stays yours.',
    views: ['storybook', 'chat', 'book', 'stage', 'vn', 'sandbox', 'overview', 'highlights', 'branches'],
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
    id: 'sandbox',
    title: 'Or let it design the page',
    body:
      'Sandbox has the model design the PRESENTATION for a beat — never the words, '
      + 'which Aura injects itself. Optional, like the rest: this preview was '
      + 'composed by Aura with no model at all, which is also its fallback.',
    ai: true,
    demo: 'sandbox',
  },
  {
    id: 'markup',
    title: 'Mark it up, and keep what matters',
    body:
      'Hold F and select to highlight; attach notes to any passage. Pin a passage, '
      + 'a table or an AI-made chart to the side dock, and keep trackers as '
      + 'editable sheets.',
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
      'Point Aura at any OpenAI-compatible endpoint — a local one is fine — and the '
      + 'rest wakes up. Every feature has a working AI-free fallback, and nothing '
      + 'switches itself on.',
    ai: true,
    example: [
      'Scene Director — reads each passage and dresses the page',
      'Ask a character — interview them about the beat you just read',
      'Cowrite — rank and fuse alternate beats, summarise, discuss',
    ],
    demo: 'connect',
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
