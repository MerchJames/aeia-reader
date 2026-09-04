/**
 * Aeia Bridge — sync the open chat with Aeia Reader.
 *
 * ── What this is for ───────────────────────────────────────────────────────
 *
 * Aeia reads SillyTavern chats and lets you rewrite passages in a layer it
 * calls the Lens. Getting those rewrites back into SillyTavern used to mean
 * exporting a `.jsonl`, merging it in Aeia, downloading the result, finding the
 * chats folder, replacing the file, and reloading. This does it in two clicks,
 * and it is the same merge either way — Aeia decides what changes, this only
 * carries the result and applies what you approve.
 *
 * ── The one rule ───────────────────────────────────────────────────────────
 *
 * Nothing is written to your chat without a popup showing you every change
 * first. Not as a setting, not as a default: there is no code path in this file
 * that writes a message without `confirmChanges()` having returned true. The
 * thing on the other end of this bridge is another program, and this extension
 * is the part that answers to you.
 *
 * Three further guards, all of them about the same worry:
 *
 *   **Staleness.** Every edit carries the text Aeia believed the message held.
 *   If the message has changed here since — you swiped, you edited, the model
 *   regenerated — the edit is refused and reported instead of applied. An index
 *   alone cannot tell the difference between the right message and the one that
 *   moved into its place.
 *
 *   **Never blanking.** An edit whose new text is empty is refused. Aeia has no
 *   feature that produces one, so an empty edit is a bug somewhere, and the
 *   cost of acting on it is a lost message.
 *
 *   **Identity.** Messages are only ever accepted from the exact window this
 *   extension opened, at the exact origin it opened, carrying a nonce it
 *   generated for that one session. Any page can post to a window; almost none
 *   of them can satisfy all three.
 *
 * ── Why postMessage and not HTTP ───────────────────────────────────────────
 *
 * SillyTavern's CORS origin defaults to `null`, so Aeia cannot call its API
 * without you loosening the security settings of the app that holds all your
 * chats. `window.postMessage` is the channel two origins get for free, and it
 * needs no configuration on either side.
 *
 * Works without any of that, too: the file buttons at the bottom of the panel
 * do the same sync by hand, and are the fallback when Aeia is running somewhere
 * a browser tab cannot open.
 */

