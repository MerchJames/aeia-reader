import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, Loader2, MessageCircle, Send, Trash2, X } from 'lucide-react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { useSpriteStore, spriteFor } from '../stores/useSpriteStore';
import { samplerParamsFrom } from '../utils/aiClient';
import {
  AskTurn, OPENERS, askCharacter, castOf, clampHistory, hasAside, readThread, splitAnswer,
} from '../utils/askCharacter';
import { bucketFor, EmotionBucket } from '../lib/spriteStorage';
import { cn } from '../utils/cn';

/**
 * Ask {{char}} — a floating bubble that opens an interview with the character
 * about the beat currently on screen.
 *
 * ANCHORED, not free-floating. The thread belongs to a message: scroll back to
 * beat 12 and you find what you asked at beat 12, answered by someone who did
 * not yet know how it ends. That is the line between marginalia and a chatbot,
 * and it is why the character's knowledge is clamped by `clampHistory` rather
 * than by asking the model nicely not to spoil anything.
 *
 * The portrait is large while the thread is short and shrinks as the transcript
 * grows — a big sprite is right for one reaction and wrong for a conversation
 * you have to scroll.
 *
 * Nothing here is canon. These turns live in their own store slice and are read
 * by this component alone: never exported, never in the Lens, never fed back as
 * context to the Director, the summarizer or the assistant.
 */

interface Props {
  /** The beat being asked about — the interview is anchored to it. */
  messageId: string | undefined;
  /** The Director's mood for that beat, when there is one. */
  mood?: string;
}

