/**
 * Guided tours — the app showing you itself, one thing at a time.
 *
 * ── How this differs from the two things next to it ────────────────────────
 *
 * `onboarding.ts` is the first-run tour: one pass, before there is a story, to
 * say what is on offer. `guideDocs.ts` is the manual: answers to questions,
 * looked up when asked. Neither of them can show you where a thing IS.
 *
 * This is the third: a tour per feature, running over the live app, that
 * switches to the view, opens the panel, puts a hole in the dimmed screen
 * around the actual control, and says what it does. A reader who has been shown
 * the pin dock once does not need to be told where it is again.
 *
 * ── Why the anchors are data ───────────────────────────────────────────────
 *
 * Every stop names a `target` — a `[data-tour="…"]` selector on a real element.
 * That is a promise this file makes about markup it does not own, and the
 * promise rots the moment somebody renames an attribute. It cannot be checked
 * here (there is no DOM in a unit test), so two things carry it instead:
 * `scripts/` greps the components for every anchor this file names, and the
 * overlay degrades to a plain centred card when a target is missing rather than
 * pointing at the corner of the screen.
 *
 * What CAN be checked here is checked: every `view` is a real ViewMode, every
 * `panel` is one the guide is allowed to open, every `doc` is a real entry in
 * the manual. Those are the tripwires in the test.
 *
 * ── The rule about what a stop says ────────────────────────────────────────
 *
 * Small to medium. A stop that runs long is a stop nobody reads, and the manual
 * is one click away on every one of them — `doc` is there so "tell me more"
 * lands somewhere real instead of expanding the card.
 *
 * Pure: no store, no React, no DOM.
 */

import type { ViewMode } from '../types';
import type { GuidePanel } from './guideDocs';

export interface TourStop {
  id: string;
  title: string;
  /** Two to four sentences. Anything longer does not get read. */
  body: string;
  /**
   * The element to spotlight, as a `data-tour` value. Absent means a stop that
   * is about the view as a whole rather than a control in it.
   */
  target?: string;
  /** Switch here first. */
  view?: ViewMode;
  /** Open this first. */
  panel?: GuidePanel;
  /** Concrete lines, shown in a small card. Showing beats describing. */
  example?: string[];
  /** The manual entry behind this stop, for "tell me more". */
  doc?: string;
  /** This stop is about an optional AI feature, and is labelled as such. */
  ai?: boolean;
}

export interface Tour {
  id: string;
  /** Shown in the picker. */
  title: string;
  /** One line: what this tour is for. */
  blurb: string;
  /** Needs a story open. Most do; the library tour does not. */
  needsStory: boolean;
  /** The whole tour is about AI features. */
  ai?: boolean;
  stops: readonly TourStop[];
}

/* ------------------------------------------------------------------ */
/* The tours                                                           */
/* ------------------------------------------------------------------ */

/**
 * ── How these are segmented ────────────────────────────────────────────────
 *
 * By what the reader came to do, not by where the code lives. Somebody asking
 * "how do I make this look right" does not care that themes, character colours,
 * dialogue styling and saved configurations are four different settings
 * sections written by four different weeks — they want the appearance tour.
 *
 * The examples are the load-bearing part. A stop that says "pins hold facts the
 * story keeps forgetting" is a definition; three real pins from a real chat are
 * a picture of what a well-used library looks like, and that is what somebody
 * needs before they will build one themselves. Every stop that can carry
 * examples carries them.
 */
