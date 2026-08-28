/**
 * Visiting characters.
 *
 * Bring someone in from another chat, so this story can react to them.
 *
 * The thing this screen exists for is the middle step: after the brief is
 * generated and before it is ever used, you READ it. That is the entire
 * hallucination control — a person looking at the payload — and it is why the
 * dossier is a set of labelled boxes rather than a blob of prose. Every line
 * the host will be told is a line you can correct, and it stays corrected.
 *
 * Not the Lens. The Lens rewrites messages that exist; a visitor assembles
 * context for a generation that has not happened yet. It lives beside Context
 * Zones because that is what it is.
 */

import { useEffect, useState } from 'react';
import { Loader2, Plus, Trash2, UserPlus } from 'lucide-react';
import { useInviteVisitor } from '../hooks/useInviteVisitor';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { getAllStoryMetas, getStory } from '../lib/storage';
import { chatCompletion, mergeSamplers, samplerParamsFrom } from '../utils/aiClient';
import {
  DOSSIER_FIELDS, FIELD_LABEL, historyFrom, isUsable, type DossierScope,
  type DossierField, type Visitor,
} from '../utils/visitor';
import type { CardInfo, StoryMeta } from '../types';


const newId = () => `vis-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

const field = 'w-full bg-app-text/5 border border-app-border rounded-md px-2 py-1.5 min-h-11 text-sm outline-none focus:border-accent/50';

/** One dossier, open for reading and correcting. */
const VisitorCard = ({ visitor, storyId, onSpeak, busy }: {
  visitor: Visitor;
  storyId: string;
  /** Have them write one turn into the chat. Absent where there is no chat to
   *  write into — the panel is also rendered from Settings. */
  onSpeak?: (visitor: Visitor, instruction?: string) => void;
  busy?: boolean;
}) => {
  const update = useAuraV2Store(s => s.updateVisitor);
  const remove = useAuraV2Store(s => s.removeVisitor);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  // The lender's card, fetched lazily — it is how they SOUND, and the brief
  // alone produced characters who were factually right and generically voiced.
  const [card, setCard] = useState<CardInfo | undefined>();
  useEffect(() => {
    void getStory(visitor.sourceStoryId).then(st => setCard(st?.card));
  }, [visitor.sourceStoryId]);

  const value = (f: DossierField) => draft?.[f] ?? visitor.fields[f] ?? '';
  const commit = () => {
    if (!draft) return;
    update(storyId, visitor.id, {
      fields: { ...visitor.fields, ...draft } as Record<DossierField, string>,
      edited: true,
    });
    setDraft(null);
  };

  return (
    <div className="rounded-xl border border-app-border/70" data-testid="visitor-card">
      <div className="flex items-center gap-2 p-2">
        <input
          type="checkbox"
          checked={visitor.active}
          onChange={e => update(storyId, visitor.id, { active: e.target.checked })}
          aria-label={`Include ${visitor.name} in context`}
          data-testid="visitor-active"
          className="w-4 h-4 accent-current shrink-0"
        />
        <button
          onClick={() => setOpen(o => !o)}
          className="flex-1 min-w-0 text-left"
          data-testid="visitor-open"
        >
          <div className="text-sm truncate">{visitor.name}</div>
          <div className="text-[11px] text-muted truncate">
            {visitor.sourceStoryTitle} · as of message {visitor.anchorBeat}
            {visitor.edited ? ' · edited' : ''}
          </div>
        </button>
        {onSpeak && (
          <button
            onClick={() => onSpeak(visitor)}
            disabled={!!busy || !isUsable(visitor.fields)}
            title={isUsable(visitor.fields)
              ? `Have ${visitor.name} write one turn into the chat. It stays a draft — nothing is written into the story.`
              : 'Their brief is too thin to write from yet'}
            data-testid="visitor-speak"
            className="text-[11px] px-2 py-1 rounded-md border border-app-border hover:bg-app-text/5 disabled:opacity-40 shrink-0"
          >
            Take a turn
          </button>
        )}
        <button
          onClick={() => remove(storyId, visitor.id)}
          aria-label={`Remove ${visitor.name}`}
          className="flex items-center justify-center min-h-11 min-w-11 rounded-lg text-app-text/40 hover:text-red-500 hover:bg-red-500/10 shrink-0"
        >
          <Trash2 size={14} />
        </button>
      </div>

      {open && (
        <div className="px-2 pb-2 flex flex-col gap-2 border-t border-app-border/60 pt-2">
          <p className="text-[11px] text-muted leading-snug">
            This is everything <strong>{visitor.name}</strong> brings with them. Nothing else from
            their story is sent. If a line is wrong, fix it — the model reads exactly this.
          </p>
          {DOSSIER_FIELDS.map(f => (
            <label key={f} className="block">
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted">
                {FIELD_LABEL[f]}
                {f === 'doesNotKnow' && (
                  <span className="normal-case tracking-normal font-normal opacity-70">
                    {' '}— the line that stops a shared history being invented
                  </span>
                )}
              </span>
              <textarea
                value={value(f)}
                rows={f === 'who' || f === 'knows' || f === 'doesNotKnow' ? 3 : 2}
                onChange={e => setDraft({ ...(draft ?? {}), [f]: e.target.value })}
                onBlur={commit}
                data-testid={`visitor-field-${f}`}
                className={`${field} mt-1 resize-y`}
              />
            </label>
          ))}

          {visitor.quotes.length > 0 && (
            <div>
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted">
                Things they have said
              </span>
              <ul className="text-[11px] text-muted list-disc pl-4 mt-1">
                {visitor.quotes.map((q, i) => <li key={i}>“{q}”</li>)}
              </ul>
            </div>
          )}

          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={visitor.met}
              onChange={e => update(storyId, visitor.id, { met: e.target.checked, edited: true })}
              data-testid="visitor-met"
              className="w-4 h-4 accent-current"
            />
            <span>They have met the characters in this story before</span>
          </label>
          <p className="text-[11px] text-muted leading-snug">
            Left unticked, the brief states outright that they have never met and that there is no
            shared history — which is the single line that stops one being invented.
          </p>

          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-wider text-muted">
              How they come in
            </span>
            <textarea
              value={visitor.entrance ?? ''}
              rows={2}
              placeholder="she comes in out of the rain and does not sit down"
              onChange={e => update(storyId, visitor.id, { entrance: e.target.value })}
              data-testid="visitor-entrance"
              className={`${field} mt-1 resize-y`}
            />
            <span className="text-[11px] text-muted leading-snug block mt-1">
              Used every time they take a turn. Kept here rather than typed each
              time — an entrance that changes every turn is a different character.
            </span>
          </label>

          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={visitor.useCard !== false}
              onChange={e => update(storyId, visitor.id, { useCard: e.target.checked })}
              data-testid="visitor-use-card"
              className="w-4 h-4 accent-current mt-0.5 shrink-0"
            />
            <span>
              Send their character card when they speak
              {card ? '' : ' (their story has none)'}
              <span className="block text-[11px] text-muted leading-snug mt-0.5">
                The brief is what they KNOW; the card is how they SOUND. Without it
                they come out factually right and generically voiced. The brief still
                wins wherever the two disagree about events.
              </span>
            </span>
          </label>

          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-wider text-muted">
              Your own note
            </span>
            <textarea
              value={visitor.note ?? ''}
              rows={2}
              placeholder="anything the brief missed, or got wrong"
              onChange={e => update(storyId, visitor.id, { note: e.target.value })}
              data-testid="visitor-note"
              className={`${field} mt-1 resize-y`}
            />
          </label>
        </div>
      )}
    </div>
  );
};

/** Pick a story, pick a character, pick a beat, generate. */
const AddVisitor = ({ storyId, onDone }: { storyId: string; onDone: () => void }) => {
  const store = useAppStore();
  const addVisitor = useAuraV2Store(s => s.addVisitor);

  const [metas, setMetas] = useState<StoryMeta[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [character, setCharacter] = useState('');
  const [beat, setBeat] = useState(1);
  const [cast, setCast] = useState<string[]>([]);
  const [count, setCount] = useState(0);
  const [scope, setScope] = useState<DossierScope>('spread');
  const { invite, busy, progress, error } = useInviteVisitor();

  useEffect(() => {
    void getAllStoryMetas().then(list => setMetas(list.filter(m => m.id !== storyId)));
  }, [storyId]);

  // Loading the chosen story tells us who is in it and how long it is — both
  // needed before the reader can pick a character and an anchor.
  useEffect(() => {
    if (!sourceId) { setCast([]); setCount(0); return; }
    void getStory(sourceId).then(story => {
      if (!story) return;
      const visible = historyFrom(story.messages);
      setCount(visible.length);
      setBeat(visible.length);
      const names = [...new Set(visible.map(m => m.name).filter(Boolean))];
      setCast(names);
      setCharacter(story.characterName || names[0] || '');
    });
  }, [sourceId]);

  // The generation itself lives in `useInviteVisitor`, shared with the invite
  // sheet in the cast strips — one clamp, one record shape, one place to fix.
  const generate = async () => {
    if (!sourceId || !character) return;
    if (await invite({ sourceId, character, beat, scope })) onDone();
  };

  return (
    <div className="rounded-xl border border-app-border/70 p-2 flex flex-col gap-2" data-testid="add-visitor">
      <label className="block">
        <span className="text-[10px] font-bold uppercase tracking-wider text-muted">From which story</span>
        <select
          value={sourceId}
          onChange={e => setSourceId(e.target.value)}
          data-testid="visitor-source"
          className={`${field} mt-1`}
        >
          <option value="">— choose —</option>
          {metas.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}
        </select>
      </label>

      {cast.length > 0 && (
        <>
          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-wider text-muted">Who</span>
            <select
              value={character}
              onChange={e => setCharacter(e.target.value)}
              data-testid="visitor-character"
              className={`${field} mt-1`}
            >
              {cast.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>

          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-wider text-muted">
              As of message {beat} of {count}
            </span>
            <input
              type="range"
              min={1}
              max={Math.max(1, count)}
              value={beat}
              onChange={e => setBeat(Number(e.target.value))}
              data-testid="visitor-beat"
              className="w-full accent-current mt-1"
            />
          </label>
          <p className="text-[11px] text-muted leading-snug">
            They arrive knowing their story only up to this point — nothing past it. Drag back to
            bring in an earlier version of them.
          </p>

          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-wider text-muted">
              How much of their story to read
            </span>
            <select
              value={scope}
              onChange={e => setScope(e.target.value as DossierScope)}
              data-testid="visitor-scope"
              className="w-full mt-1 bg-app-text/5 border border-app-border rounded-md px-2 min-h-10 text-xs"
            >
              <option value="spread">Their whole story, sampled</option>
              <option value="recent">Just where they are now</option>
              <option value="whole">Read all of it (several calls)</option>
            </select>
          </label>
          {/* The reason this control exists, said plainly — a reader who does
            * not know the default was the TAIL cannot know why their visitor
            * came out as a single mood. */}
          <p className="text-[11px] text-muted leading-snug">
            A brief written from the last few messages of a long chat reads as a
            caricature — whatever they happened to be feeling at the end. Sampling
            spreads the reading across the whole story for the same cost.
          </p>
        </>
      )}

      {error && <p className="text-[11px] text-amber-400/90 leading-snug" data-testid="visitor-error">{error}</p>}

      <div className="flex items-center gap-2">
        <button
          onClick={() => void generate()}
          disabled={!sourceId || !character || busy}
          data-testid="visitor-generate"
          className="flex items-center justify-center gap-2 px-3 min-h-11 flex-1 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-50"
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <UserPlus size={15} />}
          {busy
            ? (progress ? `Reading their story… ${progress.done}/${progress.total}` : 'Writing their brief…')
            : 'Bring them in'}
        </button>
        <button
          onClick={onDone}
          className="px-3 min-h-11 rounded-lg border border-app-border text-sm hover:bg-app-text/5"
        >
          Cancel
        </button>
      </div>
    </div>
  );
};

export const VisitorPanel = ({ onSpeak, busy }: {
  /** Wired from the chat panel, where a generated turn has somewhere to land. */
  onSpeak?: (visitor: Visitor, instruction?: string) => void;
  busy?: boolean;
} = {}) => {
  const storyId = useAppStore(s => s.currentStory?.id);
  const aiReady = useAppStore(s => !!s.aiBaseUrl && !!s.aiModel);
  const visitors = useAuraV2Store(s => (storyId ? s.visitorsByStory[storyId] : undefined));
  const [adding, setAdding] = useState(false);

  if (!storyId) return null;
  const list = visitors ?? [];
  const active = list.filter(v => v.active && isUsable(v.fields)).length;

  return (
    <div className="flex flex-col gap-2" data-testid="visitor-panel">
      <p className="text-[11px] text-muted leading-snug">
        Characters from your other chats, brought in as a short brief so this story can react to
        them. Their transcripts are never sent — only what you can see and edit here.
      </p>
      {list.length > 0 && (
        <p className="text-[11px] text-muted leading-snug">
          {onSpeak
            ? <>
                <strong>Take a turn</strong> has one of them write into this chat — a draft, like
                any other, that never touches the story. To ask them something instead, open{' '}
                <strong>Ask {'{char}'}</strong>: they appear in its cast and answer from this brief.
              </>
            : <>
                To hear one of them speak, open <strong>Ask {'{char}'}</strong> — they appear in its
                cast, and answer from this brief.
              </>}
        </p>
      )}

      {list.map(v => (
        <VisitorCard key={v.id} visitor={v} storyId={storyId} onSpeak={onSpeak} busy={busy} />
      ))}

      {adding ? (
        <AddVisitor storyId={storyId} onDone={() => setAdding(false)} />
      ) : (
        <button
          onClick={() => setAdding(true)}
          disabled={!aiReady}
          data-testid="visitor-add"
          className="flex items-center gap-2 p-2 min-h-11 rounded-lg hover:bg-app-text/5 transition-colors text-sm disabled:opacity-40"
        >
          <Plus size={16} /> Bring in a character…
        </button>
      )}

      {!aiReady && (
        <p className="text-[11px] text-muted">Set an AI endpoint to write a brief.</p>
      )}
      {list.length > 0 && (
        <p className="text-[11px] text-muted">
          {active} of {list.length} in context.
        </p>
      )}
    </div>
  );
};