import { getContext, extension_settings } from '../../../extensions.js';
import {
    eventSource, event_types, getPastCharacterChats, getRequestHeaders,
    saveSettingsDebounced, updateMessageBlock,
} from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { ARGUMENT_TYPE, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';

const MODULE = 'aeia-bridge';

/** The wire protocol. Both ends check both of these and refuse a mismatch. */
const PROTOCOL = 'aeia-bridge';
const VERSION = 1;

/**
 * Where the header line sits in the file we build.
 *
 * The whole index scheme rests on this one number. Aeia addresses edits by
 * position among the file's non-empty lines, and we write exactly one header
 * line before the messages, so `chat[i]` is line `i + 1`. If that ever stops
 * being true the `was` check below turns every edit into a refusal rather than
 * a wrong write, which is the failure worth having.
 */
const HEADER_LINES = 1;

const defaultSettings = {
    /** Where Aeia is served. Origin is derived from this and nothing else. */
    aeiaUrl: 'http://localhost:3000',
    /**
     * The desktop app's shared secret, when Aeia is an .exe rather than a tab.
     *
     * Empty for the browser build, which authenticates by window identity and a
     * per-session nonce instead. The app cannot do that — it has no window in
     * this browser — so it holds a token and shows it on its sync screen.
     */
    appToken: '',
    /**
     * Hand each new reply to Aeia for a second pass before you read it.
     *
     * Off by default and deliberately so: it is experimental, it costs a few
     * model calls per reply, and it is the only thing here that acts without
     * being pressed. What it produces is a swipe, never a replacement.
     */
    preprocess: false,
    /**
     * Hand the assembled prompt to Aeia before it goes to the model.
     *
     * Separate from `preprocess` because they cost completely different things.
     * This is string work on a prompt and adds milliseconds; that one asks a
     * model several questions about every reply. Bundling them would mean
     * nobody could have the cheap half on its own.
     */
    shapePrompts: false,
    /** Re-send automatically when you switch chats with Aeia open. */
    followChat: false,
    /** Is the floating panel on screen? */
    dockOpen: false,
    /**
     * Where it sits, in PERCENT of the viewport rather than pixels.
     *
     * A position saved on a wide monitor and restored on a laptop would put the
     * panel off the edge if it were stored in pixels — the same trap Aeia's own
     * panel dock exists to avoid. Percentages survive the change of screen, and
     * `clampDock` below catches the rest.
     */
    dockX: 72,
    dockY: 18,
};

/* ------------------------------------------------------------------ */
/* Session state                                                       */
/* ------------------------------------------------------------------ */

/**
 * The Aeia window we are talking to.
 *
 * An IFRAME's contentWindow, not a popup, and that is the whole reason the
 * bridge works. SillyTavern serves itself through `helmet()`, whose default
 * `Cross-Origin-Opener-Policy` is `same-origin`; that policy puts any
 * cross-origin window this page OPENS into a separate browsing context group
 * and severs the link in both directions, so a popped-open Aeia could never be
 * reached and could never reach back. COOP does not apply to frames.
 *
 * Fixing it the other way would have meant every person who wanted the sync
 * editing their own SillyTavern's server source, and losing the edit on every
 * update. This costs them nothing.
 */
let aeiaFrameHost = null;

/**
 * The frame's window, read fresh every time.
 *
 * Never cached. A frame's `contentWindow` is a DIFFERENT object before and
 * after it navigates — the one you get the instant after setting `src` belongs
 * to the `about:blank` it starts on. Holding that reference means checking
 * every incoming message against a window that no longer exists, and every
 * message failing the identity test for a reason nothing reports.
 */
function aeiaWin() {
    return aeiaFrameHost?.querySelector('iframe')?.contentWindow ?? null;
}
/** The origin we opened it at. Messages from anywhere else are ignored. */
let aeiaOrigin = '';
/** This session's secret. Regenerated per connection, never reused. */
let nonce = '';
/** True once Aeia has said hello — before that we send it nothing. */
let ready = false;

const settings = () => {
    extension_settings[MODULE] = Object.assign({}, defaultSettings, extension_settings[MODULE]);
    return extension_settings[MODULE];
};

const say = (msg, kind = 'info') => {
    if (typeof toastr !== 'undefined' && toastr[kind]) toastr[kind](msg, 'Aeia');
    else console.log(`[Aeia] ${msg}`);
};

/* ------------------------------------------------------------------ */
/* Building the chat file                                              */
/* ------------------------------------------------------------------ */

/**
 * Serialise the open chat exactly as SillyTavern writes it to disk.
 *
 * `JSON.stringify` per line is what the server does, and `chat` came from
 * `JSON.parse` of that same file, so key order and every field we do not
 * understand survive the round trip untouched.
 *
 * The header carries the REAL names rather than the `'unused'` placeholders
 * modern SillyTavern writes: Aeia reads them when it imports a chat it has
 * never seen, and a chat that arrives named "unused" is a worse first
 * impression than one named after the character.
 */
function buildChatFile() {
    const ctx = getContext();
    const header = {
        user_name: ctx.name1 ?? '',
        character_name: ctx.name2 ?? '',
        create_date: ctx.chatMetadata?.create_date ?? '',
        chat_metadata: ctx.chatMetadata ?? {},
    };
    const lines = [JSON.stringify(header)];
    for (const message of ctx.chat) lines.push(JSON.stringify(message));
    return lines.join('\n') + '\n';
}

function currentChatLabel() {
    const ctx = getContext();
    return ctx.getCurrentChatId?.() || ctx.chatId || ctx.name2 || 'chat';
}

/* ------------------------------------------------------------------ */
/* Applying edits — the only code here that writes                     */
/* ------------------------------------------------------------------ */

/**
 * Decide what each incoming edit would do, without doing any of it.
 *
 * Split from the writing on purpose: the popup has to show the reader exactly
 * what will happen, and the only way to be sure the popup and the write agree
 * is for the write to consume this list rather than re-deciding.
 */
function planEdits(edits) {
    const ctx = getContext();
    const planned = [];
    const skipped = [];

    for (const edit of Array.isArray(edits) ? edits : []) {
        const index = Number(edit?.index);
        const text = typeof edit?.text === 'string' ? edit.text : '';
        const was = typeof edit?.was === 'string' ? edit.was : null;

        if (!Number.isInteger(index)) {
            skipped.push({ index: -1, reason: 'no valid position' });
            continue;
        }
        const at = index - HEADER_LINES;
        const message = ctx.chat[at];
        if (!message) {
            skipped.push({ index, reason: 'no such message in this chat' });
            continue;
        }
        // Never blank a message. Aeia does not produce one, so this is a bug
        // somewhere, and acting on it costs a message.
        if (!text.trim()) {
            skipped.push({ index, reason: 'would leave the message empty' });
            continue;
        }
        // The staleness guard. See the note at the top of this file.
        if (was !== null && message.mes !== was) {
            skipped.push({ index, reason: 'changed here since Aeia read it' });
            continue;
        }
        if (message.mes === text) {
            skipped.push({ index, reason: 'already says this' });
            continue;
        }
        planned.push({ at, index, message, before: message.mes, text });
    }

    return { planned, skipped };
}

/**
 * Write the planned edits into the chat.
 *
 * `mes` and the current entry of `swipes` move together. SillyTavern loads a
 * message from `mes` and re-reads it from `swipes[swipe_id]` the moment anyone
 * swipes away and back, so writing only `mes` looks perfect until you press the
 * arrow twice and the edit is simply gone — a silent, delayed loss that is
 * indistinguishable from the sync never having run.
 *
 * The other alternates are left alone. Nothing the model generated is
 * destroyed by a sync; if the new text happens to BE one of the alternates,
 * that is a swipe choice and only `swipe_id` moves.
 */
async function writeEdits(planned) {
    const ctx = getContext();

    for (const item of planned) {
        const message = item.message;
        message.mes = item.text;

        if (Array.isArray(message.swipes) && message.swipes.length) {
            const found = message.swipes.indexOf(item.text);
            if (found !== -1) {
                message.swipe_id = found;
            } else {
                const slot = Number.isInteger(message.swipe_id)
                    && message.swipe_id >= 0
                    && message.swipe_id < message.swipes.length
                    ? message.swipe_id
                    : 0;
                message.swipes[slot] = item.text;
            }
        }

        updateMessageBlock(item.at, message);
        await eventSource.emit(event_types.MESSAGE_UPDATED, item.at);
    }

    await ctx.saveChat();
    return planned.length;
}

const truncate = (s, n = 300) => (s.length > n ? s.slice(0, n) + '…' : s);

/**
 * Show every change and ask.
 *
 * Built as DOM rather than an HTML string so that message text — which is
 * arbitrary content from a chat log, and may be anything at all — goes in as
 * `textContent` and cannot become markup in this dialog.
 */
async function confirmChanges(planned, skipped, label) {
    const wrap = document.createElement('div');
    wrap.className = 'aeia-confirm';

    const intro = document.createElement('p');
    intro.textContent = `${label || 'Aeia'} wants to change `
        + `${planned.length} message${planned.length === 1 ? '' : 's'} in this chat.`;
    wrap.appendChild(intro);

    for (const item of planned) {
        const row = document.createElement('div');
        row.className = 'aeia-diff';

        const who = document.createElement('div');
        who.className = 'aeia-diff-who';
        who.textContent = `#${item.at} · ${item.message.name ?? ''}`;
        row.appendChild(who);

        const before = document.createElement('div');
        before.className = 'aeia-before';
        before.textContent = truncate(item.before);
        row.appendChild(before);

        const after = document.createElement('div');
        after.className = 'aeia-after';
        after.textContent = truncate(item.text);
        row.appendChild(after);

        wrap.appendChild(row);
    }

    if (skipped.length) {
        const note = document.createElement('p');
        note.className = 'aeia-skipped';
        note.textContent = `${skipped.length} other edit${skipped.length === 1 ? '' : 's'} `
            + `will be skipped: ${skipped.map(s => s.reason).join('; ')}.`;
        wrap.appendChild(note);
    }

    const result = await callGenericPopup(wrap, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Apply to this chat',
        cancelButton: 'Cancel',
        wide: true,
        allowVerticalScrolling: true,
    });
    return result === POPUP_RESULT.AFFIRMATIVE;
}

/**
 * The single entry point for changing this chat. Everything goes through here.
 *
 * Returns the shape Aeia expects back either way, including when you decline —
 * a cancelled apply is a real outcome and Aeia has to be told, or its panel
 * sits waiting for a reply that is never coming.
 */
async function applyEdits(edits, label) {
    const { planned, skipped } = planEdits(edits);

    if (!planned.length) {
        say(skipped.length ? 'Nothing to apply — every edit was skipped.' : 'Nothing to apply.');
        return { applied: 0, skipped };
    }

    if (!await confirmChanges(planned, skipped, label)) {
        return {
            applied: 0,
            skipped: planned.map(p => ({ index: p.index, reason: 'declined here' })).concat(skipped),
        };
    }

    const applied = await writeEdits(planned);
    say(`Applied ${applied} change${applied === 1 ? '' : 's'} from Aeia.`, 'success');
    return { applied, skipped };
}

/* ------------------------------------------------------------------ */
/* The live bridge                                                     */
/* ------------------------------------------------------------------ */

function makeNonce() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    // base64url: the charset Aeia's handshake reader accepts, and safe in a
    // URL fragment without escaping.
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ------------------------------------------------------------------ */
/* Transport two: Aeia as a desktop app                                */
/* ------------------------------------------------------------------ */

/**
 * Which way we are talking to Aeia: `'frame'`, `'http'`, or nothing yet.
 *
 * The browser build is embedded in a frame and spoken to with `postMessage`.
 * The packaged .exe has no window to embed — so it listens on loopback instead
 * and we call it. `connect()` finds out which by asking, so the reader puts one
 * address in one box either way and never has to know there are two mechanisms.
 */
let mode = 'none';
let appBase = '';
let appToken = '';
let pollTimer = null;

/** How often to look for edits the reader has queued in the app. */
const POLL_MS = 2000;