export const TOURS: readonly Tour[] = [
  /* ── Getting stories in ─────────────────────────────────────────────── */
  {
    id: 'library',
    title: 'The library',
    blurb: 'Getting stories in, and finding them again.',
    needsStory: false,
    stops: [
      {
        id: 'library-import',
        title: 'Everything starts with a file',
        body:
          'Drop files anywhere on this screen, or use Import. Branch exports are '
          + 'recognised and attached to the story they came from rather than landing '
          + 'as duplicates. Nothing leaves this device — the file is read in your '
          + 'browser and stays here.',
        target: 'library-import',
        example: [
          'SillyTavern chats — .jsonl, including group exports',
          'Kobold saves — .json',
          'Character cards — .png (V1/V2/V3), lorebook and all',
          'Plain documents — .txt, .md, .docx',
          'A Cut somebody sent you — .cut.json',
        ],
        doc: 'import',
      },
      {
        id: 'library-rename',
        title: 'Names can be fixed',
        body:
          'A chat imported without a card is often called “unused”, because that is '
          + 'what the file says. Double-click any name here to change it, and press '
          + 'Enter. Tags go on the same card.',
        target: 'library-card',
        example: [
          'unused → The Cawley Road',
          'Tags: slow burn · unfinished · reread',
        ],
        doc: 'rename',
      },
      {
        id: 'library-folders',
        title: 'Folders, once there are enough to need them',
        body:
          'The rail filters the shelf. A story sits in one folder at a time, set from '
          + 'the card itself, and folders never travel in an export — how you file '
          + 'your own library is nobody else’s business.',
        target: 'folder-rail',
        example: [
          'Long runs · One-shots · Abandoned',
          'By character — Mara · Vela · the courier',
          'To reread · Reference · Drafts',
        ],
        doc: 'folders',
      },
      {
        id: 'library-search',
        title: 'Search reads the words, not just the titles',
        body:
          'Typing here matches titles and tags at once. Deep search goes inside the '
          + 'stories themselves, so a half-remembered line is enough to find the chat '
          + 'it was in — and it tells you which passage.',
        target: 'library-search',
        example: [
          '“one boot, river-black” → the passage, in three chats',
          '“cawley” → every story that mentions the bridge',
          'tag:unfinished → what you left half-done',
        ],
      },
      {
        id: 'library-settings',
        title: 'And what the shelf shows',
        body:
          'Sort order, what a card puts on its face, how much of the story it '
          + 'previews. Worth a minute once you are past a dozen stories and the shelf '
          + 'stops being a list you can read at a glance.',
        panel: 'settings',
        target: 'settings-library',
        example: [
          'Newest first, or by how far through you are',
          'Cards that show the character, the tags, and a line of the story',
          'A shelf you can read at a glance past fifty stories',
        ],
      },
    ],
  },

  /* ── Reading ────────────────────────────────────────────────────────── */
  {
    id: 'reading',
    title: 'Reading',
    blurb: 'Playback, speed, and the four reading modes.',
    needsStory: true,
    stops: [
      {
        id: 'reading-play',
        title: 'It reads at reading speed',
        body:
          'Space plays and pauses. Q and E change the speed. This is the whole point '
          + 'of the app: the words arrive as prose rather than sitting in a wall of '
          + 'text you have already skimmed the end of.',
        target: 'playback',
        example: [
          'Space — play or pause',
          'Q / E — slower, faster',
          '← / → — back a passage, on a passage',
        ],
        doc: 'playback',
      },
      {
        id: 'reading-modes',
        title: 'One switch for how much it performs',
        body:
          'The reading mode is a ladder and every rung is optional. Plain is nothing '
          + 'but the words. Each step above adds atmosphere, then motion, then voice. '
          + 'Nothing above Plain is required for any of the rest of the app.',
        panel: 'settings',
        target: 'reading-mode',
        example: [
          'Plain — the text, and nothing else',
          'Lit — the page takes the scene’s mood and light',
          'Cinema — motion, weather, emphasis, held silences',
          'Performance — and it reads aloud in cast voices',
        ],
        doc: 'reading-modes',
      },
      {
        id: 'reading-layout',
        title: 'Continuous or a passage at a time',
        body:
          'Continuous keeps everything read so far on the page and scrolls. Paginated '
          + 'shows one passage and turns. Autofocus dims everything but the line being '
          + 'read, with a magnifier that follows the words.',
        panel: 'settings',
        target: 'settings-reading',
        example: [
          'Continuous — for a long sitting, like a scroll',
          'Paginated — one beat at a time, like a book',
          'Autofocus — the rest of the page goes quiet',
        ],
        doc: 'autofocus',
      },
      {
        id: 'reading-autoreader',
        title: 'It can keep going without you',
        body:
          'The autoreader moves on by itself at the end of a passage, with a pause you '
          + 'set. Handy when the story is playing while you do something else, and it '
          + 'stops the moment you touch anything.',
        panel: 'settings',
        target: 'settings-autoreader',
        example: [
          'Two seconds between passages, for a read-along',
          'Longer, if you are following in another window',
          'Stops dead the moment you touch anything',
        ],
      },
      {
        id: 'reading-reveal',
        title: 'How the words arrive',
        body:
          'The reveal is how text lands on the page. Typing is the familiar one; the '
          + 'others suit different reading. This is separate from speed, so you can '
          + 'have a fast typewriter or a slow fade.',
        panel: 'settings',
        target: 'settings-reveal',
        example: [
          'Typing — a character at a time',
          'Smooth — words easing in as a line',
          'Magic — a shimmer that resolves into text',
          'Fade — whole paragraphs, quietly',
        ],
      },
      {
        id: 'reading-hidden',
        title: 'The parts of the file that are not the story',
        body:
          'SillyTavern narrator notes and anything you had hidden come in marked '
          + 'rather than dropped. They are skipped for playback and shown only when '
          + 'you ask — so nothing is lost, and nothing reads aloud that should not.',
        panel: 'settings',
        target: 'settings-chatfile',
        example: [
          '[System: the user has left the chat] — kept, never read aloud',
          'A /hide-den aside — there when you want it, gone when you do not',
          'Chain of thought — lifted out into its own section',
        ],
        doc: 'hidden-messages',
      },
    ],
  },

  /* ── The views ──────────────────────────────────────────────────────── */
  {
    id: 'views',
    title: 'Ways to look at it',
    blurb: 'Fourteen presentations of the same messages.',
    needsStory: true,
    stops: [
      {
        id: 'views-bar',
        title: 'The same story, arranged differently',
        body:
          'A view is furniture, not a conversion: nothing is rewritten and nothing is '
          + 'lost when you switch. The bar holds the ones you pin; the rest are one '
          + 'click deeper, which is where they are meant to be found.',
        target: 'view-bar',
        doc: 'views',
        example: [
          'Pin the four you use; the other ten stay one click away',
          'Switching mid-story keeps your place exactly',
          'Nothing is converted — it is the same messages, differently furnished',
        ],
      },
      {
        id: 'views-book',
        title: 'For reading like a book',
        body:
          'Storybook is continuous prose with the chat furniture gone. Book is a '
          + 'two-page spread with real page turns. Both are for the case where you '
          + 'want to forget it was ever a chat log.',
        view: 'book',
        example: [
          'Storybook — one column, no names, no bubbles',
          'Book — two pages, a spine, and a turn',
        ],
      },
      {
        id: 'views-shape',
        title: 'Three that show the shape instead of the words',
        body:
          'Script lays it out as a screenplay and tells you how long it would run. '
          + 'Panels makes a comic page, one beat per panel, laid out by what the beat '
          + 'is. Atlas is the whole story as a map you can zoom into.',
        view: 'atlas',
        example: [
          'Script — INT. THE MILL — NIGHT, and a running time',
          'Panels — a wide establishing beat, then two tight ones of dialogue',
          'Atlas — four hundred messages as terrain, scenes as landmarks',
        ],
      },
      {
        id: 'views-game',
        title: 'Three that present it like a game',
        body:
          'Stage gives you portraits and a dialogue window. Visual Novel adds '
          + 'backdrops, sprites and a camera. RPG is the whole interface — HUD, party, '
          + 'command row, press to continue.',
        view: 'vn',
        example: [
          'Stage — portrait, name plate, one line at a time',
          'Visual Novel — a backdrop that changes with the scene',
          'RPG — health, party, inventory, and a text box',
        ],
      },
      {
        id: 'views-preset',
        title: 'And a preset for which of them you see',
        body:
          'Read, Cowrite and Scenes each hide the views that get in their way — a '
          + 'two-page spread is a lovely way to read and a terrible way to revise. '
          + 'Everything hides nothing, and is the way back if something is missing.',
        target: 'ui-mode',
        example: [
          'Read — the ways of reading it',
          'Cowrite — Workspace and Chat, nothing decorative',
          'Scenes — every way of showing it, no lists',
          'Everything — all fourteen',
        ],
        doc: 'ui-modes',
      },
      {
        id: 'views-branches',
        title: 'Branches holds the roads not taken',
        body:
          'Every swipe the model ever produced, and every branch file you imported, kept '
          + 'as alternates rather than thrown away. Follow a different version and keep '
          + 'reading down it; the trunk is never rewritten.',
        view: 'branches',
        target: 'branches-view',
        example: [
          'Four takes on the same reply, side by side',
          'A branch exported from SillyTavern, attached where it forked',
          'Reading down an alternate, then coming back',
        ],
        doc: 'branches',
      },
      {
        id: 'views-overview',
        title: 'Overview is the table of contents',
        body:
          'Every passage in order, starred ones marked, click one to jump there. It is '
          + 'also where alternate versions of a passage are swapped in and out, and '
          + 'where you can reorder the story itself.',
        view: 'overview',
        target: 'overview-list',
        example: [
          'Every passage in order, with the starred ones marked',
          'Drag to reorder the story itself',
          'Original / Blended, switched per passage',
        ],
      },
    ],
  },

  /* ── Marking it up ──────────────────────────────────────────────────── */
  {
    id: 'marking',
    title: 'Marking and notes',
    blurb: 'Highlights, notes, the Codex, and how a line performs.',
    needsStory: true,
    stops: [
      {
        id: 'marking-highlight',
        title: 'Hold F and select',
        body:
          'That is a highlight. Select any span without F and the popover offers more: '
          + 'a colour, an underline, a strike, a note attached to the passage. None of '
          + 'it touches the story’s own text.',
        target: 'message-block',
        example: [
          'Yellow — say this back to me later',
          'Red — this contradicts something',
          'A note — “she has said this before, at the mill”',
        ],
        doc: 'highlights',
      },
      {
        id: 'marking-perform',
        title: 'And how a line should land',
        body:
          'The same popover directs the reveal of a span: hold it, rush it, cut it off '
          + 'dead, put weight on one word. Sound marks fire a noise at an exact word. '
          + 'All stored beside the story, all reversible.',
        example: [
          '“Ask me again in the morning.” — held, two beats before it',
          '“Run —” — cut off dead',
          'A door closing, on the word “shut”',
        ],
        doc: 'marks',
      },
      {
        id: 'marking-highlights-view',
        title: 'Everything you marked, in one place',
        body:
          'The Highlights view collects every mark and note across the whole story, in '
          + 'order, with the passage each came from. It is the view that makes marking '
          + 'worth doing on a four-hundred-message chat.',
        view: 'highlights',
        target: 'highlights-view',
        example: [
          'Every yellow mark, in order, with its passage',
          'Notes to yourself, collected away from the story',
          'A jump back to exactly where each one came from',
        ],
      },
      {
        id: 'marking-codex',
        title: 'The Codex fills itself in',
        body:
          'Everyone and everywhere the story has mentioned, gathered as you read, with '
          + 'a count of how often and a jump to each. A character card’s lorebook is '
          + 'folded in at import. You can lock an entry so a rebuild keeps it.',
        panel: 'codex',
        target: 'codex-button',
        example: [
          'Mara — 214 mentions, first at passage 2',
          'Cawley bridge — 31 mentions, out since the spring flood',
          'the miller’s debt — locked, so a rebuild will not drop it',
        ],
        doc: 'codex',
      },
    ],
  },

  /* ── The Lens ───────────────────────────────────────────────────────── */
  {
    id: 'lens',
    title: 'The Lens',
    blurb: 'Changing how the text reads without touching the file.',
    needsStory: true,
    stops: [
      {
        id: 'lens-what',
        title: 'A layer over the words, never a change to them',
        body:
          'Everything the Lens does is stored beside the story rather than in it. Turn '
          + 'the Lens off and the original is there, exactly as imported. There is no '
          + 'version of this that edits your chat log.',
        target: 'lens-toggle',
        doc: 'lens',
        example: [
          'Lens on — your rewrites, your repairs, your blends',
          'Lens off — the file exactly as it was imported',
          'Every override listed, and undoable one at a time',
        ],
      },
      {
        id: 'lens-edit',
        title: 'Rewrite a passage yourself',
        body:
          'Select text and the popover offers to edit it. What you write is an override '
          + 'on that message — visible with the Lens on, gone with it off, and listed so '
          + 'you can find and undo any of them later.',
        target: 'message-block',
        example: [
          'Fixing a name the model got wrong in one line',
          'Cutting a paragraph that repeats the one before it',
          'Turning “You feel cold” into something you would have written',
        ],
      },
      {
        id: 'lens-blend',
        title: 'Chatter Blend',
        body:
          'Chat has a shape prose does not: you do three things and the character '
          + 'answers all three at once, in order, like a form. Blend rewrites the pair '
          + 'as one woven passage, shows you the diff, and keeps it as an alternate you '
          + 'can switch away from.',
        target: 'blend-button',
        ai: true,
        example: [
          'Before — you: door, satchel, fire, question. Them: all four answers.',
          'After — each answer beside the thing it answers',
          'Kept as “Blended”, with Original one click away',
        ],
        doc: 'blend',
      },
      {
        id: 'lens-format',
        title: 'Rules that repair the markup as it renders',
        body:
          'The Formatting Studio holds force-format rules: unbalanced emphasis, stray '
          + 'tags, dialogue that lost its quotes, stat lines turned into panels. These '
          + 'are live transforms, not stored edits, so switching one off puts it back.',
        panel: 'settings',
        target: 'settings-format',
        example: [
          '[Health] 100 → a stat panel',
          '*she said — an unclosed emphasis, closed',
          '<div> left in by a model — stripped',
        ],
      },
      {
        id: 'lens-text',
        title: 'And the smaller text rules',
        body:
          'Out-of-character asides, inline images, how the chat’s own markup is read. '
          + 'Small switches, but they are the difference between a log that reads as '
          + 'prose and one that reads as a log.',
        panel: 'settings',
        target: 'settings-text',
        example: [
          '(( ooc: brb )) — shown, dimmed, or hidden',
          'Inline images — in place, or collected',
          'Underscores as emphasis — on or off',
        ],
      },
    ],
  },

  /* ── The workspace ──────────────────────────────────────────────────── */
  {
    id: 'workspace',
    title: 'Pins, sets and the workspace',
    blurb: 'Keeping the things the story keeps forgetting.',
    needsStory: true,
    stops: [
      {
        id: 'workspace-view',
        title: 'The text, arranged how you want it',
        body:
          'Workspace is columns you lay out yourself: the story in one, your pins in '
          + 'another, the assistant in a third. Double-click a passage to edit it in '
          + 'place. The layout is saved, so it is there next time.',
        view: 'workspace',
        target: 'workspace-view',
        doc: 'workspace',
        example: [
          'Text · pins · assistant, three columns',
          'Text wide, sets narrow beside it, for a scene you are pinning',
          'Double-click a passage to edit it where it sits',
        ],
      },
      {
        id: 'workspace-pins',
        title: 'A pin is a fact you got tired of repeating',
        body:
          'Anything the story should stop forgetting. Pins sit on the dock, and can be '
          + 'handed to the AI as context — which is the difference between a model that '
          + 'contradicts you and one that does not.',
        target: 'pin-dock',
        example: [
          '“Mara’s left hand was crushed at Cawley — she favours the right.”',
          '“The debt to the miller: forty silver, due at first frost.”',
          '“Nobody in the valley says the word ‘crossing’ out loud.”',
          '“It has been raining for nine days.”',
        ],
        doc: 'pins',
      },
      {
        id: 'workspace-sets',
        title: 'Sets are which pins matter right now',
        body:
          'Twenty pins is more than any model reads carefully. A set is a named handful '
          + '— the ones that matter for this scene — and the active set is what actually '
          + 'gets sent. Switching sets switches what the story remembers.',
        view: 'workspace',
        target: 'pin-sets',
        example: [
          'At the mill — the debt, the miller, the flood',
          'On the road — the weather, the boot, the courier',
          'Everything about Mara — nine pins, for a scene that is hers',
        ],
        doc: 'pins',
      },
      {
        id: 'workspace-sheets',
        title: 'Sheets, when a fact has columns',
        body:
          'An inventory, a party roster, a wound chart, a ledger. Same idea as a pin '
          + 'with a table instead of a sentence, and it goes into context the same way.',
        view: 'workspace',
        target: 'sheets-panel',
        example: [
          'Inventory — item · where · condition',
          'The party — name · carrying · owed to',
          'Injuries — who · what · how old',
        ],
        doc: 'sheets',
      },
      {
        id: 'workspace-zones',
        title: 'Zones are chunks of the story itself',
        body:
          'A saved selection of messages you can hand over as context — the scene where '
          + 'the deal was struck, the argument nobody has forgotten. Cheaper and far more '
          + 'accurate than asking a model to remember it.',
        panel: 'ai',
        target: 'ai-context',
        example: [
          'The night at the mill — 14 passages',
          'Every time the bridge is mentioned — 31 passages',
          'All of my own turns — for writing in my voice',
        ],
        doc: 'zones',
      },
      {
        id: 'workspace-pockets',
        title: 'And a pocket is a zone with a job attached',
        body:
          'A zone plus what you want done with it, saved together and reusable. Tasks '
          + 'are the same idea aimed at one piece of work — a summary due, a thread to '
          + 'pick back up, a contradiction to settle.',
        example: [
          '“All of my own lines, so you can write as me”',
          '“Every scene in the mill, for a summary”',
          'Task — “settle whether the bridge is out or merely closed”',
        ],
        doc: 'pockets',
      },
    ],
  },

  /* ── Connecting a model ─────────────────────────────────────────────── */
  {
    id: 'ai',
    title: 'Connecting a model',
    blurb: 'What the AI features need, and what they never do.',
    needsStory: false,
    ai: true,
    stops: [
      {
        id: 'ai-connect',
        title: 'Your endpoint, your key',
        body:
          'Aeia has no model of its own and no server. Point it at whatever you already '
          + 'run and the key stays on this device. Every AI feature is optional and off '
          + 'until you connect one, and the whole app works without.',
        panel: 'ai',
        target: 'ai-connect',
        example: [
          'LM Studio — http://localhost:1234/v1',
          'Ollama — http://localhost:11434/v1',
          'KoboldCpp — http://localhost:5001/v1',
          'Any OpenAI-compatible API, with your own key',
        ],
        doc: 'ai-connect',
      },
      {
        id: 'ai-test',
        title: 'Test it before trusting it',
        body:
          'Test Connection sends one tiny request and tells you exactly what came back. '
          + 'Most first-time failures are CORS on a local backend, and the error names '
          + 'the flag to set for the server you are actually running.',
        target: 'ai-test',
        example: [
          'Ollama — OLLAMA_ORIGINS=*',
          'LM Studio — enable CORS in the server tab',
          '404 — the base URL is missing its /v1',
        ],
        doc: 'ai-trouble',
      },
      {
        id: 'ai-model',
        title: 'Pick the model here, change it anywhere',
        body:
          'Load models fills the list from your endpoint. The same picker sits beside '
          + 'the samplers, so switching to something small and fast for a checking job '
          + 'is not a trip back to settings.',
        target: 'ai-model',
        example: [
          'A big model for writing',
          'A small fast one for “does this contradict that”',
          'Samplers per feature, with your settings winning',
        ],
      },
      {
        id: 'ai-guide',
        title: 'And it can show you around',
        body:
          'With the Tour Guide on you can describe a feature and be taken to it. It '
          + 'reads the same manual these tours are written from, can change a display '
          + 'setting, and cannot touch your stories, your endpoint or your data.',
        panel: 'settings',
        target: 'settings-guide',
        ai: true,
        example: [
          '“where are my highlights”',
          '“make the text bigger”',
          '“show me how pins work” — starts the tour you are in',
        ],
        doc: 'tours',
      },
    ],
  },

  /* ── The assistants ─────────────────────────────────────────────────── */
  {
    id: 'assistants',
    title: 'Working with the AI',
    blurb: 'Cowriting, asking a character, summaries and guests.',
    needsStory: true,
    ai: true,
    stops: [
      {
        id: 'assistants-cowrite',
        title: 'A conversation about the story',
        body:
          'Chat is a working conversation rather than a rewrite: ask for a continuation, '
          + 'a different angle, a line that lands better. Anything it suggests for the '
          + 'text arrives as a proposal you accept or reject.',
        view: 'chat',
        example: [
          '“What would Mara not say here?”',
          '“Give me three ways this scene could end badly.”',
          '“Tighten this paragraph without losing the boot.”',
        ],
        doc: 'cowrite',
      },
      {
        id: 'assistants-ask',
        title: 'Or a conversation with somebody in it',
        body:
          'Ask Character answers as one of the cast, from what the story actually '
          + 'establishes about them. It is a way of testing whether a character is as '
          + 'consistent as you think they are.',
        example: [
          '“Mara, why did you keep the boot?”',
          '“What do you think the courier wanted?”',
          '“Would you cross the bridge tonight?”',
        ],
        doc: 'ask-character',
      },
      {
        id: 'assistants-summarize',
        title: 'Summaries and a recap for when you come back',
        body:
          'A summary of any stretch, pinned so it counts as context afterwards. When you '
          + 'reopen a story after a while, the Previously card says where you were — once '
          + 'per story, then it gets out of the way.',
        example: [
          'A recap of the last thirty passages',
          'A timeline of everything that happened at the mill',
          'A summary pinned, so the model reads it instead of the whole chat',
        ],
        doc: 'summarize',
      },
      {
        id: 'assistants-visitors',
        title: 'And somebody from one of your other chats',
        body:
          'A visitor is a brief written from another story — who they are, how they '
          + 'speak, what they would notice here. Invite one and the assistant can answer '
          + 'as them. The brief never travels in an export.',
        example: [
          'The courier from a different chat, reading this one',
          '“What would she make of Mara?”',
          'Live reactions — a companion breaking in as a line arrives',
        ],
        doc: 'visitors',
      },
      {
        id: 'assistants-crossings',
        title: 'Or the map between all of them',
        body:
          'Branching draws the connections across your library: a shared character, a '
          + 'place two stories both use, an event one of them remembers. A throughline is '
          + 'the record of the person you play across all of it.',
        panel: 'branching',
        example: [
          'Mara appears in four chats — linked',
          'The Cawley bridge is in two, ten years apart',
          'Throughline — “never draws first, always pays a debt”',
        ],
        doc: 'crossings',
      },
    ],
  },

  /* ── Scenes ─────────────────────────────────────────────────────────── */
  {
    id: 'scenes',
    title: 'Scenes and pictures',
    blurb: 'Art, the Director, the Sandbox, backdrops and sprites.',
    needsStory: true,
    ai: true,
    stops: [
      {
        id: 'scenes-art',
        title: 'Pictures for the passages that want one',
        body:
          'Scene art is generated from the passage itself and kept beside it, not in it. '
          + 'You choose which beats get one; a story with four pictures in the right '
          + 'places reads better than one with forty.',
        example: [
          'The establishing shot of the mill',
          'The boot on the table',
          'A portrait for each of the cast, reused as they recur',
        ],
        doc: 'scene-art',
      },
      {
        id: 'scenes-director',
        title: 'The Director reads the scene and sets the room',
        body:
          'It decides the mood of the page, the weather, which words land hard, where a '
          + 'silence goes — and in Cinema and Performance that read drives the reveal '
          + 'itself. Its read is stored, so it is paid for once.',
        panel: 'settings',
        target: 'settings-director',
        example: [
          'A page that cools and darkens as the scene turns',
          'Rain that starts when the story says it does',
          'A held beat before “Ask me again in the morning.”',
        ],
        doc: 'director',
      },
      {
        id: 'scenes-sandbox',
        title: 'The Sandbox designs each beat as it arrives',
        body:
          'The one view with no fixed layout — a full-bleed image here, a tight column '
          + 'of dialogue there, a stat card when the story turns to numbers. The Studio '
          + 'sets its palette and house rules so it stays your book.',
        view: 'sandbox',
        example: [
          'A wide, quiet page for an establishing beat',
          'Two narrow columns for a fast exchange',
          'A card when the story starts counting silver',
        ],
        doc: 'sandbox',
      },
      {
        id: 'scenes-backdrops',
        title: 'Backdrops, sprites and faces',
        body:
          'Stage and Visual Novel use backdrops and character sprites, and you can bring '
          + 'your own. Profile pictures replace the generated avatars anywhere a '
          + 'character appears.',
        panel: 'settings',
        target: 'settings-backdrops',
        example: [
          'A backdrop per location, switched by the scene',
          'Sprites with expressions the Director picks between',
        ],
      },
      {
        id: 'scenes-avatars',
        title: 'And the faces on the messages',
        body:
          'Profile pictures replace the generated avatars wherever a character appears — '
          + 'the reader, the character, and each member of a group chat separately. A '
          + 'card’s own portrait is used automatically if it brought one.',
        panel: 'settings',
        target: 'settings-avatars',
        example: [
          'Your own art for Mara, everywhere she speaks',
          'A different face per speaker in a group chat',
          'The card’s portrait, used without asking',
        ],
      },
    ],
  },

  /* ── Sound ──────────────────────────────────────────────────────────── */
  {
    id: 'audio',
    title: 'Voices and sound',
    blurb: 'Reading aloud, soundscapes, and an audiobook file.',
    needsStory: true,
    stops: [
      {
        id: 'audio-voices',
        title: 'It can read aloud, in cast voices',
        body:
          'Performance mode narrates. Each character can have their own voice, so '
          + 'dialogue is voiced by whoever is speaking rather than one narrator doing all '
          + 'of it. Works with a local engine or your browser’s own.',
        example: [
          'Narration in one voice, dialogue in the speakers’',
          'Dialogue-only, if you would rather read the prose yourself',
          'Speed and pitch per voice',
        ],
        doc: 'tts',
      },
      {
        id: 'audio-soundscape',
        title: 'And put a room behind it',
        body:
          'Soundscapes run under a scene and change with it. They are separate from the '
          + 'voice, so a room tone with no narration is a perfectly ordinary thing to '
          + 'want. The mixer sets how loud each layer sits.',
        example: [
          'Rain on a roof, for nine days of it',
          'A tavern, thinning out as the scene empties',
          'A road at night — wind, and not much else',
        ],
        doc: 'audio',
      },
      {
        id: 'audio-marks',
        title: 'One noise, at one exact word',
        body:
          'A sound mark fires at a word you choose rather than somewhere in the passage. '
          + 'Used sparingly it is the difference between atmosphere and a scene that '
          + 'happens to you.',
        example: [
          'A door, on the word “shut”',
          'A chair, as she finally turns',
          'Something heavy on the table, on “boot”',
        ],
        doc: 'marks',
      },
      {
        id: 'audio-book',
        title: 'Or render the whole thing to a file',
        body:
          'The audiobook renderer reads the story with the voices you have cast and '
          + 'writes one file. It uses the Lens text, so your rewrites are what gets read, '
          + 'and it skips what you have hidden.',
        doc: 'audiobook',
        example: [
          'One file, the whole story, in the cast voices',
          'Your Lens edits are what gets read',
          'Hidden passages left out',
        ],
      },
    ],
  },

  /* ── How it looks ───────────────────────────────────────────────────── */
  {
    id: 'appearance',
    title: 'How it looks',
    blurb: 'Themes, type, character colours and saved looks.',
    needsStory: false,
    stops: [
      {
        id: 'appearance-theme',
        title: 'Theme, accent, type',
        body:
          'Thirty-odd themes, an accent that runs through everything, and the font and '
          + 'size the story is set in. This is the first thing worth spending two '
          + 'minutes on, because it is what you will be looking at.',
        panel: 'settings',
        target: 'settings-appearance',
        example: [
          'A warm paper theme with a serif, for long reading',
          'Something dark and cold, for a story that is',
          'Larger type and more line spacing, for tired eyes',
        ],
        doc: 'appearance',
      },
      {
        id: 'appearance-colors',
        title: 'A colour per speaker',
        body:
          'Each character can have their own, assigned automatically and overridable. In '
          + 'a chat with six speakers it is the difference between following a scene and '
          + 'checking the name on every line.',
        panel: 'settings',
        target: 'settings-colors',
        example: [
          'Mara in amber, the courier in cold blue',
          'Auto-assigned, then overridden where two clash',
          'Six speakers you can follow without reading the names',
        ],
      },
      {
        id: 'appearance-dialogue',
        title: 'And how speech itself is drawn',
        body:
          'Quotes, italics, action lines, out-of-character asides — each can be styled '
          + 'separately. The point is that dialogue should be findable at a glance '
          + 'without reading it.',
        panel: 'settings',
        target: 'settings-dialogue',
        example: [
          'Speech in the speaker’s colour, actions in grey italic',
          'Quote marks kept, or dropped for typographic ones',
          'Asides dimmed rather than hidden',
        ],
      },
      {
        id: 'appearance-markup',
        title: 'And everything else the text does',
        body:
          'Headings, lists, code, tables, block quotes — how much of the markup a model '
          + 'writes should actually be rendered, and how much is better left as the '
          + 'characters it typed.',
        panel: 'settings',
        target: 'settings-markup',
        example: [
          '**bold** rendered, or left visible',
          'Tables drawn, for stories that keep a ledger',
          'Code blocks kept monospaced — or turned off entirely',
        ],
      },
      {
        id: 'appearance-configs',
        title: 'Keep a whole look and come back to it',
        body:
          'A saved configuration holds the lot — theme, type, colours, reading mode, the '
          + 'view bar. Worth having two: the one you read in and the one you work in, '
          + 'because they are rarely the same.',
        panel: 'settings',
        target: 'settings-configs',
        example: [
          '“Reading” — paper theme, serif, Cinema, no side panels',
          '“Working” — dark, Workspace pinned, Plain mode',
          'Switch between them without setting fourteen things again',
        ],
      },
    ],
  },

  /* ── Getting it out ─────────────────────────────────────────────────── */
  {
    id: 'export',
    title: 'Getting it out',
    blurb: 'Files you can hand to someone, or keep.',
    needsStory: true,
    stops: [
      {
        id: 'export-smart',
        title: 'Say what goes in it first',
        body:
          'Smart Export is where you pick the speakers, the chapters and the asides '
          + 'before anything is written — because “all of it, as markdown” is the special '
          + 'case, not the general one.',
        panel: 'settings',
        target: 'export-button',
        example: [
          'One character’s scenes, as a chapter each',
          'The story without the out-of-character asides',
          'A title page, and the hidden passages left out',
        ],
        doc: 'export',
      },
      {
        id: 'export-formats',
        title: 'And what shape it comes out in',
        body:
          'A styled HTML page that keeps your colours and typography, plain markdown for '
          + 'anywhere else, or the original chat format back out again. Your Lens edits '
          + 'are what gets written.',
        panel: 'settings',
        target: 'settings-export',
        example: [
          'HTML — your theme, your fonts, one file',
          'Markdown — for anything that reads it',
          '.jsonl — back into SillyTavern',
        ],
      },
      {
        id: 'export-cut',
        title: 'A Cut is one story, to hand to someone',
        body:
          'The story plus the work you did on it — the Director’s read, your Lens edits, '
          + 'your marks — and deliberately none of what is private: not your folders, '
          + 'your notes, your interviews or your visitors.',
        example: [
          'What travels — the text, the direction, the styling',
          'What never does — annotations, folders, throughlines',
          'The dialog says which before it writes',
        ],
        doc: 'export',
      },
    ],
  },

  /* ── SillyTavern ────────────────────────────────────────────────────── */
  {
    id: 'sync',
    title: 'Two-way SillyTavern sync',
    blurb: 'Reading and rewriting a chat that is still being written.',
    needsStory: false,
    stops: [
      {
        id: 'sync-switch',
        title: 'Turn it on here',
        body:
          'The bridge reads your open SillyTavern chat into Aeia and sends rewrites back. '
          + 'Nothing is written to your chat without a preview showing every change '
          + 'first, and that is not a setting you can turn off.',
        panel: 'settings',
        target: 'settings-sync',
        doc: 'sync',
        example: [
          'New messages from SillyTavern come in',
          'Your Lens rewrites go back out',
          'Every write previewed there before it happens',
        ],
      },
      {
        id: 'sync-panel',
        title: 'One folder, no configuration',
        body:
          'The extension goes in SillyTavern’s extensions folder and needs no CORS '
          + 'change, no server plugin and no restart. The two sides talk through the '
          + 'browser itself. There is a file route as well, if the live one cannot work.',
        panel: 'sync',
        target: 'sync-panel',
        example: [
          'Sync this chat — everything that differs, both ways',
          'Sync my whole library — for filling Aeia the first time',
          'Save for Aeia / Apply merged file — the same thing by hand',
        ],
      },
      {
        id: 'sync-second-pass',
        title: 'The second pass',
        body:
          'Optional. Each new reply is checked against a few of your pins — “does this '
          + 'contradict this one fact” — and a failing sentence may be repaired. The reply '
          + 'is yours the moment it arrives; a revision lands after, as a swipe.',
        ai: true,
        example: [
          'Checking against “Mara favours the right hand” (2/5)',
          'Found: “she reached out with her left” — repaired',
          'Original kept beside it, one arrow away',
        ],
      },
      {
        id: 'sync-presets',
        title: 'And your prompting comes across too',
        body:
          'Import SillyTavern chat completion presets and Aeia reads their prompts, their '
          + 'order and their samplers. Import several and build one out of parts of each — '
          + 'including the prompts an author left switched off.',
        panel: 'settings',
        target: 'settings-presets',
        example: [
          'The system prompt from one, the style rules from another',
          'A jailbreak the author shipped disabled',
          'Samplers borrowed from whichever preset you trust',
        ],
        doc: 'presets',
      },
    ],
  },

  /* ── Data ───────────────────────────────────────────────────────────── */
  {
    id: 'safety',
    title: 'Your data',
    blurb: 'Where it lives, and how to get it out again.',
    needsStory: false,
    stops: [
      {
        id: 'safety-local',
        title: 'All of it is on this device',
        body:
          'No account, no server, nothing uploaded. The only requests that leave are to '
          + 'an AI endpoint you configured yourself, and only when you use an AI feature. '
          + 'That also means nothing is recoverable if the browser clears its storage.',
        doc: 'privacy',
        example: [
          'No account, no sign-in, no server',
          'The only outbound requests are to your own endpoint',
          'Clear the browser’s site data and it is genuinely gone',
        ],
      },
      {
        id: 'safety-backup',
        title: 'Which is why this exists',
        body:
          'One file with every story, pin, sheet, mark and setting in it. Restoring can '
          + 'fill in what is missing or replace what is there, and it tells you which, '
          + 'with counts, before it does anything.',
        panel: 'settings',
        target: 'backup-panel',
        example: [
          'Fill in — add what this file has and you do not',
          'Replace — make it match the file exactly',
          '“14 stories, 212 pins, 1.4 GB” — before, not after',
        ],
        doc: 'backup',
      },
      {
        id: 'safety-storage',
        title: 'And it tells you before it runs out',
        body:
          'Browsers cap how much a site may keep, and a story with generated art in it is '
          + 'not small. Aeia asks the browser to make its storage persistent, watches the '
          + 'headroom, and says so while there is still room to act.',
        example: [
          '“Using 1.4 GB of about 2 GB” — while there is still room',
          'Persistent storage requested, so a tidy-up does not take it',
          'A warning at 80%, and a louder one at 95%',
        ],
      },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Using them                                                          */
/* ------------------------------------------------------------------ */

export const tourById = (id: string): Tour | undefined =>
  TOURS.find(t => t.id === id);

export interface TourContext {
  hasStory: boolean;
  aiReady: boolean;
}

/**
 * The stops that make sense right now.
 *
 * AI stops are dropped rather than shown-and-disabled when there is no
 * endpoint. A tour is a sequence of things to look at, and a step that says
 * "you cannot see this" is a step that wastes the reader's attention on a
 * feature they have already decided not to use.
 */
export const visibleStops = (tour: Tour, ctx: TourContext): TourStop[] =>
  tour.stops.filter(stop => (stop.ai ? ctx.aiReady : true));

/**
 * Tours worth offering.
 *
 * Wanting a story is no longer a reason to withhold one: there is a sample, and
 * `needsSample` says when it should be opened first. A picker that greys out
 * four of its seven entries for the reader who has imported nothing yet is
 * hiding the app from exactly the person it was built for.
 */
export const availableTours = (ctx: TourContext): Tour[] =>
  TOURS.filter(tour => {
    if (tour.ai && !ctx.aiReady) return false;
    return visibleStops(tour, ctx).length > 0;
  });

/**
 * Does this tour need the sample opened before it can run?
 *
 * Separate from `tourBlocker` on purpose. A blocker is something the reader has
 * to go and fix; this is something the app can simply do, and the difference is
 * the difference between an explanation and a dead end.
 */
export const needsSample = (tour: Tour, ctx: TourContext): boolean =>
  tour.needsStory && !ctx.hasStory;

/** Why a tour cannot run now, for the picker to show instead of hiding it. */
export const tourBlocker = (tour: Tour, ctx: TourContext): string | null => {
  // Deliberately NOT "open a story first" — see `needsSample`.
  if (tour.ai && !ctx.aiReady) return 'Connect an endpoint first.';
  if (!visibleStops(tour, ctx).length) return 'Nothing to show yet.';
  return null;
};

/** Step, clamped. Returns null when the tour is over. */
export const stepTo = (stops: readonly TourStop[], at: number, by: 1 | -1): number | null => {
  const next = at + by;
  if (next < 0) return 0;
  if (next >= stops.length) return null;
  return next;
};

/** Every anchor the tours reach for, for the markup check to grep with. */
export const TOUR_ANCHORS: readonly string[] = [
  ...new Set(TOURS.flatMap(t => t.stops.map(s => s.target).filter((x): x is string => !!x))),
];

/** The selector for one anchor. One place, so the attribute name is one string. */
export const anchorSelector = (anchor: string): string => `[data-tour="${anchor}"]`;

/** Progress, for the card's footer. 1-based, because people count from one. */
export const stopLabel = (at: number, total: number): string => `${at + 1} of ${total}`;
