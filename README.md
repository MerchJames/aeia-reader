# Aeia Reader

A local-first reader for **SillyTavern** and **KoboldAI** stories. Import your
chat logs and read them back as something made — the words arrive at reading
speed, the page can take on the mood of the scene, and you can mark it up as you
go. Everything is stored on your device: no account, no server, nothing
uploaded.

AI is **optional everywhere**. Point Aeia at any OpenAI-compatible endpoint
(including a local one) and a few extra things wake up; leave it unset and every
feature still works from a heuristic fallback.

It also works *with* SillyTavern rather than only on its exports: two-way sync,
and — on the desktop build — standing in as SillyTavern's own model endpoint so
every prompt and reply passes through your own material on the way. See
[Live with SillyTavern](#live-with-sillytavern).

---

## What it does

### Read

- **A library that scales.** Search by title, character or tag; sort by last
  read, date added, title or progress; filter by tag and format. Tags are yours
  to edit. A deeper search reads the text inside every story on request.
- **Thirteen views of the same story.** Storybook (prose), Chat (bubbles), Book
  (real two-page spreads with page-flips), Stage (RPG dialogue box with
  portraits), VN (visual-novel staging with sprites, backdrops and camera
  moves), **RPG** (the whole game interface — HUD, party panel, command row,
  and text that waits for you to press on), Sandbox (AI-designed presentation),
  plus Overview, Highlights and Branches. Only the views you pin sit on the bar;
  the rest live under "…".
- **Three of them show the story's SHAPE** rather than its words — the others
  are all timelines, and a long log needs a map as much as it needs a page.
  **Script** lays it out as a screenplay: real sluglines, character cues,
  scene numbering, length in eighths of a page and a running estimate of screen
  time. **Panels** lays it out as comic pages, one beat to a panel, with the
  grid and the gutter chosen by what the passage is — widescreen tiers for
  action, a nine-panel grid for a quiet stretch, a splash for a peak. **Atlas**
  is the whole story at once as a field of scenes, sized by length and coloured
  by mood, with semantic zoom from "the whole thing" down to readable prose.
  All three stream, take the magnifier, and honour Autofocus; Script and Panels
  paginate.
- **Reading modes** — one switch for how much the app performs the text:
  **Plain** (just the words) → **Lit** (the page takes the scene's mood) →
  **Cinema** (motion, weather, emphasis) → **Performance** (and it reads aloud).
  Change anything underneath and the label says so — "Cinema · modified".
- **Streaming playback** — letter- or word-by-word reveal with a WPM readout,
  configurable pause between messages, speed controls, and **TTS** (browser
  voices or a local Kokoro server, with per-character voice casting).
- **Autofocus** — hands-free reading that dims everything but the passage in
  hand, in every view, with an optional **magnifier** that follows the words as
  they arrive. Five looks: a **light**, a frosted **glass** lens, a floating
  **card**, a **ruler** (the reading guide, with everything above and below the
  line covered), and a cinema **iris**.
- **Book pagination**, chapter openings, drop caps, running heads, bookmarks.

### Mark it up

- **Highlights & notes** — hold `F` and select to highlight in five colours;
  attach notes to any passage. Highlights are painted back onto the text and
  collected in their own view.
- **The frame tool** (`B`) — drag a box over the words you want instead of
  dragging a text selection through them. A frame is a spatial gesture rather
  than a linear one, which is what you want on a page that is still streaming.
  What it catches goes to the same card a selection opens: highlight, pin, note,
  ask, perform — or **Rewrite this part**, which opens the Lens on that passage
  with your framed words quoted as the focus.
- **Markup channels** — the AI's punctuation is yours to dress. `"speech"`,
  `'asides'`, `**beats**`, `****shouts****` and `##` headings each get their own
  colour, style and animation. Every one ships on with a sensible default, and
  an apostrophe is never mistaken for a quote. HTML the model writes — `<b>`,
  `<i>`, `<br>`, `<font color=…>` — is folded into those same channels rather
  than shown to you as tags, so the styling is yours rather than the model's.
  Angle brackets that aren't HTML (`<sighs>`, `3 < 5`) are left as written, and
  a fenced code block keeps its tags.
- **Branches / What-Ifs** — SillyTavern swipes and Kobold alternates are
  readable as alternate takes. Multi-file branch exports are detected on import
  and attached to the story they forked from instead of landing as duplicates.
- **Pins & Sheets** — pin a passage, an AI table or a chart to a side dock;
  keep trackers as editable tables.
- **Codex** — people, places and things are extracted as you read, with hover
  tooltips on their mentions.
- **Lens** — a per-message override layer for rewrites and formatting. The
  source JSON is never touched; exporting with your edits is an explicit choice.

### Make it yours

- **40+ themes**, from Light/Dark/Sepia to Terminal (CRT), Windows 98, Aero
  Glass, Synthwave, Grimoire, Cyberpunk, E-Ink, Game Boy, RPG Quest, Pixel Chat
  and MGS-style Codec — each with fitting fonts and optional ambient effects.
  Four of them are a *material* rather than a palette: **Risograph** (spot inks
  on toothy paper, printed a hair out of register), **Foil** (iridescence that
  travels across the type instead of sitting on it), **Vector** (a phosphor
  tube drawing strokes — glow off the letterforms, no scanlines, and a very
  slight swim), and **Calligraphy**, which brings its own per-word reveal: each
  word is *written* left to right by a wet nib that dries into the prose, on
  laid paper, in two hands — one for the text and an engraved script for the
  names.
- **Per-word reveals** — fade, blur, ink, glitch, rise, quill, **typewriter**
  (a hard strike and a settle, no fade — it is the Script view's own) and
  **ember**, the one that colours rather than moves: each word lands in the
  accent and cools into the prose, so the streaming tail reads as heat over
  settled text and nothing is ever hidden waiting to arrive. A view or a theme
  with a signature reveal uses it unless you turn theme effects off.
- **Custom fonts** (upload your own), accent colours, font size, content width,
  paragraph spacing, dialogue styling and `[OOC: …]` handling.
- **Auto-formatter** — regex find/replace with per-role targeting, live preview,
  import/export and one-click presets (strip `<think>` blocks, OOC comments,
  HTML, anti-slop cleanup).
- **Stage assets** — per-chat character sprites (six expressions), backdrops by
  keyword, and profile pictures.
- **Workspace view** — the one view that is about working on the text rather
  than reading it. The column moves: left, right or centred, wider or narrower,
  looser or tighter, pushed into a corner or held off the edge, with four whole
  arrangements a click away. Double-click any passage to edit it in place — the
  edit is saved to the Lens, never over your imported text. Beside it is a rail
  you shuffle with `[` and `]`: pins, pin sets, sheets, and the alternate takes
  on the passage you are on.
- **Branching** — several chats side by side, and a line you drag from a moment
  in one to a moment in another. Say what the link is — bring them in, the same
  beat twice, these disagree, same world, an echo — and the assistant discusses
  *that*, with both stories named and kept apart so it never quietly blends them
  into one continuity. Nothing is copied between stories and neither is
  modified; a link is an observation held outside both, and it is never included
  in a Cut.
- **Workspaces** — a chip at the top of the reader narrows the whole app to one
  kind of work. **Read** keeps every way of reading and drops the writing tools;
  **Cowrite** keeps the assistant, the lists and the text, and stands the
  presentation views down; **Scenes** is every way of *showing* the story with
  none of the lists about it; **All** hides nothing and is always one click
  away. It starts collapsed to a single chip, because four unexplained words
  across the top of a first run are four decisions before any of them can mean
  anything. Your pinned views are filtered, never rewritten — switching back to
  All brings every one of them straight back.
- **A panel you can put somewhere** — the assistant undocks: drag it by the
  header, resize it from any edge, or take one of four shapes (corner, side
  column, bottom strip, centred). It cannot be dragged somewhere you can't grab
  it back from, and a position saved on a big monitor is repaired rather than
  lost when you open the app on a laptop.
- Everything honours `prefers-reduced-motion` and a global effects kill-switch.

### With an AI endpoint (all optional)

- **Scene Director** — a cheap cached read of each passage's mood, tension,
  location and weather, which drives adaptive theming, soundscapes, emotional
  TTS, VN camera work and screen effects. Decoded greedily, so re-reading a page
  gives the same performance twice.
- **Scene performance** — the Director can bend the reveal itself: drag a line
  out, rush a panic, beat between words, hold a silence, cut speech off dead.
- **Sandbox** — the model designs the *presentation* for a beat (never the
  words) as sanitised CSS in a locked-down iframe. A resolved **Style Packet**
  keeps every shot of a story in one look, a critic scores each result, and a
  composed floor takes over when the model cannot hit the brief.
- **Ask a character** — interview anyone in the cast about the beat you just
  read. Their knowledge is hard-clamped to what has actually happened by that
  point, so they cannot spoil what you have not reached. In group chats the
  subject follows whoever is on screen, and characters can see and react to what
  the others said. Nothing said in an interview is canon.
- **Assistant, Cowrite, The long read** — scoped Q&A over the story, alternate-beat
  ranking and fusion, and a reader that walks a story no context could hold and
  builds one designed document from it: a running account, a timeline, a cast
  chart, or a priming brief for continuing it elsewhere. Each stretch hands the
  next a small digest, so section nine knows who section two introduced. Lands
  as a versioned pin.
- **Bring your own form** — paste or drop a JSON, XML, markdown or hand-written
  template and the long read fills *that* in instead. Your literal form is
  restated to the model on every pass, so a twenty-pass document comes back in
  the shape you supplied rather than twenty variations on it. Saved as a
  **Task**, it re-runs over the context zones you choose, in the order you
  choose, and lands as the next version of one pin.
- **Lens edits, proposed not applied** — the assistant can suggest a rewrite of
  any passage. It cannot perform one. A suggestion arrives as a diff against
  what is on the page — added words highlighted, removed words struck through —
  and becomes real only when you accept it. The tool the model calls has no
  route to the story at all; approval is the only path there is. Your imported
  text is never overwritten either way, so turning the Lens off brings the
  original straight back.
- **Tell it which tool to use** — pick *Lens edit* or *New pin* from the
  composer and the assistant is told, for that one message, exactly what you are
  asking for. Small local models otherwise answer with advice about rewriting
  instead of rewriting. The choice is spent when the message sends, so the next
  question is an ordinary question again.
- **Narrative Refinery** — extract and restyle prose with a fidelity check.
- **Bring in a visitor** — a character from another chat, brought over as a
  short brief you read and correct before it is ever sent. They can be
  interviewed, or **take a turn** in this story — always as a draft in the chat,
  never written into it.
- **Throughlines** — a chat is one character and you, so every story you keep
  revolves around somebody different, and the one person in all of them has no
  record anywhere. A throughline is that record: who you are, and your chats in
  the order you lived them. Each one carries a short written brief of what
  happened to *you* there, and a story is only ever told about the ones before
  it — so arc four knows arcs one to three and nothing about arc five. What
  travels is the brief, never the transcript, and you read and edit every word
  of it before it is sent. When two stories disagree about a fact, you settle
  it; nothing merges behind your back.
- **It learns your taste** — the spans you direct by hand (and the ones you
  clear) become examples in the Director's prompt, so it starts choosing the way
  you do. You can read the exact block it sends, and forget it.

### Live with SillyTavern

Aeia can sit beside SillyTavern, or in the middle of it. Everything here is
optional and off until you turn it on.

- **Two-way sync** — bring in new messages and edits from a chat, and send your
  Lens rewrites back. Nothing moves in either direction until you have seen what
  would move: conflicts are shown with both versions side by side and resolved
  one at a time, and a backup is offered before anything is written. Works from
  a saved `.jsonl` on its own, or live through the **Aeia Bridge** extension.
- **Sync your whole library** — every chat of every character in one pass. It
  reads them from SillyTavern's server rather than opening each one, so your
  open chat is never disturbed.
- **Aeia as your model endpoint** *(desktop only, experimental)* — point
  SillyTavern's Custom endpoint at Aeia and it stands between you and the model.
  It sees the prompt SillyTavern actually assembled — card, world info, persona,
  the whole context stack — works on it, calls your real backend, works on the
  reply, and hands back **both versions**, which SillyTavern shows as two swipes.

  *Before the model:* weave in the pins, sheets, codex entries, highlights and
  zones you picked, where you chose to put them; drop context lines you do not
  want; keep your own turn last.

  *After the model:* an ordered pipeline you build — tidy the shape, force
  format with your own rules, check the reply against your material, polish the
  punctuation. Each step says what it costs, and the two that call a model are
  off by default.

- **Shape the prompt in a browser** — a browser tab cannot be an endpoint
  (SillyTavern's *server* makes that call), so the extension does the same
  request-side work through the bridge instead. Same pipeline, same settings.

The extension lives in `st-extension/`. Install it by running `install.ps1`
(Windows) or `install.sh` (Linux/macOS) from that folder — each finds
SillyTavern, copies one directory into `data/<user>/extensions/`, and prints
every path before using it. It never writes to your chat without showing you
every change first.

### Share it

- **Export as a readable page** — one self-contained `.html` file with the
  theme, dialogue styling, chapter structure, your highlights and the Director's
  per-scene mood baked in. It loads nothing from the network, so handing someone
  your story tells nobody they opened it.
- **Export as a Cut** — one `.cut.json` file carrying the story *and* the way
  you directed it: the Director's read, your Lens edits, your hand-marked spans,
  the staging. Anyone else with Aeia opens it and gets the whole performance with
  **no endpoint, no key and no hardware** — the expensive part is already baked.
  A Cut carries the direction, not the diary: your highlights, margin notes,
  interviews, companion reactions and borrowed visitors stay on your machine, and
  the export tells you exactly what is in the file before it writes it.
- **Render an audiobook** — the whole story as one MP3 with a CUE sheet marking
  each chapter, read in your cast's voices. Needs a local **Kokoro** server: the
  browser's own speech engine plays straight to the speakers and cannot be
  recorded.

### Formats

SillyTavern chats (`.jsonl`, including hidden/narrator lines) · KoboldAI and
KoboldCpp saves (`.json`) · TavernAI character cards (`.png`, V1/V2/V3) ·
documents (`.txt`, `.md`, `.docx`) · Cuts (`.cut.json`) from another copy of
Aeia. Export back to Markdown.

---

## Getting started

```bash
npm install
npm run dev
```

Open the URL shown in the terminal (usually `http://localhost:3000`), then drop
a `.jsonl` onto the library. A short tour runs the first time; you can reopen it
any time from **Tour** in the library header.

### Connecting an AI endpoint (optional)

Settings → AI. Paste any OpenAI-compatible base URL — Aeia probes for the right
prefix, so `http://localhost:5001` and `http://localhost:5001/v1` both work.
Tested against OpenAI, OpenRouter, LM Studio, Ollama, llama.cpp and KoboldCpp.

> Running Aeia in WSL against a server on Windows? `localhost` will not reach
> it — use the default gateway from `ip route show default`.

---

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` | Play / pause — or *go on*, while a passage waits for you (RPG mode) |
| `←` / `→` | Turn pages (paginated layout) |
| `Q` / `E` tap | Slower / faster |
| `E` hold | 3× speed while held |
| `Q` hold | Rewind while held |
| `W` / `S`, `A` / `D` | Zoom / pan (autofocus) |
| `F` hold + select | Highlight the selection |
| `B` | Frame tool — drag a box over words, then pin / note / ask / rewrite |
| `Ctrl`/`Cmd` + `F` | Focus search |
| `C` / `M` / `S` | Codex / Multiverse / Sheets |
| `Esc` | Close a panel, exit autofocus, put the frame tool away |

---

## Building

**Web (static site):**

```bash
npm run build          # → dist/, serve with any static file server
```

**Desktop app:** Aeia ships as a native app via Tauri 2.

```bash
npm run app:build      # → src-tauri/target/release/bundle/
```

Tauri does **not** cross-compile — it links the platform's own webview, so each
build has to run on the platform it is for. Windows produces `.msi` and
`.exe`; Linux produces `.deb`, `.rpm` and `.AppImage`; macOS produces `.dmg`.

*Linux prerequisites* (Debian/Ubuntu; `4.1`, not `4.0` — that is Tauri 1):

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
  pkg-config patchelf desktop-file-utils
```

A Linux binary will not run on a distribution older than the one that built it —
glibc is not forwards compatible — so build on the oldest one you intend to
support.

*All four platforms at once:* push a `v*` tag and
[`.github/workflows/build.yml`](.github/workflows/build.yml) builds macOS
(Apple Silicon and Intel), Linux and Windows on GitHub's runners and attaches
everything to a draft release. Its Linux job pins Ubuntu 22.04 deliberately, for
the glibc reason above. This is also the only way to produce a macOS build
without a Mac.

---

## Development

```bash
npx tsc --noEmit                      # typecheck
npx tsx src/utils/<name>.test.ts      # a unit suite (pure modules, no runner)
npm run test:e2e                      # build + Playwright
npm run mobile                        # render at 390px and report what breaks
```

Unit tests are plain `tsx` scripts over the pure modules in `src/utils` — no
test framework. End-to-end tests run Playwright against `vite preview`, which
serves the **last build**, so run `npm run build` before an E2E run or you are
testing a stale bundle.

Visual features are screenshot-verified. If you are changing anything that
paints — a theme, a scene effect, the reading spotlight — look at the render
before believing a green suite; several bugs in this codebase passed every
assertion and were obvious the moment someone opened a screenshot.

**Small screens.** Below `sm` the header collapses to two rows — title and a
tool menu above a scrolling view bar — and the reading views are unchanged.
Above it the desktop header stays, but the view strip scrolls rather than
forcing the page wider. The tools also collapse into that one menu on any
touch screen narrower than `lg`: finger-sized targets are a third wider than
mouse-sized ones, so a tablet runs out of header a whole tool sooner than a
laptop does.

`npm run mobile` renders every view, overlay and tour step and reports
horizontal overflow and undersized tap targets; add `--size=landscape` or
`--size=tablet` for the two shapes that get the desktop header without a mouse.
`e2e/mobile.spec.ts` holds the properties it found.

Three rules worth knowing before you add anything:

- **Width decides layout, the pointer decides size.** `sm:`/`md:` for how much
  room there is; the `touch:` variant (and `useIsTouch`) for hit targets, since
  a tablet has the desktop layout and no mouse.
- **Cap centred modals** — `max-h-[calc(100dvh-2rem)]` and a scrolling body. A
  panel taller than the screen overflows in *both* directions, putting its own
  buttons out of reach with nothing to scroll.
- **Overflow is never cosmetic here.** A header that widens the document also
  moves everything positioned `fixed left-1/2`, which is how the playback bar
  ended up off-screen.
- **Every AI call goes through `utils/aiCall.ts`.** It owns the output budget,
  strips a thinking model's chain of thought, salvages JSON out of prose or a
  truncated reply, and retries once when a model thinks itself out of room. Four
  files may call `chatCompletion` directly and each is named in
  `aiCall.test.ts` with the reason; adding a fifth fails that test.
- **A deliberate edit writes through.** Anything the reader did by hand — a
  mark, an edit, a visitor, a Cut being opened — calls `flushV2()` instead of
  leaving the save to the 400ms debounce. An IndexedDB write cannot hold up a
  page unload, and this trap has cost four features so far.

## Which build am I running?

The bottom of Settings shows `Aeia <version> · <desktop|web> · built <date>`.
Click it to copy. Version and build time are stamped in at build time, so the
line is answerable inside a packaged app where there is no console to open.

## Tech

Vite 6 · React 19 · TypeScript 5.8 · Zustand 5 · Tailwind CSS v4 ·
react-markdown + KaTeX · Tauri 2.

Stories, sprites, backdrops and fonts live in IndexedDB; settings in
localStorage. The v2 store shards its state per slice and per story so touching
one chat does not rewrite the whole library. The only thing that ever leaves
your machine is a request to the AI endpoint you configured yourself.

## License & credits

Aeia Reader is written from scratch. Bundled Press Start 2P is SIL OFL (licence
in `public/fonts/`). Design inspiration is credited in the plan documents; no
third-party application code is vendored.