const appHeaders = () => ({
    'Content-Type': 'application/json',
    // Custom on purpose: it forces a CORS preflight, which is what stops a
    // page from anywhere but loopback being answered at all.
    'X-Aeia-Token': appToken,
});

/**
 * Is there a desktop Aeia at this address?
 *
 * Asked rather than configured. The same box holds `http://localhost:3000` for
 * the browser build and `http://127.0.0.1:8770` for the app, and the reader
 * should not have to tell us which kind of thing they typed. A web build
 * answers this path with its own HTML, which is not JSON and not us.
 */
async function probeApp(base) {
    try {
        const response = await fetch(`${base}/aeia/ping`, { method: 'GET', mode: 'cors' });
        if (!response.ok) return false;
        const data = await response.json();
        return data && data.app === 'aeia';
    } catch {
        return false;
    }
}

async function appPost(path, body) {
    const response = await fetch(`${appBase}${path}`, {
        method: 'POST',
        headers: appHeaders(),
        body: JSON.stringify(body),
    });
    if (response.status === 401) throw new Error('Aeia refused the token.');
    if (!response.ok) throw new Error(`Aeia answered ${response.status}.`);
    return response.json().catch(() => ({}));
}

/**
 * Collect anything the reader has queued in the app, and act on it.
 *
 * Polled because there is no way to be told: the app cannot call SillyTavern —
 * every endpoint here wants a CSRF token issued to this page, which is the
 * whole reason the browser build talks over `postMessage`. Two seconds is well
 * under noticing for something the reader triggers by hand, and a request to a
 * socket on this machine costs nothing.
 */
async function pollOutbox() {
    if (mode !== 'http') return;
    try {
        const response = await fetch(`${appBase}/aeia/outbox`, { headers: appHeaders() });
        if (response.status === 401) {
            say('Aeia refused the token — check it in the Aeia Bridge settings.', 'error');
            stopPolling();
            return;
        }
        if (!response.ok) return;
        const jobs = await response.json();
        for (const job of Array.isArray(jobs) ? jobs : []) {
            if (!job || job.type !== 'apply') continue;
            /*
             * The chat these edits were written against, checked against the
             * chat that is open.
             *
             * Over a socket there is no shared window to tie the two ends to
             * one conversation, and the reader can change chats here between
             * asking Aeia to sync and asking it to send. Every edit carries the
             * text it expects, so a wrong chat would be refused edit by edit —
             * but "0 applied, 40 skipped" is a far worse answer than the true
             * one, and it looks like a broken bridge rather than a mismatch.
             */
            if (job.chatId && String(job.chatId) !== String(currentChatLabel())) {
                await appPost('/aeia/applied', {
                    applied: 0,
                    skipped: [{
                        index: -1,
                        reason: `These edits are for “${job.chatId}”, but “${currentChatLabel()}” `
                            + 'is open here. Open that chat and send again.',
                    }],
                }).catch(() => {});
                continue;
            }
            try {
                const result = await applyEdits(job.edits ?? [], job.label ?? 'Aeia');
                await appPost('/aeia/applied', { applied: result.applied, skipped: result.skipped });
            } catch (error) {
                await appPost('/aeia/applied', {
                    applied: 0,
                    skipped: [{ index: -1, reason: String(error?.message ?? error) }],
                }).catch(() => {});
            }
        }
        ready = true;
        paintDockState();
    } catch {
        // The app was closed, or its listener timed out. Not an error to shout
        // about — the state word goes back to offline on the next paint.
        if (mode === 'http') { ready = false; paintDockState(); }
    }
}

function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => { void pollOutbox(); }, POLL_MS);
    void pollOutbox();
}

function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
}

function send(body) {
    if (mode === 'http') {
        // The same envelopes, over the other transport. `chat` is the only one
        // the app pulls from a queue; a result goes to its own mailbox.
        if (body.type === 'chat') {
            appPost('/aeia/chat', body.chat).catch(e => say(String(e?.message ?? e), 'error'));
            return true;
        }
        if (body.type === 'applied') {
            appPost('/aeia/applied', { applied: body.applied, skipped: body.skipped }).catch(() => {});
            return true;
        }
        if (body.type === 'error') {
            appPost('/aeia/applied', {
                applied: 0, skipped: [{ index: -1, reason: body.message }],
            }).catch(() => {});
            return true;
        }
        return false;
    }
    if (!isAeiaLive()) return false;
    aeiaWin().postMessage({ protocol: PROTOCOL, v: VERSION, nonce, ...body }, aeiaOrigin);
    return true;
}

/**
 * Is this a group chat?
 *
 * Groups are stored in their own folder and saved through `saveGroupChat`
 * rather than `saveChat`, and none of the writing here has ever been run
 * against one. The whole feature is declined for them rather than half-working:
 * an edit written into the wrong file is not a bug the reader can undo.
 */
function isGroupChat() {
    return !!getContext().groupId;
}

function sendChat() {
    const ctx = getContext();
    if (isGroupChat()) { say('Group chats are not supported yet.', 'warning'); return; }
    if (!ctx.chat?.length) { say('This chat is empty.', 'warning'); return; }
    send({
        type: 'chat',
        chat: {
            chatId: String(currentChatLabel()),
            character: ctx.name2 ?? '',
            user: ctx.name1 ?? '',
            file: buildChatFile(),
            messageCount: ctx.chat.length,
        },
    });
}

/**
 * Every chat of every character, sent to Aeia.
 *
 * ── Why this does not use `openCharacterChat` ──────────────────────────────
 *
 * The obvious loop — open each chat, read `context.chat`, move on — works and
 * is the wrong thing to do to somebody's screen. `openCharacterChat` clears the
 * message list, fetches, and re-renders the whole UI for every chat, firing
 * `CHAT_CHANGED` each time; on a library of two hundred chats the reader
 * watches their app flicker through all of them, the auto-send handler below
 * fires on every one, and whatever they were reading is gone at the end of it.
 *
 * The server will simply hand over a chat file instead. `/api/chats/get`
 * returns the parsed file — header line included — for any chat of any
 * character, without touching what is open. That is the whole difference
 * between a sync you can run while reading and one you have to sit through.
 *
 * Sequential on purpose: this is somebody's whole library going over a
 * postMessage channel, and forty parallel fetches to their own machine buys
 * nothing but a chance to run it out of memory.
 */