const rid = () => `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/**
 * One answer, in the dialogue-only view: you see what she SAID, and the
 * business around it — the stage directions cards push the model toward —
 * fades in when you hover, exactly like the dialogue view in Phone Chat. The
 * eye toggle turns the whole behaviour off and shows every reply whole.
 */
const Answer = ({ text, dialogueOnly }: { text: string; dialogueOnly: boolean }) => {
  const [hover, setHover] = useState(false);
  const parts = useMemo(() => splitAnswer(text), [text]);
  const hiding = dialogueOnly && hasAside(text);
  const reveal = !hiding || hover;

  return (
    <p
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={hiding && !hover ? 'Hover to read the rest' : undefined}
      className={cn(
        'max-w-[92%] rounded-2xl rounded-bl-sm bg-app-bg/70 border px-3 py-2 text-sm',
        'text-app-text leading-relaxed whitespace-pre-wrap transition-colors',
        hiding ? 'border-dashed border-app-text/25' : 'border-app-text/10',
      )}
    >
      {parts.map((p, i) => {
        if (!p.aside) return <span key={i}>{p.text}</span>;
        // Genuinely not rendered while hidden. The first version collapsed the
        // span to zero font-size to avoid a reflow on hover, which left the
        // text in the DOM and — on a reply with nothing else to hide — made the
        // whole view button look dead.
        if (!reveal) return null;
        return <span key={i} className="italic text-app-text/45">{p.text}</span>;
      })}
    </p>
  );
};

export const AskCharacter = ({ messageId, mood }: Props) => {
  const store = useAppStore();
  const v2 = useAuraV2Store();
  const sprites = useSpriteStore(s => s.sprites);
  const spriteUrls = useSpriteStore(s => s.urls);

  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [spokenView, setSpokenView] = useState(true);
  const abort = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const story = store.currentStory;
  const storyId = story?.id;
  const aiReady = !!store.aiBaseUrl && !!store.aiModel;

  // A group chat has no single "the character". The cast comes from who
  // actually speaks, and the subject FOLLOWS the beat on screen — until the
  // reader picks someone, which sticks until they pick again.
  const cast = useMemo(
    () => castOf(store.chains.flatMap(c => c.messages), story?.userName),
    [store.chains, story?.userName],
  );
  const onScreen = store.streamingMessage?.name?.trim()
    ?? store.visibleMessages[store.visibleMessages.length - 1]?.name?.trim();
  const [pinnedSubject, setPinnedSubject] = useState<string | null>(null);
  const subject = (pinnedSubject && cast.includes(pinnedSubject) ? pinnedSubject : null)
    ?? (onScreen && cast.includes(onScreen) ? onScreen : null)
    ?? cast[0]
    ?? story?.characterName?.trim()
    ?? 'the character';
  const characterName = subject;
  const others = cast.filter(c => c !== subject);

  // ONE running conversation per story. The reader can ask at beat 40, travel to
  // beat 149 and ask the same question again with everything still in mind —
  // and because the knowledge clamp follows the CURRENT beat, the character
  // answers from where they now stand. That contrast is the point of it.
  const thread: AskTurn[] = useMemo(
    () => (storyId ? readThread(v2.askByStory[storyId]) : []),
    [storyId, v2.askByStory],
  );

  // The whole story in reading order — `clampHistory` is what makes it safe to
  // hand any of it to the model.
  const ordered = useMemo(
    () => store.chains.flatMap(c => c.messages).map(m => ({ id: m.id, name: m.name, content: m.content })),
    [store.chains],
  );

  /** Where the character's knowledge stops — shown to the reader, not just used. */
  const knownUpto = useMemo(() => {
    if (!messageId) return 0;
    const i = ordered.findIndex(m => m.id === messageId);
    return i < 0 ? 0 : i + 1;
  }, [ordered, messageId]);

  // The portrait reacts with the expression of the last answer, at no extra cost.
  const lastEmotion: EmotionBucket = useMemo(() => {
    for (let i = thread.length - 1; i >= 0; i--) {
      const t = thread[i];
      // Only THIS subject's own answers drive their portrait — in a group chat
      // the thread holds several voices.
      if (t.role === 'character' && (t.speaker ?? subject) === subject) return t.emotion ?? 'neutral';
    }
    return 'neutral';
  }, [thread, subject]);

  /** The beat the last exchange happened at, so the header can flag a jump. */
  const lastAskedBeat = thread.length ? thread[thread.length - 1].beat : undefined;

  const portrait = spriteFor(storyId, subject, lastEmotion, sprites, spriteUrls)
    ?? story?.characterAvatars?.[subject];

  useEffect(() => {
    if (open) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [thread.length, open, busy]);

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && open) setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const ask = useCallback(async (text: string) => {
    const q = text.trim();
    if (!q || !storyId || !messageId || busy) return;
    setError(null);
    setQuestion('');
    const lastBeat = thread.length ? thread[thread.length - 1].atMessageId : undefined;
    v2.addAskTurn(storyId, {
      id: rid(), role: 'reader', text: q, at: Date.now(),
      atMessageId: messageId, beat: knownUpto, speaker: subject,
    });
    setBusy(true);
    abort.current = new AbortController();
    try {
      const history = clampHistory(ordered, messageId);
      const anchor = ordered.find(m => m.id === messageId);
      const answer = await askCharacter(
        {
          characterName,
          cast: others,
          userName: story?.userName,
          card: story?.card,
          history,
          anchorText: anchor?.content ?? '',
          turns: thread,
          question: q,
          mood,
          movedOn: !!lastBeat && lastBeat !== messageId,
        },
        {
          base: store.aiBaseUrl, key: store.aiApiKey, model: store.aiModel,
          params: samplerParamsFrom(store.aiAdvanced),
        },
        abort.current.signal,
      );
      if (!answer) { setError('Nothing came back. Try asking again.'); return; }
      v2.addAskTurn(storyId, {
        id: rid(), role: 'character', text: answer.text, at: Date.now(),
        emotion: answer.emotion, atMessageId: messageId, beat: knownUpto, speaker: subject,
      });
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') setError((e as Error)?.message ?? 'That question failed.');
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storyId, messageId, busy, ordered, characterName, subject, others, mood, story, thread,
    knownUpto, store.aiBaseUrl, store.aiModel]);

  if (!store.askCharacter || !storyId || !messageId) return null;

  // The transcript grows into the portrait's space — a big portrait is right for
  // one reaction and wrong for a conversation you have to scroll. With no sprite
  // or avatar to show there is nothing to make room FOR, so it stays a header
  // rather than reserving half the panel for a gradient.
  const portraitH = !portrait ? 'h-16'
    : thread.length === 0 ? 'h-52'
    : thread.length <= 2 ? 'h-36'
    : 'h-20';

  return (
    <>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          data-testid="ask-character-bubble"
          title={`Ask ${characterName} about this beat`}
          className="fixed right-5 bottom-32 z-40 flex items-center gap-2 rounded-full border border-app-text/15
            bg-app-surface/95 backdrop-blur pl-1.5 pr-4 py-1.5 shadow-xl hover:border-accent/50 transition-colors group"
        >
          <span className="w-9 h-9 rounded-full overflow-hidden bg-app-bg border border-app-text/10 shrink-0 grid place-items-center">
            {portrait
              ? <img src={portrait} alt="" className="w-full h-full object-cover object-top" />
              : <MessageCircle size={16} className="text-accent" />}
          </span>
          <span className="text-sm text-app-text/80 group-hover:text-app-text">
            Ask {characterName}
          </span>
          {thread.length > 0 && (
            <span className="text-[10px] rounded-full bg-accent/15 text-accent px-1.5 py-0.5 border border-accent/25">
              {thread.filter(t => t.role === 'reader').length}
            </span>
          )}
        </button>
      )}

      {open && (
        <div
          data-testid="ask-character-panel"
          className="fixed right-5 bottom-32 z-40 w-[min(24rem,calc(100vw-2.5rem))] max-h-[min(34rem,70vh)]
            flex flex-col rounded-2xl border border-app-text/15 bg-app-surface/97 backdrop-blur shadow-2xl overflow-hidden"
        >
          {/* The portrait is the backdrop; the interview sits over it. */}
          <div className={cn('relative shrink-0 transition-all duration-500 overflow-hidden', portraitH)}>
            {portrait
              ? <img src={portrait} alt="" className="w-full h-full object-cover object-top" />
              : <div className="w-full h-full bg-gradient-to-b from-accent/20 to-transparent" />}
            <div className="absolute inset-0 bg-gradient-to-t from-app-surface via-app-surface/40 to-transparent" />
            <div className="absolute inset-x-0 bottom-0 px-4 pb-2 flex items-end justify-between gap-2">
              <div className="min-w-0">
                <div className="text-app-text font-semibold truncate">{characterName}</div>
                <div className="text-[10px] text-app-text/50">
                  knows the story through beat {knownUpto} — not a word past it
                  {thread.length > 0 && lastAskedBeat != null && lastAskedBeat !== knownUpto && (
                    <span className="text-accent"> · you’ve moved on since you last asked</span>
                  )}
                </div>
              </div>
            </div>
            <div className="absolute top-2 right-2 flex gap-1">
              <button
                onClick={() => setSpokenView(v => !v)}
                aria-pressed={spokenView}
                title={spokenView
                  ? 'Dialogue only — hover a reply to see the actions. Click to show every reply whole.'
                  : 'Showing every reply whole. Click for dialogue only.'}
                data-testid="ask-spoken-toggle"
                className="p-1.5 rounded-lg bg-app-bg/70 text-app-text/60 hover:text-app-text backdrop-blur"
              >
                {spokenView ? <Eye size={14} /> : <EyeOff size={14} />}
              </button>
              {thread.length > 0 && (
                <button
                  onClick={() => { abort.current?.abort(); v2.clearAskThread(storyId); }}
                  title="Discard this interview"
                  className="p-1.5 rounded-lg bg-app-bg/70 text-app-text/60 hover:text-red-400 backdrop-blur"
                >
                  <Trash2 size={14} />
                </button>
              )}
              <button
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="p-1.5 rounded-lg bg-app-bg/70 text-app-text/60 hover:text-app-text backdrop-blur"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          {cast.length > 1 && (
            <div className="shrink-0 flex items-center gap-1 px-3 py-1.5 border-b border-app-text/10
              overflow-x-auto" data-testid="ask-cast">
              {cast.map(name => {
                const face = spriteFor(storyId, name, 'neutral', sprites, spriteUrls)
                  ?? story?.characterAvatars?.[name];
                const active = name === subject;
                return (
                  <button
                    key={name}
                    onClick={() => setPinnedSubject(name)}
                    data-testid={`ask-cast-${name}`}
                    title={active ? `Interviewing ${name}` : `Ask ${name} instead — they can see what has been said`}
                    className={cn(
                      'flex items-center gap-1.5 rounded-full pl-1 pr-2.5 py-0.5 text-xs border shrink-0 transition-colors',
                      active
                        ? 'border-accent/50 bg-accent/10 text-app-text'
                        : 'border-transparent text-app-text/45 hover:text-app-text/80',
                    )}
                  >
                    <span className="w-5 h-5 rounded-full overflow-hidden bg-app-bg border border-app-text/10 grid place-items-center text-[9px]">
                      {face ? <img src={face} alt="" className="w-full h-full object-cover object-top" /> : name[0]}
                    </span>
                    {name}
                  </button>
                );
              })}
              {pinnedSubject && (
                <button
                  onClick={() => setPinnedSubject(null)}
                  title="Follow whoever is on screen again"
                  className="ml-auto text-[10px] text-app-text/40 hover:text-app-text/70 shrink-0 px-1"
                >
                  follow the scene
                </button>
              )}
            </div>
          )}

          <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
            {thread.length === 0 && !busy && (
              <div className="space-y-2">
                <p className="text-xs text-app-text/45 leading-relaxed">
                  You’re the interviewer. Nothing said here becomes part of the story.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {OPENERS.map(o => (
                    <button
                      key={o}
                      onClick={() => void ask(o)}
                      disabled={!aiReady}
                      className="text-[11px] rounded-full border border-app-text/15 px-2.5 py-1 text-app-text/65
                        hover:border-accent/50 hover:text-app-text disabled:opacity-40"
                    >
                      {o}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {thread.map((t, i) => (
              <div key={t.id}>
                {/* Where this exchange happened. The thread runs across the whole
                  * story, so a divider marks the moment the reader travelled —
                  * asking the same question at beat 40 and beat 149 is the
                  * feature, and you have to be able to see which is which. */}
                {t.beat != null && t.beat !== thread[i - 1]?.beat && (
                  <div className="flex items-center gap-2 my-2 text-[10px] uppercase tracking-wide text-app-text/30">
                    <span className="h-px flex-1 bg-app-text/10" />
                    {i === 0 ? `beat ${t.beat}` : `now at beat ${t.beat}`}
                    <span className="h-px flex-1 bg-app-text/10" />
                  </div>
                )}
                {t.role === 'reader' ? (
                  <div className="flex justify-end">
                    <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-accent/12 border border-accent/20
                      px-3 py-1.5 text-sm text-app-text/85 whitespace-pre-wrap">{t.text}</p>
                  </div>
                ) : (
                  <div className="flex flex-col items-start gap-0.5">
                    {/* Who said it. Only shown once several voices are in the
                      * thread, since in a solo interview it is just noise. */}
                    {cast.length > 1 && t.speaker && (
                      <span className="text-[10px] uppercase tracking-wide text-app-text/35 pl-1">
                        {t.speaker}
                      </span>
                    )}
                    <Answer text={t.text} dialogueOnly={spokenView} />
                  </div>
                )}
              </div>
            ))}

            {busy && (
              <div className="flex items-center gap-2 text-xs text-app-text/45">
                <Loader2 size={13} className="animate-spin" /> {characterName} is thinking about it…
              </div>
            )}
            {error && <p className="text-xs text-red-400">{error}</p>}
            {!aiReady && (
              <p className="text-xs text-app-text/45">Connect an AI endpoint in Settings to ask anything.</p>
            )}
          </div>

          <form
            onSubmit={e => { e.preventDefault(); void ask(question); }}
            className="shrink-0 flex items-center gap-2 border-t border-app-text/10 px-3 py-2"
          >
            <input
              value={question}
              onChange={e => setQuestion(e.target.value)}
              placeholder={`Ask ${characterName}…`}
              disabled={!aiReady || busy}
              data-testid="ask-character-input"
              className="flex-1 bg-transparent text-sm text-app-text placeholder:text-app-text/35 outline-none disabled:opacity-50"
            />
            {busy ? (
              <button type="button" onClick={() => abort.current?.abort()}
                className="text-xs text-app-text/50 hover:text-red-400">Stop</button>
            ) : (
              <button type="submit" disabled={!aiReady || !question.trim()}
                aria-label="Ask" className="text-accent disabled:opacity-30">
                <Send size={16} />
              </button>
            )}
          </form>
        </div>
      )}
    </>
  );
};
