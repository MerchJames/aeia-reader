import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CornerUpLeft, Pencil, Phone, RefreshCw, Send, X } from 'lucide-react';
import type { LiveLine } from '../hooks/useLiveReaction';
import { renderInline } from '../utils/bookLayout';
import { cn } from '../utils/cn';

/**
 * One companion, and what they just said.
 *
 * Shared by the two of them. The reader's companions stack on the right and
 * react as the words land; the cowriter sits on the left and speaks after a
 * passage is finished. They are the same object on screen — a portrait, a line,
 * a way to answer it — and the only honest way to keep them the same is for
 * there to be one of these.
 */
const DWELL_MS = 16_000;
const DWELL_FROZEN_MS = 22_000;

export interface BubbleProps {
  line: LiveLine;
  frame: 'room' | 'phone';
  freeze: boolean;
  portrait?: string;
  onDismiss: () => void;
  onAgain: () => void;
  onReply: (text: string) => Promise<void>;
  /**
   * Which side of the page this belongs to, and therefore what it IS.
   *
   * A reader's companion is reacting to the words as they land; the cowriter is
   * looking at a finished passage as work. They want to be told apart at a
   * glance — the reader should never have to read a line to know which of the
   * two said it.
   */
  stance?: 'reader' | 'writer';
  /**
   * Stay until it is dismissed or the reader moves on.
   *
   * A reaction is a noise made at a moment and belongs to that moment, so it
   * fades. A note about the writing is something to ACT on — and it faded out
   * from under the author while they were still looking at the passage it was
   * about, which is the one thing it must not do.
   */
  sticky?: boolean;
}