async function syncAllChats() {
    const ctx = getContext();
    const characters = Array.isArray(ctx.characters) ? ctx.characters : [];
    if (!characters.length) { say('No characters to sync.', 'warning'); return; }

    let sent = 0;
    let skipped = 0;
    say(`Reading ${characters.length} character${characters.length === 1 ? '' : 's'}…`);

    for (let i = 0; i < characters.length; i++) {
        const character = characters[i];
        if (!character?.avatar) continue;

        let past = [];
        try {
            past = await getPastCharacterChats(i) ?? [];
        } catch {
            skipped++;
            continue;
        }

        for (const entry of past) {
            // `file_id` is the name without `.jsonl`, which is what /get wants.
            const fileId = entry?.file_id ?? String(entry?.file_name ?? '').replace(/\.jsonl$/i, '');
            if (!fileId) continue;
            if (!isAeiaLive()) { say('Aeia was closed — stopping.', 'warning'); return; }

            try {
                const response = await fetch('/api/chats/get', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({
                        ch_name: character.name,
                        file_name: fileId,
                        avatar_url: character.avatar,
                    }),
                });
                if (!response.ok) { skipped++; continue; }
                const rows = await response.json();
                if (!Array.isArray(rows) || rows.length < 2) { skipped++; continue; }

                // The file as it is on disk: one JSON object per line, header
                // first. Rebuilt rather than re-fetched as text because the
                // endpoint parses it for us and this is the same bytes back.
                const file = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
                send({
                    type: 'chat',
                    chat: {
                        chatId: fileId,
                        character: character.name ?? '',
                        user: ctx.name1 ?? '',
                        file,
                        messageCount: rows.length - HEADER_LINES,
                    },
                });
                sent++;
                // A breath between sends. The receiver parses each one, and a
                // tight loop over a large library can starve its event loop.
                await new Promise(r => setTimeout(r, 10));
            } catch {
                skipped++;
            }
        }
    }

    say(`Sent ${sent} chat${sent === 1 ? '' : 's'} to Aeia${skipped ? ` · ${skipped} skipped` : ''}.`);
}

/* ------------------------------------------------------------------ */
/* The second pass                                                     */
/* ------------------------------------------------------------------ */

/*
 * A reply, handed to Aeia for one narrow check before you read it.
 *
 * ── What this is ──────────────────────────────────────────────────────────
 *
 * When a reply arrives, it goes to Aeia, which checks it against a handful of
 * the reader's own pins and sheets — "does this contradict this one fact, quote
 * the sentence or say NONE" — and repairs at most a few sentences that fail.
 * The judgement is entirely Aeia's; this end sends the text and applies what
 * comes back.
 *
 * ── Why the reply is not intercepted ──────────────────────────────────────
 *
 * It would be possible to hold the message until the check finished. This does
 * not: the reply is written, rendered, and yours the moment it arrives, and a
 * revision lands afterwards **as a new swipe** with the original left in place
 * beside it. So the worst case for a bad second pass is one extra swipe, and
 * the worst case for Aeia being closed, slow, or wrong is nothing at all.
 *
 * Everything below is a guard on that promise:
 *
 *   **Only what the character wrote.** User turns and system notes have nothing
 *   to check and would spend calls establishing it.
 *
 *   **One at a time.** A second reply arriving mid-check is left alone rather
 *   than queued — by the time a backlog cleared, its revisions would be
 *   answering questions about messages you have already read past.
 *
 *   **The message must not have moved.** Same chat, same position, same text as
 *   Aeia was given. Anything else and the revision is dropped, because the
 *   thing it describes no longer exists.
 *
 *   **Never blank.** Same rule as every other write here.
 *
 * Frame transport only, for now. Over the desktop socket the draft would have
 * to go out and the revision come back through a poll, and neither end has that
 * route yet; `preprocessReady` refuses rather than silently doing nothing.
 */

/* ------------------------------------------------------------------ */
/* Shaping the prompt                                                  */
/* ------------------------------------------------------------------ */

/*
 * The prompt, handed to Aeia before it goes to the model.
 *
 * ── Why this exists here and not only in the app ──────────────────────────
 *
 * The desktop Aeia can BE your model endpoint: SillyTavern calls it, it works
 * on the prompt, passes it on, and works on the reply. A browser tab cannot do
 * that — SillyTavern's *server* makes that call, and a page has no address for
 * it to call. That would have left everyone not running the .exe without the
 * half of the feature that matters most.
 *
 * But SillyTavern emits its assembled prompt to extensions, AWAITS them, and
 * sends whatever array they leave behind. So the browser gets there another
 * way: hand the prompt over, wait for the shaped one, put it in place. Same
 * pipeline on the far side, same settings, same tests.
 *
 * ── What it will not do ───────────────────────────────────────────────────
 *
 * **Hold up your generation.** SillyTavern is waiting on this, so there is a
 * short deadline and the original prompt is used when it passes. A pipeline
 * that made you wait would be worse than no pipeline.
 *
 * **Change the shape.** Only `role` and `content` are read back, applied to a
 * copy that is spliced in. Anything Aeia returned that was not a message is
 * ignored rather than trusted into the prompt SillyTavern is about to send.
 *
 * **Run on a dry run.** SillyTavern assembles the prompt to count tokens too;
 * shaping one of those would spend the budget on a prompt nobody sends.
 */

/** How long SillyTavern may be kept waiting. */
const SHAPE_TIMEOUT_MS = 4000;

/** Prompts in flight, by id, resolved when Aeia answers. */
const shaping = new Map();
let shapeSeq = 0;

async function shapePrompt(eventData) {
    if (!settings().shapePrompts) return;
    if (eventData?.dryRun) return;
    if (mode !== 'frame' || !isAeiaLive() || !ready) return;
    const chat = eventData?.chat;
    if (!Array.isArray(chat) || !chat.length) return;

    const id = `p${++shapeSeq}`;
    const sent = chat.map(m => ({ role: String(m?.role ?? ''), content: String(m?.content ?? '') }));

    const answer = await new Promise(resolve => {
        const timer = setTimeout(() => {
            shaping.delete(id);
            // Silent: a slow Aeia should cost a shaped prompt, not a toast on
            // every message the reader sends.
            resolve(null);
        }, SHAPE_TIMEOUT_MS);
        shaping.set(id, (value) => { clearTimeout(timer); shaping.delete(id); resolve(value); });
        send({ type: 'prompt', prompt: { id, messages: sent } });
    });

    if (!answer || !answer.changed || !Array.isArray(answer.messages) || !answer.messages.length) {
        return;
    }

    const shaped = answer.messages
        .filter(m => m && typeof m.role === 'string' && typeof m.content === 'string')
        .map(m => ({ role: m.role, content: m.content }));
    if (!shaped.length) return;

    // In place: `chat` is the array SillyTavern is about to send, and it holds
    // the reference. Replacing the variable would change nothing at all.
    chat.splice(0, chat.length, ...shaped);
    if (answer.summary) console.info(`[Aeia] prompt: ${answer.summary}`);
    paintStage('');
}

/** The draft Aeia is looking at, or null. One at a time, by design. */
let pendingDraft = null;

/** How long to wait before deciding the answer is not coming. */
const DRAFT_TIMEOUT_MS = 120_000;

/** The dock's progress line — the only place a run is visible while it runs. */
function paintStage(text) {
    const el = document.getElementById('aeia_dock_stage');
    if (!el) return;
    el.textContent = text || '';
    el.hidden = !text;
}

function clearDraft() {
    if (pendingDraft?.timer) clearTimeout(pendingDraft.timer);
    pendingDraft = null;
    paintStage('');
}

function preprocessReady() {
    if (!settings().preprocess) return false;
    // The socket transport has no route for a draft or a revision yet, and a
    // toggle that appears to work is worse than one that says it does not.
    if (mode !== 'frame') return false;
    return isAeiaLive() && ready && !isGroupChat();
}

