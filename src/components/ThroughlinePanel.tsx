import React, { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown, ChevronUp, Loader2, Plus, Sparkles, Trash2, UserRound, X,
} from 'lucide-react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { useCompileArc } from '../hooks/useCompileArc';
import { getAllStoryMetas } from '../lib/storage';
import { cn } from '../utils/cn';
import {
  PROTAGONIST_FIELDS, PROTAGONIST_LABEL, arcsBefore, briefProgress, emptyProtagonist,
  isUsable, orderedArcs, throughlineBlock, throughlineFor,
} from '../utils/throughline';
import type { Throughline } from '../utils/throughline';
import type { StoryMeta } from '../types';

/**
 * Throughlines — the panel where a reader says who they are across their chats.
 *
 * The design decisions all live in `utils/throughline`; what is here is the
 * surface, and it has one job beyond editing: **show the payload**.
 *
 * That is not a nicety. The entire hallucination control for both this and the
 * visitor dossier is a person reading what will be sent before it is sent —
 * not a cleverer prompt. So the panel ends with the exact block, verbatim, and
 * a reader who does not like a line can fix it once and have it stay fixed.
 */

const newId = () => `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

const Field = ({ label, value, onChange, rows = 2, placeholder }: {
  label: string; value: string; onChange: (v: string) => void;
  rows?: number; placeholder?: string;
}) => (
  <label className="flex flex-col gap-1">
    <span className="text-[10px] uppercase tracking-widest opacity-50">{label}</span>
    <textarea
      value={value}
      rows={rows}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="bg-app-text/5 border border-app-border rounded-md px-2 py-1.5 text-sm outline-none focus:border-accent/50 resize-y"
    />
  </label>
);

export const ThroughlinePanel = ({ onClose }: { onClose: () => void }) => {
  const store = useAppStore();
  const v2 = useAuraV2Store();
  const storyId = store.currentStory?.id;
  const { compile, busy, error, clearError } = useCompileArc();

  const [metas, setMetas] = useState<StoryMeta[]>([]);
  useEffect(() => { void getAllStoryMetas().then(setMetas); }, []);

  /** The throughline this story is already part of, if any. */
  const mine = useMemo(
    () => throughlineFor(v2.throughlines, storyId),
    [v2.throughlines, storyId],
  );
  const [openId, setOpenId] = useState<string | null>(null);
  const active: Throughline | undefined =
    v2.throughlines.find(t => t.id === (openId ?? mine?.id)) ?? v2.throughlines[0];

  const [showPayload, setShowPayload] = useState(false);

  const create = () => {
    const t: Throughline = {
      id: newId(),
      name: store.currentStory?.userName || 'My throughline',
      // Seeded from the story's own persona: the reader has already told the
      // app who they are here, and asking again is asking twice.
      protagonist: emptyProtagonist(store.currentStory?.userName || ''),
      arcs: storyId && store.currentStory
        ? [{
          storyId,
          title: store.currentStory.title,
          order: 0,
          character: store.currentStory.characterName,
          brief: '',
          active: true,
        }]
        : [],
      createdAt: Date.now(),
    };
    v2.addThroughline(t);
    setOpenId(t.id);
  };

  const patchProtagonist = (patch: Partial<Throughline['protagonist']>) => {
    if (!active) return;
    v2.updateThroughline(active.id, { protagonist: { ...active.protagonist, ...patch } });
  };

  const runCompile = async (arcStoryId: string) => {
    if (!active) return;
    const brief = await compile(arcStoryId, active.protagonist);
    if (brief) v2.updateArc(active.id, arcStoryId, { brief, compiledAt: Date.now(), edited: false });
  };

  const aiReady = !!store.aiBaseUrl && !!store.aiModel;
  const inThroughline = new Set(v2.throughlines.flatMap(t => t.arcs.map(a => a.storyId)));

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="throughline-panel">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-app-border shrink-0">
        <UserRound size={15} className="text-accent shrink-0" />
        <div className="flex-1 min-w-0">
          <h2 className="font-bold text-sm leading-tight">Throughline</h2>
          <p className="text-[10px] opacity-60 leading-tight">
            One person, across several chats
          </p>
        </div>
        <button onClick={onClose} className="p-1 rounded hover:bg-app-text/10 opacity-70">
          <X size={15} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-4">
        {!v2.throughlines.length && (
          <div className="text-sm opacity-70 flex flex-col gap-3">
            <p>
              Every chat is one character and you. A throughline is the record of
              <em> you</em> — carried into each of them, in the order you lived them.
            </p>
            <p className="text-[11px] opacity-70">
              What travels between chats is a short written brief per story, never the
              transcript: a chat handed another chat’s raw text starts quoting it, and
              invents a shared history nobody had. You read and edit every brief before
              it is used.
            </p>
            <button
              onClick={create}
              data-testid="throughline-create"
              className="self-start flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-white text-xs font-medium hover:opacity-90"
            >
              <Plus size={13} /> Start one
            </button>
          </div>
        )}

        {v2.throughlines.length > 1 && (
          <select
            value={active?.id ?? ''}
            onChange={(e) => setOpenId(e.target.value)}
            className="bg-app-text/5 border border-app-border rounded-md px-2 py-1.5 text-sm outline-none"
          >
            {v2.throughlines.map(t => (
              <option key={t.id} value={t.id} className="text-black bg-white">{t.name}</option>
            ))}
          </select>
        )}

        {active && (
          <>
            {/* ── Who you are ───────────────────────────────────────────── */}
            <section className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-[10px] uppercase tracking-widest opacity-50">You</h3>
                <button
                  onClick={() => v2.removeThroughline(active.id)}
                  className="text-[10px] opacity-50 hover:opacity-100 hover:text-red-400"
                >
                  Delete throughline
                </button>
              </div>
              <input
                value={active.protagonist.name}
                onChange={(e) => patchProtagonist({ name: e.target.value })}
                placeholder="Your name in these stories"
                data-testid="throughline-name"
                className="bg-app-text/5 border border-app-border rounded-md px-2 py-1.5 text-sm outline-none focus:border-accent/50"
              />
              <input
                value={active.protagonist.aliases.join(', ')}
                onChange={(e) => patchProtagonist({
                  aliases: e.target.value.split(',').map(a => a.trim()).filter(Boolean),
                })}
                placeholder="Other names you go by, comma separated"
                className="bg-app-text/5 border border-app-border rounded-md px-2 py-1.5 text-xs outline-none focus:border-accent/50"
              />
              {PROTAGONIST_FIELDS.map(f => (
                <Field
                  key={f}
                  label={PROTAGONIST_LABEL[f]}
                  value={active.protagonist.fields[f]}
                  onChange={(v) => patchProtagonist({
                    fields: { ...active.protagonist.fields, [f]: v },
                  })}
                />
              ))}
              {!isUsable(active.protagonist) && (
                <p className="text-[11px] opacity-60">
                  A name and at least one line — until then nothing is sent.
                </p>
              )}
            </section>

            {/* ── The arcs, in order ────────────────────────────────────── */}
            <section className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-[10px] uppercase tracking-widest opacity-50">
                  Your stories, in order
                </h3>
                <span className="text-[10px] opacity-50 font-mono tabular-nums">
                  {briefProgress(active).done}/{briefProgress(active).total} written up
                </span>
              </div>
              <p className="text-[11px] opacity-60 -mt-1">
                The order is what decides what each one knows. A story is only ever told
                about the ones above it.
              </p>

              {orderedArcs(active).map((a, i) => (
                <div key={a.storyId} className="rounded-lg border border-app-border/60 p-2 flex flex-col gap-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[10px] opacity-40 tabular-nums w-4">{i + 1}</span>
                    <span className="flex-1 min-w-0 truncate text-sm" title={a.title}>
                      {a.title}
                      {a.character && <span className="opacity-50 text-xs"> · {a.character}</span>}
                      {a.storyId === storyId && (
                        <span className="ml-1.5 text-[9px] uppercase tracking-wider text-accent">here</span>
                      )}
                    </span>
                    <button
                      onClick={() => v2.reorderArc(active.id, a.storyId, -1)}
                      disabled={i === 0}
                      className="p-1 rounded hover:bg-app-text/10 disabled:opacity-25"
                      title="Earlier"
                    >
                      <ChevronUp size={12} />
                    </button>
                    <button
                      onClick={() => v2.reorderArc(active.id, a.storyId, 1)}
                      disabled={i === active.arcs.length - 1}
                      className="p-1 rounded hover:bg-app-text/10 disabled:opacity-25"
                      title="Later"
                    >
                      <ChevronDown size={12} />
                    </button>
                    <button
                      onClick={() => v2.removeArc(active.id, a.storyId)}
                      className="p-1 rounded hover:bg-app-text/10 opacity-50 hover:opacity-100 hover:text-red-400"
                      title="Remove from the throughline"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>

                  <textarea
                    value={a.brief}
                    rows={a.brief ? 4 : 2}
                    placeholder="What happened to you in this story…"
                    onChange={(e) => v2.updateArc(active.id, a.storyId, {
                      brief: e.target.value, edited: true,
                    })}
                    data-testid={`arc-brief-${a.storyId}`}
                    className="bg-app-text/5 border border-app-border rounded-md px-2 py-1.5 text-xs outline-none focus:border-accent/50 resize-y"
                  />

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => void runCompile(a.storyId)}
                      disabled={!aiReady || busy === a.storyId || !isUsable(active.protagonist)}
                      title={aiReady
                        ? 'Read the story and write this up'
                        : 'Needs an AI endpoint in Settings'}
                      className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] border border-app-border hover:bg-app-text/5 disabled:opacity-40"
                    >
                      {busy === a.storyId
                        ? <Loader2 size={11} className="animate-spin" />
                        : <Sparkles size={11} />}
                      {a.brief ? 'Rewrite' : 'Write it up'}
                    </button>
                    <label className="flex items-center gap-1.5 text-[11px] opacity-70 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={a.active}
                        onChange={(e) => v2.updateArc(active.id, a.storyId, { active: e.target.checked })}
                      />
                      Travels
                    </label>
                    {a.edited && <span className="text-[10px] opacity-40 ml-auto">edited</span>}
                  </div>
                </div>
              ))}

              {/* Add a story from the library. */}
              <select
                value=""
                onChange={(e) => {
                  const meta = metas.find(mm => mm.id === e.target.value);
                  if (!meta) return;
                  v2.addArc(active.id, {
                    storyId: meta.id,
                    title: meta.title,
                    order: active.arcs.length,
                    character: meta.characterName,
                    brief: '',
                    active: true,
                  });
                }}
                data-testid="throughline-add-arc"
                className="bg-app-text/5 border border-app-border rounded-md px-2 py-1.5 text-xs outline-none"
              >
                <option value="" className="text-black bg-white">Add a story…</option>
                {metas.filter(mm => !inThroughline.has(mm.id)).map(mm => (
                  <option key={mm.id} value={mm.id} className="text-black bg-white">
                    {mm.title}
                  </option>
                ))}
              </select>
            </section>

            {error && (
              <p className="text-[11px] text-red-400 flex items-start gap-2">
                <span className="flex-1">{error}</span>
                <button onClick={clearError} className="opacity-70 hover:opacity-100">dismiss</button>
              </p>
            )}

            {/* ── The payload, verbatim ─────────────────────────────────── *
              * The whole hallucination control for this feature is a person
              * reading what will be sent. So it is shown, exactly, and not
              * described. */}
            {storyId && (
              <section className="flex flex-col gap-1.5">
                <button
                  onClick={() => setShowPayload(v => !v)}
                  className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest opacity-50 hover:opacity-100 self-start"
                  data-testid="throughline-payload-toggle"
                >
                  {showPayload ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                  What this story will be told
                </button>
                {showPayload && (
                  <pre
                    data-testid="throughline-payload"
                    className={cn(
                      'text-[10px] leading-relaxed whitespace-pre-wrap font-mono',
                      'bg-app-text/5 border border-app-border rounded-md p-2 max-h-72 overflow-y-auto',
                    )}
                  >
                    {throughlineBlock(active, storyId, store.currentStory?.characterName)
                      || 'Nothing yet — this story is not in the throughline, or there is '
                        + 'nothing written about you.'}
                  </pre>
                )}
                <p className="text-[10px] opacity-50">
                  {arcsBefore(active, storyId).length} earlier{' '}
                  {arcsBefore(active, storyId).length === 1 ? 'story travels' : 'stories travel'}{' '}
                  into this one.
                </p>
              </section>
            )}
          </>
        )}

        {!!v2.throughlines.length && (
          <button
            onClick={create}
            className="self-start flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] opacity-60 hover:opacity-100"
          >
            <Plus size={11} /> Another throughline
          </button>
        )}
      </div>
    </div>
  );
};
