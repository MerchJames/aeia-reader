# Aeia Bridge — a SillyTavern extension

Sync the chat you have open in SillyTavern with **Aeia Reader**, in both
directions, without touching a file manually.

- Messages you write in SillyTavern come **into** Aeia.
- Rewrites you make in Aeia's Lens go **back out** to SillyTavern.
- **Nothing is written to your chat without a popup showing you every change
  first.** That is not a setting you can turn off.

---

## Install

### The easy way

**Windows** — right-click `install.ps1` → *Run with PowerShell*. Or:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

**Linux / macOS**:

```bash
./install.sh
```

Either one finds SillyTavern in the usual places, copies one folder into
`data/<user>/extensions/aeia-bridge`, and tells you the exact paths first. If it
cannot find your install, pass it:

```
powershell -ExecutionPolicy Bypass -File install.ps1 -SillyTavern "C:\path\to\SillyTavern"
./install.sh /path/to/SillyTavern
```

Then reload SillyTavern in your browser and look for **Aeia Bridge** under
Extensions.

### From SillyTavern's own installer

SillyTavern's **Extensions → Install extension** box takes a git URL, clones it,
and expects `manifest.json` at the top of the repository. That means it works
against a repo whose ROOT is this extension — not against a subfolder of a
larger project. If you are reading this inside the Aeia repository, use the
script above; if you are looking at a standalone `aeia-bridge` repository, paste
its URL into that box and you are done.

### By hand

Copy the `aeia-bridge` folder into:

```
<SillyTavern>/data/<your-user>/extensions/
```

That is usually `data/default-user/extensions/`. **Not**
`public/scripts/extensions/third-party/` — that is the pre-1.12 location, and a
copy left there is loaded by nothing.

Reload the page. No restart needed.

## Use it

Open a chat, then in the Aeia Bridge panel:

**Sync this chat** opens Aeia in a new tab and sends it the chat. Aeia shows
its sync panel with everything that differs between the two sides. Work there,
and when you send rewrites back, this extension shows you each one before it
touches anything.

**Send again** re-sends after you have written more in SillyTavern. Tick *Send
automatically when I switch chats* if you would rather it keep up on its own.

**Sync my whole library** sends every chat of every character in one go, for
filling Aeia up the first time. It reads the chat files from the server rather
than opening each chat, so your open chat is not disturbed and the screen does
not flicker through your whole library.

**Keep panel open** pins a small floating panel with the same buttons, so you
can sync without going back into this drawer. Drag it by its header; it
remembers where you put it.

`/aeia` does the same as the button. `/aeia save=true` saves the file instead,
and `/aeia all=true` sends the whole library.

### Shaping the prompt (experimental)

Off by default. Tick it and the prompt SillyTavern assembles — card, world info,
persona, history, all of it — is handed to Aeia before it goes to the model.
Aeia weaves in the pins, sheets and zones you chose, where you chose to put
them, and hands it back.

This is the half that matters most, because it changes the decision rather than
arguing with it afterwards. It costs milliseconds and no model calls.

What it will not do:

- Hold up your generation. There is a short deadline, and past it your original
  prompt is sent unchanged.
- Run on a dry run — SillyTavern also assembles prompts just to count tokens.
- Put anything but messages into your prompt. Only `role` and `content` come
  back, and anything else Aeia returned is ignored.

Configure what goes in, and where, on Aeia's **endpoint** screen (Settings →
*Aeia as your SillyTavern endpoint*). The same settings drive both this and the
desktop app's own endpoint, so there is one place to set it up either way.

**If you run the desktop Aeia**, you do not need this: point SillyTavern's
Custom endpoint at Aeia and it does the same work plus the reply, in one pass,
with no extension involved in the generation at all. This exists because a
browser tab cannot be an endpoint — SillyTavern's *server* makes that call, and
a page has no address for it to call.

### Second pass on each reply (experimental)

Off by default. Tick it and every new reply goes to Aeia, which checks it
against a few of your pins and sheets — "does this contradict this one fact,
quote the sentence or say NONE" — and may repair a sentence that fails.

**The reply is yours the moment it arrives.** Nothing is held back and nothing
is intercepted. A revision lands afterwards as a **new swipe**, with the
original kept beside it, so the worst a bad second pass can cost you is one
swipe — and Aeia being closed, slow, or wrong costs you nothing at all.

The dock shows what it is doing while it runs (`Checking against <pin> (2/5)`).

What it will not do:

- Check your own turns, or system notes.
- Check a second reply while it is still checking the first.
- Apply anything if you have switched chats, swiped, or edited the message in
  the meantime — the revision carries the text Aeia was given, and if the
  message no longer says that, it is dropped and says so.