function sendDraft(messageId) {
    if (!preprocessReady()) return;
    // Already checking something. The next reply is simply not checked.
    if (pendingDraft) return;

    const ctx = getContext();
    const at = Number(messageId);
    if (!Number.isInteger(at)) return;
    const message = ctx.chat?.[at];
    if (!message) return;
    if (message.is_user || message.is_system || message.extra?.isSmallSys) return;

    const text = String(message.mes ?? '');
    if (!text.trim()) return;

    pendingDraft = {
        at,
        chatId: String(currentChatLabel()),
        timer: setTimeout(() => {
            clearDraft();
            say('Aeia did not finish checking that reply. It is unchanged.', 'warning');
        }, DRAFT_TIMEOUT_MS),
    };
    paintStage('Second pass…');
    send({
        type: 'draft',
        draft: {
            // File position, not chat position — the same convention every edit
            // uses, so both ends count lines the same way.
            index: at + HEADER_LINES,
            text,
            name: String(message.name ?? ''),
            chatId: pendingDraft.chatId,
        },
    });
}

/**
 * Give a message the swipe shape, without touching what is already there.
 *
 * SillyTavern exports `ensureSwipes` for this, and it is deliberately not
 * imported: a named import that a reader's version does not have fails the
 * whole module at load time, which would take the entire extension down over an
 * optional feature. This is the same few lines, and it pads `swipe_info` rather
 * than rebuilding it, so per-swipe timings already recorded survive.
 */
function ensureSwipeShape(message) {
    if (!Array.isArray(message.swipes) || !message.swipes.length) {
        message.swipes = [String(message.mes ?? '')];
        message.swipe_id = 0;
    }
    if (!Number.isInteger(message.swipe_id)
        || message.swipe_id < 0
        || message.swipe_id >= message.swipes.length) {
        message.swipe_id = 0;
    }
    const info = () => ({
        send_date: message.send_date,
        gen_started: message.gen_started,
        gen_finished: message.gen_finished,
        extra: {},
    });
    if (!Array.isArray(message.swipe_info)) message.swipe_info = [];
    while (message.swipe_info.length < message.swipes.length) message.swipe_info.push(info());
    message.swipe_info.length = message.swipes.length;
}

async function applyRevision(revision) {
    const pending = pendingDraft;
    clearDraft();

    const index = Number(revision?.index);
    const text = typeof revision?.text === 'string' ? revision.text : '';
    const original = typeof revision?.original === 'string' ? revision.original : '';
    const summary = typeof revision?.summary === 'string' ? revision.summary : '';

    // An answer to a question nobody asked — a stale run, or one that arrived
    // after the wait ran out.
    if (!pending || index !== pending.at + HEADER_LINES) return;

    if (!revision?.changed || !text.trim() || text === original) {
        if (summary) say(summary);
        return;
    }

    const ctx = getContext();
    if (String(currentChatLabel()) !== pending.chatId) {
        say('That check finished after you changed chats — the reply is unchanged.', 'warning');
        return;
    }
    const message = ctx.chat?.[pending.at];
    if (!message) return;
    // The receipt. If the message has moved on — a swipe, an edit, a rerun —
    // then what came back describes something that is no longer there.
    if (message.mes !== original) {
        say('That reply changed while Aeia was checking it — it is unchanged.', 'warning');
        return;
    }

    ensureSwipeShape(message);
    // Put the original safely in its own slot BEFORE adding anything beside it.
    // Without this, a message edited by hand after generation would have its
    // edit written over by the stale swipe it still points at.
    if (message.swipes[message.swipe_id] !== message.mes) {
        message.swipes[message.swipe_id] = message.mes;
    }
    message.swipes.push(text);
    message.swipe_info.push({
        send_date: message.send_date,
        gen_started: message.gen_started,
        gen_finished: message.gen_finished,
        extra: { aeia_second_pass: true },
    });
    message.swipe_id = message.swipes.length - 1;
    message.mes = text;

    updateMessageBlock(pending.at, message);
    await eventSource.emit(event_types.MESSAGE_UPDATED, pending.at);
    await ctx.saveChat();
    say(summary
        ? `${summary} Swipe left for the original.`
        : 'Aeia revised this reply. Swipe left for the original.');
}

async function onMessage(event) {
    // Identity, origin, then contents — in that order, and all three must hold.
    if (!isAeiaLive() || event.source !== aeiaWin()) return;
    if (event.origin !== aeiaOrigin) return;

    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.protocol !== PROTOCOL) return;
    if (data.v !== VERSION) {
        say('Aeia is speaking a different version of the bridge. Update one of them.', 'warning');
        return;
    }
    if (!nonce || data.nonce !== nonce) return;

    if (data.type === 'hello') {
        ready = true;
        paintDockState();
        sendChat();
        return;
    }

    // Progress on a second pass. Only ever a status line — nothing is written
    // on the strength of one, so it needs no more checking than being readable.
    if (data.type === 'stage') {
        const stage = data.stage;
        if (pendingDraft && stage && typeof stage.label === 'string') {
            const step = Number(stage.step);
            const total = Number(stage.total);
            paintStage(Number.isInteger(step) && Number.isInteger(total) && total > 0
                ? `${stage.label} (${step}/${total})`
                : String(stage.label));
        }
        return;
    }

    if (data.type === 'shaped') {
        const shaped = data.shaped;
        const waiting = shaped && shaping.get(String(shaped.id));
        if (waiting) waiting(shaped);
        return;
    }

    if (data.type === 'revision') {
        try {
            await applyRevision(data.revision ?? {});
        } catch (error) {
            console.error('[Aeia] revision failed', error);
            clearDraft();
        }
        return;
    }

    if (data.type === 'apply') {
        try {
            const result = await applyEdits(data.edits, data.label);
            send({ type: 'applied', applied: result.applied, skipped: result.skipped });
        } catch (error) {
            console.error('[Aeia] apply failed', error);
            send({ type: 'error', message: String(error?.message ?? error) });
        }
    }
}

/** Loopback under every name a browser treats as a DIFFERENT site. */
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/**
 * The Aeia address, moved onto SillyTavern's own host name.
 *
 * ── Why this is not a cosmetic tidy-up ─────────────────────────────────────
 *
 * Browsers partition storage by the top-level SITE. A frame whose site differs
 * from the page holding it is a third party and gets a private box: its own
 * IndexedDB, its own localStorage. Aeia in that frame then shows a library that
 * is real, writable, and invisible to the Aeia the reader opens in a tab —
 * every chat synced into it lands somewhere they can never look.
 *
 * `localhost` and `127.0.0.1` are the same machine and DIFFERENT SITES. The
 * launcher opens SillyTavern at `http://127.0.0.1:8000`; the Aeia address
 * defaults to `http://localhost:3000`; both are correct, both work, and the
 * combination silently splits the library in two. Ports do not matter — they
 * are not part of a site — so this only ever changes the host name, and only
 * between names for this same machine.
 */
function sameSiteUrl(url) {
    try {
        const wanted = new URL(url);
        const here = window.location.hostname;
        if (wanted.hostname === here) return url;
        // Only ever between two names for THIS machine. A real remote host is
        // the reader's own decision and none of our business.
        if (!LOOPBACK.includes(wanted.hostname) || !LOOPBACK.includes(here)) return url;
        wanted.hostname = here;
        return wanted.toString().replace(/\/$/, '');
    } catch {
        return url;
    }
}

