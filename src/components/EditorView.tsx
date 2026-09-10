import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, Pencil, X } from 'lucide-react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { resolveContent } from '../utils/lens';
import { samplerParamsFrom } from '../utils/aiClient';
import { visitorBlock } from '../utils/visitor';
import { historyBefore, type Reactor } from '../utils/liveReaction';
import { editSpan, type SpanEdit } from '../utils/cowriter';
import { diffWords, isNoopChange } from '../utils/textDiff';
import { DiffMeter, DiffView } from './DiffView';
import { cn } from '../utils/cn';

/**
 * The editor's view: what they would actually do with these words.
 *
 * ── Why a span and not the passage ────────────────────────────────────────
 *
 * A note tells the author what is wrong. This shows the change — and a change
 * has to be JUDGED, which means it has to be small enough to read as a diff. A
 * model asked to improve a paragraph returns a different paragraph, and a diff
 * of a different paragraph is not a diff; it is an offer to swap one thing for
 * another. Asked to change eleven words, it changes eleven words, and the
 * author can see exactly what they are agreeing to.
 *
 * ── Why it applies as a Lens override ─────────────────────────────────────
 *
 * Because that is what every other edit in this app is. Accepting here does not
 * write to the story — it writes an override, the same layer the Lens uses, so
 * it can be switched off, seen in the Lens list, and exported or not exactly
 * like an edit the author made by hand. A second kind of edit would be a second
 * thing to explain and a second thing to get wrong.
 */
export const EditorView = ({ span, messageId, onClose }: {
  span: string;
  messageId: string;
  onClose: () => void;
}) => {
  const story = useAppStore(s => s.currentStory);
  const base = useAppStore(s => s.aiBaseUrl);
  const model = useAppStore(s => s.aiModel);
  const [edit, setEdit] = useState<SpanEdit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const v2 = useAuraV2Store;

  useEffect(() => {
    const app = useAppStore.getState();
    const s = app.currentStory;
    if (!s || !base || !model) { setError('Connect an AI endpoint first.'); return; }
    const msg = s.messages.find(m => m.id === messageId)
      ?? app.chains.flatMap(c => c.messages).find(m => m.id === messageId);
    if (!msg) { setError('That passage is not open any more.'); return; }

    const store = v2.getState();
    const passage = resolveContent(
      msg, store.overridesByStory[s.id], !!store.lensOnByStory[s.id],
    );

    // Same resolution as the companions next door.
    const picked = (app.cowriterWho || '').trim();
    const guest = (store.visitorsByStory[s.id] ?? [])
      .find(g => g.name.toLowerCase() === picked.toLowerCase());
    const name = picked || s.characterName || 'Your cowriter';
    const writer: Reactor = guest
      ? { name: guest.name, dossier: visitorBlock(guest, s.characterName), frame: 'room' }
      : {
        name,
        card: s.characterName && name.toLowerCase() === s.characterName.toLowerCase()
          ? s.card : undefined,
        frame: 'room',
      };

    const ordered = app.chains.flatMap(c => c.messages)
      .map(m => ({ id: m.id, name: m.name, content: m.content }));
    abort.current = new AbortController();
    void (async () => {
      try {
        const out = await editSpan(
          {
            reactor: writer,
            passage,
            span,
            targetId: messageId,
            history: historyBefore(ordered, messageId),
            userName: s.userName,
            pins: (store.pinsByStory[s.id] ?? [])
              .filter(p => p.inContext).slice(0, 4)
              .map(p => `${p.title}: ${p.content}`.slice(0, 300)),
          },
          { base, key: app.aiApiKey, model, params: samplerParamsFrom(app.aiAdvanced) },
          abort.current.signal,
        );
        if (!out) { setError('Nothing came back.'); return; }
        setEdit(out);
      } catch (e: any) {
        setError(String(e?.message ?? e));
      }
    })();
    return () => abort.current?.abort();
  }, [span, messageId, base, model, v2]);

  /**
   * Accept it.
   *
   * The span is replaced INSIDE the passage and the whole passage is stored as
   * the override, because an override is a whole message — there is no such
   * thing as overriding eleven words. `indexOf` rather than a regex: the span
   * came out of this text and goes back into the same place, and a regex would
   * have to escape it anyway.
   */
  const apply = () => {
    const app = useAppStore.getState();
    const s = app.currentStory;
    if (!s || !edit) return;
    const store = v2.getState();
    const msg = s.messages.find(m => m.id === messageId)
      ?? app.chains.flatMap(c => c.messages).find(m => m.id === messageId);
    if (!msg) return;
    const current = resolveContent(
      msg, store.overridesByStory[s.id], !!store.lensOnByStory[s.id],
    );
    const at = current.indexOf(span);
    if (at < 0) { setError('Those words have changed since — nothing was applied.'); return; }
    const next = current.slice(0, at) + edit.revised + current.slice(at + span.length);

    store.setOverride(s.id, {
      messageId,
      kind: 'rewrite',
      content: next,
      source: 'ai',
      note: edit.why || undefined,
      createdAt: Date.now(),
    });
    store.setLensOn(s.id, true);
    setApplied(true);
  };

  const parts = edit ? diffWords(span, edit.revised) : [];
  const noop = !!edit && isNoopChange(span, edit.revised);

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-xl max-h-[85vh] flex flex-col rounded-xl border
        border-app-border bg-app-surface shadow-2xl" data-testid="editor-view">
        <header className="flex items-center gap-2 px-4 py-3 border-b border-app-border">
          <Pencil size={15} className="text-amber-400" />
          <h2 className="font-medium text-app-text">Editor’s view</h2>
          <button onClick={onClose} aria-label="Close"
            className="ml-auto p-1 rounded hover:bg-app-bg text-app-muted">
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
          {!edit && !error && (
            <p className="flex items-center gap-2 text-sm text-muted">
              <Loader2 size={14} className="animate-spin" /> Looking at those words…
            </p>
          )}
          {error && <p className="text-sm text-rose-400" data-testid="editor-error">{error}</p>}

          {edit && (
            <>
              {noop ? (
                <p className="text-sm text-muted" data-testid="editor-noop">
                  They would leave it as it is.
                </p>
              ) : (
                <>
                  <DiffMeter parts={parts} />
                  <DiffView parts={parts} data-testid="editor-diff" />
                </>
              )}
              {edit.why && (
                <p className="text-[12px] text-muted border-l-2 border-amber-500/40 pl-2">
                  {edit.why}
                </p>
              )}
            </>
          )}
        </div>

        <footer className="flex items-center gap-2 px-4 py-3 border-t border-app-border">
          <span className="text-[11px] text-muted">
            {/* Said plainly, because the whole point of this screen is that the
              * author decides. */}
            Applying writes a Lens edit — reversible, and never the story itself.
          </span>
          <button
            onClick={apply}
            disabled={!edit || noop || applied}
            data-testid="editor-apply"
            className={cn(`ml-auto flex items-center gap-1.5 px-3 min-h-9 rounded-lg text-sm
              font-medium`,
            applied
              ? 'text-emerald-400'
              : 'bg-accent text-white disabled:opacity-40')}
          >
            <Check size={14} /> {applied ? 'Applied' : 'Apply'}
          </button>
        </footer>
      </div>
    </div>
  );
};