- Blank a message, ever.

It costs a handful of model calls per reply, against whatever model Aeia is
configured to use — which need not be the one writing your story. A small fast
model is good at "does this contradict that"; that is the whole idea.

Needs Aeia open in the panel. It does not work with the desktop app yet: a
draft would have to go out and a revision come back through the poll, and that
route does not exist, so the toggle says so rather than doing nothing quietly.

### Group chats

Declined, not attempted. Group chats live in a different folder and save through
a different path, and none of the writing here has been run against one — an
edit written into the wrong file is not something you can undo.

### When Aeia is the desktop app

The browser sync embeds Aeia in a panel here. A packaged .exe has no window to
embed, so it works the other way round: **Aeia listens, and this calls it.**

1. In Aeia, open **Settings → Two-way sync → Sync with SillyTavern**. While that
   screen is open it shows an **address** and a **token**.
2. Put the address in **Aeia address** here, and the token in **App token**.
3. Press **Sync this chat**.

The extension asks the address whether it is the app before it tries to frame
it, so the one box works for both builds and you never have to say which you
have.

Two things follow from the app listening rather than being embedded:

- **The listener is only open while Aeia's sync screen is open.** Leave it open
  until the chat has come over. It also closes itself after fifteen idle
  minutes, and when Aeia quits.
- **Sending rewrites back takes a couple of seconds.** They wait in the app
  until this extension next collects them — it cannot be pushed to, because
  every SillyTavern endpoint wants a CSRF token issued to this page. You still
  approve every change here before anything is written.

The listener is bound to `127.0.0.1`, so nothing off your machine can reach it,
and it answers only pages served from your own machine, only with the token.

### A different hostname is a different library

This one is worth knowing even in the browser: `localhost` and `127.0.0.1` are
the same machine and, to a browser, **different sites**. A frame on a different
site gets its own private storage — so Aeia embedded here would show a real,
working library that the Aeia in your own tab can never see.

The extension moves the Aeia address onto whatever hostname SillyTavern is on,
so this cannot happen by accident, and the hint under the address box tells you
which address will actually be used. Open your Aeia tab at that same address.

### If the tab can't open

Some setups can't do it live — a browser that blocks frames, SillyTavern on a
different machine. The two file buttons do the identical sync by hand:

1. **Save for Aeia** writes this chat as `.jsonl`.
2. Drop that file into Aeia's sync panel, resolve anything it asks about, and
   download the merged file it offers.
3. **Apply merged file** takes that file back and applies it here — still with
   the same preview and the same approval.

You never have to go near SillyTavern's `chats` folder or restart anything.

---

## What it will refuse to do

Each of these is a real failure mode with a real cost, and each is a check in
`index.js` rather than a promise in a readme.

**Overwrite a message that changed here since Aeia read it.** Every incoming
edit carries the text Aeia believed the message held. If you swiped, edited, or
regenerated in the meantime, that edit is skipped and reported. Positions alone
cannot tell the right message from the one that moved into its place.

**Empty a message.** An edit whose new text is blank is refused. Aeia has no
feature that produces one, so an empty edit means something is wrong, and the
cost of guessing is a lost message.

**Destroy a swipe.** SillyTavern keeps a message's text in two places — `mes`
and `swipes[swipe_id]` — and reads the second one back the moment you swipe away
and return. Edits are written to both, together. The other alternates are left
exactly as they were, so nothing the model ever generated is lost. (A write that
touched only `mes` would look perfect until you pressed the arrow twice.)

**Apply a merged file that no longer lines up.** If the file has a different
number of messages than the open chat, the chat moved on after you exported it
and every position in the file may now mean something else. It refuses and asks
you to export again.

**Accept a message from anything but the window it opened.** Live sync requires
all three of: the exact window this extension opened, at the exact origin it
opened, carrying a random nonce generated for that one session.

---

## Why it works this way

The obvious design is for Aeia to call SillyTavern's chat API directly.
SillyTavern won't allow it — `cors.origin` defaults to `null`, so every
cross-origin read is refused unless you loosen the security settings of the
app holding all your chats, and that is not an install step worth writing.

`window.postMessage` is the one channel two origins get for free. It needs no
configuration, no open port and no proxy, and it works whether Aeia is on a dev
server, a static host or a LAN address.

---

## Requires

- SillyTavern 1.13+ (uses `getContext()`, `POPUP_TYPE`, and the
  `SlashCommandParser` object API).
- Aeia with the sync panel — the live bridge needs the Aeia-side patch. The two
  **file** buttons work against any Aeia build that can import and export
  SillyTavern `.jsonl`.

If the versions disagree about the protocol, the bridge says so and refuses
rather than half-understanding a message. Both sides check.