async function connect() {
    const asked = String(settings().aeiaUrl || '').trim();

    /*
     * The desktop app first, because it can be asked.
     *
     * If something at this address answers `ping` as Aeia, it is the packaged
     * app and there is nothing to embed — talk to it over HTTP and skip the
     * frame entirely. The host-matching below is a browser concern (storage
     * partitioning) and does not apply to a socket, so it is not done here.
     */
    appToken = String(settings().appToken || '').trim();
    const base = asked.replace(/\/+$/, '');
    if (base && await probeApp(base)) {
        if (!appToken) {
            say('Aeia is running, but no app token is set — copy it from Aeia\'s sync screen.', 'error');
            return;
        }
        mode = 'http';
        appBase = base;
        ready = false;
        paintDockState();
        startPolling();
        say('Connected to the Aeia app.');
        sendChat();
        return;
    }

    const url = sameSiteUrl(asked);
    if (url !== asked) {
        console.info(`[Aeia] Framing ${url} rather than ${asked} — SillyTavern is on `
            + `${window.location.hostname}, and a frame on a different host name would be given `
            + 'its own separate storage. Open your Aeia tab at the same address.');
    }
    let origin;
    try {
        origin = new URL(url).origin;
    } catch {
        say('That Aeia address is not a URL.', 'error');
        return;
    }
    if (!/^https?:$/.test(new URL(url).protocol)) {
        say('Aeia must be at an http or https address for the live bridge.', 'error');
        return;
    }

    // A fresh secret per connection. Reusing one would let a window from an
    // earlier session keep talking to this one.
    nonce = makeNonce();
    aeiaOrigin = origin;
    ready = false;
    paintDockState();

    // Our own origin travels with it so Aeia can address its first message to
    // exactly this window's origin instead of broadcasting the nonce.
    const target = `${url}${url.includes('#') ? '' : '#'}`
        + `${PROTOCOL}=${nonce}&origin=${encodeURIComponent(window.location.origin)}`;

    mode = 'frame';
    openAeiaFrame(target);
    say('Opening Aeia…');
}

/** Is the frame still on the page and reachable? */
function isAeiaLive() {
    if (mode === 'http') return !!appBase;
    return !!(aeiaFrameHost && aeiaFrameHost.isConnected && aeiaWin());
}

/** Bring the panel back to the front, or back from being minimised. */
function showAeia() {
    if (!aeiaFrameHost) return;
    aeiaFrameHost.hidden = false;
    aeiaFrameHost.classList.remove('is-min');
}

/**
 * Aeia, in a panel on top of SillyTavern.
 *
 * A panel rather than a popup because a popup cannot be talked to (see
 * `aeiaWin`), and a panel rather than SillyTavern’s own modal because the
 * reader asked for something they could leave hanging while they wrote — a
 * modal would close the moment they touched the chat behind it.
 *
 * The frame is Aeia's real origin, so what shows here is the reader's actual
 * library out of their actual IndexedDB, not a copy.
 */
function openAeiaFrame(target) {
    closeAeiaFrame();

    const host = document.createElement('div');
    host.className = 'aeia-frame-host';
    host.innerHTML = `
      <div class="aeia-frame-head">
        <i class="fa-solid fa-right-left"></i>
        <span class="aeia-frame-title">Aeia — sync</span>
        <div class="aeia-frame-btn" data-act="min" title="Minimise"><i class="fa-solid fa-minus"></i></div>
        <div class="aeia-frame-btn" data-act="close" title="Close"><i class="fa-solid fa-xmark"></i></div>
      </div>
      <iframe class="aeia-frame" title="Aeia sync"></iframe>`;
    document.body.appendChild(host);

    aeiaFrameHost = host;
    const frame = host.querySelector('iframe');
    // `src` is set AFTER the frame is in the document, so the load — and the
    // handshake it carries — cannot happen before there is a window to answer.
    frame.src = target;

    host.querySelector('[data-act="close"]').addEventListener('click', () => {
        closeAeiaFrame();
        disconnect();
    });
    host.querySelector('[data-act="min"]').addEventListener('click', () => {
        host.classList.toggle('is-min');
    });

    dragFrameBy(host.querySelector('.aeia-frame-head'), host);
}

function closeAeiaFrame() {
    if (aeiaFrameHost?.isConnected) aeiaFrameHost.remove();
    aeiaFrameHost = null;
}

/** The same pointer drag the small panel uses, on the frame's header. */
function dragFrameBy(handle, host) {
    handle.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.aeia-frame-btn') || e.button !== 0) return;
        e.preventDefault();
        handle.setPointerCapture?.(e.pointerId);
        const start = host.getBoundingClientRect();
        const dx = e.clientX - start.left;
        const dy = e.clientY - start.top;
        const move = (ev) => {
            host.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, ev.clientX - dx))}px`;
            host.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy))}px`;
            host.style.right = 'auto';
            host.style.bottom = 'auto';
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    });
}

function disconnect() {
    stopPolling();
    closeAeiaFrame();
    mode = 'none';
    appBase = '';
    aeiaOrigin = '';
    nonce = '';
    ready = false;
    paintDockState();
}

/* ------------------------------------------------------------------ */
/* The file fallback                                                   */
/* ------------------------------------------------------------------ */

