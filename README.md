# Aeia Reader

A local-first reader for **SillyTavern** and **KoboldAI** stories. Import your
chat logs and read them back as something made — the words arrive at reading
speed, the page can take on the mood of the scene, and you can mark it up as you
go. Everything is stored on your device: no account, no server, nothing
uploaded.

AI is **optional everywhere**. Point Aura at any OpenAI-compatible endpoint
(including a local one) and a few extra things wake up; leave it unset and every
feature still works from a heuristic fallback.

---

## What it does

### Read

- **A library that scales.** Search by title, character or tag; sort by last
  read, date added, title or progress; filter by tag and format. Tags are yours
  to edit. A deeper search reads the text inside every story on request.
- **Nine views of the same story.** Storybook (prose), Chat (bubbles), Book
  (real two-page spreads with page-flips), Stage (RPG dialogue box with
  portraits), VN (visual-novel staging with sprites, backdrops and camera
  moves), Sandbox (AI-designed presentation), plus Overview, Highlights and
  Branches. Only the views you pin sit on the bar; the rest live under "…".
- **Reading modes** — one switch for how much the app performs the text:
  **Plain** (just the words) → **Lit** (the page takes the scene's mood) →
  **Cinema** (motion, weather, emphasis) → **Performance** (and it reads aloud).
  Change anything underneath and the label says so — "Cinema · modified".
- **Streaming playback** — letter- or word-by-word reveal with a WPM readout,
  configurable pause between messages, speed controls, and **TTS** (browser
  voices or a local Kokoro server, with per-character voice casting).
- **Autofocus** — hands-free reading that dims everything but the passage in
  hand, with an optional **magnifier** that lights the words as they arrive.
- **Book pagination**, chapter openings, drop caps, running heads, bookmarks.

### Mark it up

- **Highlights & notes** — hold `F` and select to highlight in five colours;
  attach notes to any passage. Highlights are painted back onto the text and
  collected in their own view.
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

- **30+ themes**, from Light/Dark/Sepia to Terminal (CRT), Windows 98, Aero
  Glass, Synthwave, Grimoire, Cyberpunk, E-Ink, Game Boy, RPG Quest, Pixel Chat
  and MGS-style Codec — each with fitting fonts and optional ambient effects.
- **Custom fonts** (upload your own), accent colours, font size, content width,
  paragraph spacing, dialogue styling and `[OOC: …]` handling.
- **Auto-formatter** — regex find/replace with per-role targeting, live preview,
  import/export and one-click presets (strip `<think>` blocks, OOC comments,
  HTML, anti-slop cleanup).
- **Stage assets** — per-chat character sprites (six expressions), backdrops by
  keyword, and profile pictures.
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
- **Assistant, Cowrite, Summarize** — scoped Q&A over the story, alternate-beat
  ranking and fusion, and agentic map-reduce summaries saved as versioned pins.
- **Narrative Refinery** — extract and restyle prose with a fidelity check.

### Share it

- **Export as a readable page** — one self-contained `.html` file with the
  theme, dialogue styling, chapter structure, your highlights and the Director's
  per-scene mood baked in. It loads nothing from the network, so handing someone
  your story tells nobody they opened it.
- **Render an audiobook** — the whole story as one MP3 with a CUE sheet marking
  each chapter, read in your cast's voices. Needs a local **Kokoro** server: the
  browser's own speech engine plays straight to the speakers and cannot be
  recorded.

### Formats

SillyTavern chats (`.jsonl`, including hidden/narrator lines) · KoboldAI and
KoboldCpp saves (`.json`) · TavernAI character cards (`.png`, V1/V2/V3) ·
documents (`.txt`, `.md`, `.docx`). Export back to Markdown.

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

Settings → AI. Paste any OpenAI-compatible base URL — Aura probes for the right
prefix, so `http://localhost:5001` and `http://localhost:5001/v1` both work.
Tested against OpenAI, OpenRouter, LM Studio, Ollama, llama.cpp and KoboldCpp.

> Running Aura in WSL against a server on Windows? `localhost` will not reach
> it — use the default gateway from `ip route show default`.

---

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `←` / `→` | Turn pages (paginated layout) |
| `Q` / `E` tap | Slower / faster |
| `E` hold | 3× speed while held |
| `Q` hold | Rewind while held |
| `W` / `S`, `A` / `D` | Zoom / pan (autofocus) |
| `F` hold + select | Highlight the selection |
| `Ctrl`/`Cmd` + `F` | Focus search |
| `C` / `M` / `S` | Codex / Multiverse / Sheets |
| `Esc` | Close a panel, exit autofocus |

---

## Building

**Web (static site):**

```bash
npm run build          # → dist/, serve with any static file server
```

**Desktop app:** Aura ships as a native app via Tauri v2 — see
[`BUILD.md`](./BUILD.md) for prerequisites and the `npm run app:build` steps
that produce a Windows `.msi`/`.exe`, macOS `.dmg` or Linux `.AppImage`.

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
forcing the page wider.

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