export const CompanionBubble = React.memo(({
  line, frame, freeze, portrait, onDismiss, onAgain, onReply, stance = 'reader',
  sticky = false,
}: BubbleProps) => {
  const [shown, setShown] = useState(false);
  const [held, setHeld] = useState(false);
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setShown(true);
    // Talking to them holds it open: a bubble that faded while the reader was
    // typing into it would be the rudest possible version of this feature.
    if (sticky || held || replying || sending) return;
    const t = setTimeout(() => setShown(false), freeze ? DWELL_FROZEN_MS : DWELL_MS);
    return () => clearTimeout(t);
  }, [line, freeze, held, replying, sending, sticky]);

  useEffect(() => { if (replying) box.current?.focus(); }, [replying]);

  /*
   * Their line, typeset once.
   *
   * This component re-renders with the reveal — which is every animation frame
   * while a passage is streaming — and `renderInline` is a dozen regex passes
   * over the text. On the short rungs that is invisible; on `dynamic`, with
   * three bubbles of a paragraph each, it was running thirty-odd regexes per
   * frame against the story it was supposed to be sitting quietly beside.
   */
  const html = useMemo(() => renderInline(line.text), [line.text]);
  const exchangeHtml = useMemo(
    () => (line.exchange ?? []).map(t => (t.who === 'them' ? renderInline(t.text) : t.text)),
    [line.exchange],
  );

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setDraft('');
    try { await onReply(text); } finally { setSending(false); }
  };

  return (
    <div
      className={cn(
        'w-64 max-w-[80vw] pointer-events-auto transition-all duration-300',
        shown ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2 pointer-events-none',
      )}
      data-testid={stance === 'writer' ? 'cowriter-note' : 'live-reaction'}
      data-reactor={line.reactor}
      // The line is theirs, not the story's — say so to a screen reader too.
      role="status"
      aria-live="polite"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
    >
      <div className="flex items-end gap-2">
        {portrait
          ? (
            <img
              src={portrait}
              alt=""
              className="w-11 h-11 rounded-full object-cover border border-app-border shrink-0"
            />
          )
          : (
            <div className="w-11 h-11 rounded-full bg-accent/20 text-accent border border-app-border
              grid place-items-center text-sm font-semibold shrink-0">
              {line.reactor.slice(0, 1).toUpperCase()}
            </div>
          )}
        {/*
          * Bounded, and scrollable inside.
          *
          * A companion is supposed to be in the corner of the reader's eye. On
          * the `dynamic` rung one of them can produce a genuine paragraph, and
          * an unbounded bubble then grows up the page, past the top of the
          * window, and takes the story with it — the reader loses both the line
          * AND what it was about. So the bubble has a ceiling and keeps its own
          * scrollbar; a long reaction is still readable, it just cannot own the
          * screen.
          */}
        <div className={cn(`flex-1 min-w-0 rounded-2xl bg-surface border shadow-xl px-3 py-2
          max-h-[38vh] overflow-y-auto overscroll-contain`,
        stance === 'writer'
          ? 'rounded-br-sm border-amber-500/30'
          : 'rounded-bl-sm border-app-border')}>
          <div className="flex items-center gap-1.5 mb-0.5">
            {stance === 'writer'
              ? <Pencil size={11} className="text-amber-400 shrink-0" />
              : frame === 'phone' && <Phone size={11} className="text-accent shrink-0" />}
            <span className="text-[11px] font-medium text-muted truncate">{line.reactor}</span>
            <button
              onClick={() => setReplying(r => !r)}
              className={cn('ml-auto p-0.5 shrink-0 hover:opacity-100',
                replying ? 'opacity-100 text-accent' : 'opacity-40')}
              title="Say something back"
              aria-label={`Say something to ${line.reactor}`}
              data-testid="live-reaction-reply"
            >
              <CornerUpLeft size={11} />
            </button>
            <button
              onClick={onAgain}
              className="p-0.5 opacity-40 hover:opacity-100 shrink-0"
              title="Ask them again"
              aria-label={`Ask ${line.reactor} again`}
            >
              <RefreshCw size={11} />
            </button>
            <button
              onClick={onDismiss}
              className="p-0.5 opacity-40 hover:opacity-100 shrink-0"
              title="Dismiss"
              aria-label={`Dismiss ${line.reactor}`}
            >
              <X size={12} />
            </button>
          </div>
          {/*
            * Their words, set the way the story's words are.
            *
            * This used to render the raw string, on the reasoning that a stray
            * asterisk should stay an asterisk rather than restyle anything. But
            * companions write like the characters they are — `*i gasp*`, a line
            * of dialogue in quotes — and showing the marks instead of obeying
            * them made their speech the one text in the app that is not typeset.
            *
            * `renderInline` is the same inline pass Book, Stage and VN use. It
            * escapes first, so nothing in a model's reply can reach the page as
            * markup, and it is inline-only — no block for a stray character to
            * open.
            */}
          <p
            className="text-sm leading-snug whitespace-pre-wrap break-words"
            dangerouslySetInnerHTML={{ __html: html }}
          />
          {/* The conversation, if there is one. Their answers are typeset the
            * same way their reaction is; the reader's own words are not — those
            * are typed, not written. */}
          {line.exchange?.map((turn, i) => (
            <p
              key={i}
              className={cn('text-sm leading-snug mt-1.5 break-words',
                turn.who === 'reader'
                  ? 'text-muted italic border-l-2 border-app-border pl-2'
                  : 'whitespace-pre-wrap')}
              {...(turn.who === 'them'
                ? { dangerouslySetInnerHTML: { __html: exchangeHtml[i] } }
                : { children: turn.text })}
            />
          ))}
          {sending && (
            <p className="mt-1.5 text-[11px] text-muted/70 italic">
              {line.reactor} is thinking…
            </p>
          )}
          {replying && (
            <div className="mt-2 flex items-end gap-1">
              <textarea
                ref={box}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => {
                  // Enter sends; Shift+Enter is a new line. Escape gives up
                  // without dismissing what they said.
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
                  if (e.key === 'Escape') { e.preventDefault(); setReplying(false); }
                }}
                rows={2}
                placeholder={`Say something to ${line.reactor}…`}
                aria-label={`Reply to ${line.reactor}`}
                data-testid="live-reaction-draft"
                className="flex-1 min-w-0 resize-none rounded-lg bg-app-bg border border-app-border
                  px-2 py-1 text-sm outline-none focus:border-accent"
              />
              <button
                onClick={() => void send()}
                disabled={!draft.trim() || sending}
                className="p-1.5 rounded-lg text-accent hover:bg-accent/10 disabled:opacity-30"
                title="Send"
                aria-label="Send"
              >
                <Send size={13} />
              </button>
            </div>
          )}
          <p className="mt-1 text-[10px] text-muted/70 truncate" title={line.moment}>
            at “{line.moment}”
          </p>
        </div>
      </div>
    </div>
  );
}, (a, b) => (
  // The reveal re-renders the whole tree many times a second; a bubble whose
  // own line has not changed has nothing new to draw.
  a.line === b.line
  && a.frame === b.frame
  && a.freeze === b.freeze
  && a.portrait === b.portrait
  && a.stance === b.stance
  && a.sticky === b.sticky
));
CompanionBubble.displayName = 'CompanionBubble';