function downloadChat() {
    const name = String(currentChatLabel()).replace(/[^\w\d .-]+/g, '_');
    const blob = new Blob([buildChatFile()], { type: 'application/jsonl' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.jsonl`;
    a.click();
    URL.revokeObjectURL(url);
    say('Saved. Drop it into Aeia’s sync panel.');
}

/**
 * Take a merged `.jsonl` back from Aeia.
 *
 * The count check is the whole safety story on this path. Aeia's merge only
 * ever rewrites the text of lines that were already there — it never adds or
 * removes one — so a file with a different number of messages than this chat
 * means the chat moved on after it was exported, and every position in the file
 * may now point at a different message. Refusing is the only safe answer; the
 * fix is to export again, which takes a second.
 */
async function loadMergedFile(file) {
    const ctx = getContext();
    const text = await file.text();
    const lines = text.split('\n').filter(l => l.trim().length > 0);
    const body = lines.slice(HEADER_LINES);

    if (body.length !== ctx.chat.length) {
        say(`That file has ${body.length} messages and this chat has ${ctx.chat.length}. `
            + 'Export the chat again and re-merge it — the positions no longer line up.', 'error');
        return;
    }

    const edits = [];
    for (let i = 0; i < body.length; i++) {
        let parsed;
        try { parsed = JSON.parse(body[i]); } catch { continue; }
        if (typeof parsed?.mes !== 'string') continue;
        if (parsed.mes === ctx.chat[i].mes) continue;
        edits.push({ index: i + HEADER_LINES, text: parsed.mes, was: ctx.chat[i].mes });
    }

    if (!edits.length) { say('That file matches this chat already — nothing to apply.'); return; }
    await applyEdits(edits, file.name);
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* The floating panel                                                  */
/* ------------------------------------------------------------------ */

/**
 * A small panel you can leave hanging while you write.
 *
 * The settings drawer is the wrong home for something you press mid-session:
 * it is three clicks away behind a scroll, and it closes when you go back to
 * the chat. Everything here is also in the drawer — this is a shortcut to the
 * four buttons that get used, not a second feature.
 *
 * Deliberately NOT using SillyTavern's own `dragElement`: it is wired to
 * specific ids and writes into the power-user movingUI settings, so borrowing
 * it would couple this extension to internals that move between releases. The
 * drag below is thirty lines and owns its own stored position.
 */
const DOCK = `
<div id="aeia_dock" class="aeia-dock" hidden>
  <div class="aeia-dock-head" id="aeia_dock_head">
    <i class="fa-solid fa-right-left"></i>
    <span class="aeia-dock-title">Aeia</span>
    <span id="aeia_dock_state" class="aeia-dock-state">offline</span>
    <div id="aeia_dock_close" class="aeia-dock-x" title="Hide this panel">
      <i class="fa-solid fa-xmark"></i>
    </div>
  </div>
  <div id="aeia_dock_stage" class="aeia-dock-stage" hidden></div>
  <div class="aeia-dock-body">
    <div id="aeia_dock_open" class="menu_button" title="Open Aeia and send this chat to it">
      <i class="fa-solid fa-right-left"></i> Sync this chat
    </div>
    <div id="aeia_dock_resend" class="menu_button" title="Send this chat again">
      <i class="fa-solid fa-rotate"></i> Send again
    </div>
    <div id="aeia_dock_all" class="menu_button" title="Send every chat of every character">
      <i class="fa-solid fa-layer-group"></i> Whole library
    </div>
    <div id="aeia_dock_save" class="menu_button" title="Save this chat as .jsonl for Aeia">
      <i class="fa-solid fa-file-arrow-down"></i> Save file
    </div>
  </div>
</div>`;

/** Keep the panel on screen, whatever the window has done since it was placed. */
function clampDock(xPct, yPct) {
    const dock = document.getElementById('aeia_dock');
    const w = dock?.offsetWidth ?? 200;
    const h = dock?.offsetHeight ?? 120;
    // Leave the header reachable: it is the drag handle, so keeping it on
    // screen is the same as keeping the panel recoverable.
    const maxX = Math.max(0, 100 - (w / window.innerWidth) * 100);
    const maxY = Math.max(0, 100 - (h / window.innerHeight) * 100);
    return {
        x: Math.min(Math.max(0, Number(xPct) || 0), maxX),
        y: Math.min(Math.max(0, Number(yPct) || 0), maxY),
    };
}

function placeDock() {
    const config = settings();
    const at = clampDock(config.dockX, config.dockY);
    const dock = document.getElementById('aeia_dock');
    if (!dock) return;
    dock.style.left = `${at.x}%`;
    dock.style.top = `${at.y}%`;
}

/** Reflect the live connection in the panel's one word of status. */
function paintDockState() {
    const el = document.getElementById('aeia_dock_state');
    if (!el) return;
    const live = isAeiaLive();
    const how = mode === 'http' ? ' (app)' : '';
    el.textContent = live ? (ready ? `connected${how}` : 'connecting…') : 'offline';
    el.classList.toggle('is-live', !!(live && ready));
}

function setDockOpen(open) {
    settings().dockOpen = !!open;
    saveSettingsDebounced();
    const dock = document.getElementById('aeia_dock');
    if (dock) dock.hidden = !open;
    if (open) { placeDock(); paintDockState(); }
    $('#aeia_dock_toggle').toggleClass('is-on', !!open);
}

function wireDockDrag() {
    const head = document.getElementById('aeia_dock_head');
    const dock = document.getElementById('aeia_dock');
    if (!head || !dock) return;

    head.addEventListener('pointerdown', (e) => {
        // The close button is inside the handle; a press on it is not a drag.
        if (e.target.closest('#aeia_dock_close')) return;
        if (e.button !== 0) return;
        e.preventDefault();
        head.setPointerCapture?.(e.pointerId);

        const start = dock.getBoundingClientRect();
        const dx = e.clientX - start.left;
        const dy = e.clientY - start.top;

        const move = (ev) => {
            const at = clampDock(
                ((ev.clientX - dx) / window.innerWidth) * 100,
                ((ev.clientY - dy) / window.innerHeight) * 100,
            );
            dock.style.left = `${at.x}%`;
            dock.style.top = `${at.y}%`;
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
            // Written once, at the end — saving every frame would debounce-spam
            // SillyTavern's settings write for the whole length of a drag.
            const now = dock.getBoundingClientRect();
            settings().dockX = (now.left / window.innerWidth) * 100;
            settings().dockY = (now.top / window.innerHeight) * 100;
            saveSettingsDebounced();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
    });

    // A window that shrank under a panel placed on a bigger one.
    window.addEventListener('resize', placeDock);
}

const PANEL = `
<div class="aeia-bridge-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Aeia Bridge</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <small class="aeia-hint">
        Read and rewrite this chat in Aeia. Nothing is changed here without a preview and your approval.
      </small>

      <label for="aeia_url">Aeia address</label>
      <input id="aeia_url" type="text" class="text_pole" placeholder="http://localhost:3000">
      <small class="aeia-hint" id="aeia_host_hint"></small>

      <label for="aeia_token">App token <small>(only for the desktop Aeia)</small></label>
      <input id="aeia_token" type="password" class="text_pole" placeholder="from Aeia’s sync screen">
      <small class="aeia-hint">
        Leave this empty when Aeia runs in a browser tab. The desktop app shows an address and a
        token on its sync screen while that screen is open — paste both here.
      </small>

      <div class="aeia-row">
        <div id="aeia_open" class="menu_button" title="Open Aeia and send this chat to it">
          <i class="fa-solid fa-right-left"></i> Sync this chat
        </div>
        <div id="aeia_resend" class="menu_button" title="Send the chat again after changes here">
          <i class="fa-solid fa-rotate"></i> Send again
        </div>
      </div>
      <div class="aeia-row">
        <div id="aeia_all" class="menu_button" title="Send every chat of every character to Aeia. Your open chat is not disturbed.">
          <i class="fa-solid fa-layer-group"></i> Sync my whole library
        </div>
        <div id="aeia_dock_toggle" class="menu_button" title="Show a small panel you can leave open while you write">
          <i class="fa-solid fa-thumbtack"></i> Keep panel open
        </div>
      </div>

      <label class="checkbox_label" for="aeia_follow">
        <input id="aeia_follow" type="checkbox">
        <span>Send automatically when I switch chats</span>
      </label>

      <label class="checkbox_label" for="aeia_shape">
        <input id="aeia_shape" type="checkbox">
        <span>Shape the prompt before sending <small>(experimental)</small></span>
      </label>
      <small class="aeia-hint">
        Your pins and sheets are woven into the prompt SillyTavern assembled, where you chose to put
        them, before the model reads it. Costs milliseconds, no model calls. Configure what goes in
        on Aeia's own <b>endpoint</b> screen.
      </small>

      <label class="checkbox_label" for="aeia_preprocess">
        <input id="aeia_preprocess" type="checkbox">
        <span>Second pass on each reply <small>(experimental)</small></span>
      </label>
      <small class="aeia-hint">
        Each new reply goes to Aeia, which checks it against a few of your pins and sheets and may
        repair a sentence that contradicts one. The reply is yours the moment it arrives — a
        revision lands afterwards as a <b>new swipe</b>, with the original kept beside it. Costs a
        few model calls per reply, and needs Aeia open in the panel.
      </small>

      <hr>
      <small class="aeia-hint">If Aeia isn’t reachable from the browser, sync by file instead.</small>
      <div class="aeia-row">
        <div id="aeia_save" class="menu_button" title="Save this chat as .jsonl for Aeia">
          <i class="fa-solid fa-file-arrow-down"></i> Save for Aeia
        </div>
        <div id="aeia_load" class="menu_button" title="Apply a merged .jsonl from Aeia">
          <i class="fa-solid fa-file-arrow-up"></i> Apply merged file
        </div>
      </div>
      <input id="aeia_file" type="file" accept=".jsonl,.json" hidden>
    </div>
  </div>
</div>`;

/* ------------------------------------------------------------------ */

export async function init() {
    const config = settings();

    $('#extensions_settings2').append(PANEL);
    // Appended to the body, not the drawer: it has to outlive the drawer being
    // closed, which is the entire point of it.
    $('body').append(DOCK);
    wireDockDrag();
    /**
     * Say where Aeia will actually be framed, and where to read it.
     *
     * The address that matters is not the one typed here — it is the one after
     * `sameSiteUrl`, because a frame on a different host name than SillyTavern
     * is given its own storage and shows a library nobody else can see. Put the
     * real answer under the field rather than leaving it to be discovered by
     * syncing a chat into a shelf that turns out to be invisible.
     */
    const paintHostHint = () => {
        const asked = String(settings().aeiaUrl || '').trim();
        const used = sameSiteUrl(asked);
        const hint = $('#aeia_host_hint');
        if (!asked) { hint.text(''); return; }
        hint.html(used === asked
            ? `Read Aeia at <b>${used}</b> — the same address this frames, so it is the same library.`
            : `SillyTavern is on <b>${window.location.hostname}</b>, so this will frame `
              + `<b>${used}</b> instead. Open your Aeia tab there too — a different host name `
              + 'gets its own separate library, even on the same machine.');
    };
    $('#aeia_url').val(config.aeiaUrl).on('input', function () {
        settings().aeiaUrl = String($(this).val());
        saveSettingsDebounced();
        paintHostHint();
    });
    paintHostHint();
    $('#aeia_token').val(config.appToken).on('input', function () {
        settings().appToken = String($(this).val()).trim();
        saveSettingsDebounced();
    });
    $('#aeia_follow').prop('checked', config.followChat).on('change', function () {
        settings().followChat = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#aeia_shape').prop('checked', config.shapePrompts).on('change', function () {
        settings().shapePrompts = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#aeia_preprocess').prop('checked', config.preprocess).on('change', function () {
        const on = !!$(this).prop('checked');
        settings().preprocess = on;
        saveSettingsDebounced();
        if (!on) clearDraft();
        else if (mode === 'http') {
            say('The second pass needs Aeia open in the panel — it does not work with the '
                + 'desktop app yet.', 'warning');
        }
    });

    $('#aeia_open').on('click', () => {
        if (isAeiaLive() && ready) { sendChat(); showAeia(); return; }
        void connect();
    });
    $('#aeia_resend').on('click', () => {
        if (!isAeiaLive()) { say('Aeia isn’t open. Use “Sync this chat”.', 'warning'); return; }
        if (!ready) { say('Still waiting for Aeia to answer.', 'warning'); return; }
        sendChat();
    });

    const runAll = async ($button) => {
        if (!isAeiaLive() || !ready) {
            say('Open Aeia first with “Sync this chat”.', 'warning');
            return;
        }
        if ($button.hasClass('disabled')) return;
        $button.addClass('disabled');
        try {
            await syncAllChats();
        } finally {
            $button.removeClass('disabled');
        }
    };

    $('#aeia_all').on('click', function () { void runAll($(this)); });

    $('#aeia_dock_toggle').on('click', () => setDockOpen(!settings().dockOpen));
    $('#aeia_dock_close').on('click', () => setDockOpen(false));
    $('#aeia_dock_open').on('click', () => {
        if (isAeiaLive() && ready) { sendChat(); showAeia(); return; }
        void connect();
    });
    $('#aeia_dock_resend').on('click', () => {
        if (!isAeiaLive()) { say('Aeia isn’t open. Use “Sync this chat”.', 'warning'); return; }
        if (!ready) { say('Still waiting for Aeia to answer.', 'warning'); return; }
        sendChat();
    });
    $('#aeia_dock_all').on('click', function () { void runAll($(this)); });
    $('#aeia_dock_save').on('click', downloadChat);
    setDockOpen(config.dockOpen);

    $('#aeia_save').on('click', downloadChat);
    $('#aeia_load').on('click', () => $('#aeia_file').trigger('click'));
    $('#aeia_file').on('change', async function () {
        const file = this.files?.[0];
        // Cleared first: picking the same file twice in a row fires no change
        // event otherwise, and the second attempt looks like a dead button.
        $(this).val('');
        if (file) await loadMergedFile(file);
    });

    window.addEventListener('message', onMessage);

    eventSource.on(event_types.CHAT_CHANGED, () => {
        // A check in flight belongs to a chat that is no longer open. Its
        // answer would be refused on arrival anyway; dropping it here means the
        // status line does not sit there claiming to be working on something.
        clearDraft();
        if (!isAeiaLive()) { disconnect(); return; }
        if (ready && settings().followChat) sendChat();
    });

    /*
     * A reply has arrived. Hand it over, if the reader asked for that.
     *
     * `MESSAGE_RECEIVED` rather than `CHARACTER_MESSAGE_RENDERED`: both fire for
     * a finished generation (streaming included — the streaming path emits them
     * itself), and the earlier one starts the check a beat sooner without
     * changing what is on screen. `sendDraft` does its own filtering, so a user
     * turn or a system note that reaches here costs nothing.
     */
    /*
     * The prompt, on its way out.
     *
     * `CHAT_COMPLETION_PROMPT_READY` is emitted with the assembled `chat` array
     * and awaited, and the array it leaves behind is the one that gets sent —
     * which is what makes a browser Aeia able to shape a prompt at all.
     */
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, async (eventData) => {
        try {
            await shapePrompt(eventData);
        } catch (error) {
            // Never let this stop a generation. The unshaped prompt is a fine
            // prompt; it is the one SillyTavern was going to send anyway.
            console.error('[Aeia] could not shape the prompt', error);
        }
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => {
        try {
            sendDraft(messageId);
        } catch (error) {
            console.error('[Aeia] could not send the draft', error);
            clearDraft();
        }
    });

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'aeia',
        helpString: 'Open Aeia and send it the current chat.',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'save',
                description: 'save the chat as a file for Aeia instead of opening it',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'all',
                description: 'send every chat of every character, not just this one',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
            }),
        ],
        callback: async (args) => {
            if (String(args?.save).toLowerCase() === 'true') { downloadChat(); return ''; }
            if (String(args?.all).toLowerCase() === 'true') {
                if (!isAeiaLive() || !ready) {
                    say('Open Aeia first with “Sync this chat”.', 'warning');
                    return '';
                }
                await syncAllChats();
                return '';
            }
            if (isAeiaLive() && ready) sendChat();
            else await connect();
            return '';
        },
    }));

    console.log('[Aeia] bridge ready');
}
