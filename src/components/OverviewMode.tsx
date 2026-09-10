import React from 'react';
import { useAppStore } from '../store';
import { cn } from '../utils/cn';
import { DndContext, closestCenter, KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Blend, GripVertical, PlayCircle, Settings, Star } from 'lucide-react';
import { Chain } from '../types';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { blendProblem, chainsFor, isStale } from '../utils/chatterBlend';
import { useChatterBlend } from '../hooks/useChatterBlend';
import { BlendModal } from './BlendModal';

interface SortableChainItemProps {
  chain: Chain;
  index: number;
}

/**
 * Which version of this passage is showing, and the button that makes another.
 *
 * The Overview is the right home for this because it is already the list of
 * passages — a switcher anywhere else would be a second place to think about
 * the shape of the story.
 *
 * "Original" is always first and always present. A reader who has made three
 * blends must be able to get back to what they actually wrote without deleting
 * anything, and it must be the obvious click rather than a menu item.
 */
const ChainVersions = ({ chain }: { chain: Chain }) => {
  const storyId = useAppStore(s => s.currentStory?.id);
  const aiReady = useAppStore(s => !!s.aiBaseUrl && !!s.aiModel);
  const lensChains = useAuraV2Store(s => (storyId ? s.lensChainsByStory[storyId] : undefined));
  const activeByChain = useAuraV2Store(s => (storyId ? s.activeLensChainByStory[storyId] : undefined));
  const setActiveLensChain = useAuraV2Store(s => s.setActiveLensChain);
  const removeLensChain = useAuraV2Store(s => s.removeLensChain);
  const { run, blend, reset } = useChatterBlend();
  const [open, setOpen] = React.useState(false);

  const versions = chainsFor(lensChains, chain.id);
  const activeId = activeByChain?.[chain.id];
  const problem = blendProblem(chain);

  const start = () => { setOpen(true); void blend(chain); };
  const close = () => { setOpen(false); reset(); };

  return (
    <>
      <div className="flex items-center flex-wrap gap-1.5 mt-2">
        {versions.length > 0 && (
          <>
            <button
              onClick={() => storyId && setActiveLensChain(storyId, chain.id, null)}
              className={cn(
                'text-[10px] px-1.5 py-0.5 rounded border transition-colors',
                !activeId ? 'border-accent bg-accent/10 text-accent' : 'border-app-border opacity-60 hover:opacity-100',
              )}
            >
              Original
            </button>
            {versions.map(v => {
              const stale = isStale(v, chain);
              return (
                <span key={v.id} className="flex items-center">
                  <button
                    onClick={() => storyId && setActiveLensChain(storyId, chain.id, v.id)}
                    title={stale
                      // Not deleted, and not silently swapped out: the reader
                      // may still want it, and throwing away work they asked
                      // for is not this feature's decision to make.
                      ? 'This passage has changed since this version was made.'
                      : undefined}
                    className={cn(
                      'text-[10px] px-1.5 py-0.5 rounded-l border transition-colors',
                      activeId === v.id
                        ? 'border-accent bg-accent/10 text-accent'
                        : 'border-app-border opacity-60 hover:opacity-100',
                      stale && 'italic',
                    )}
                  >
                    {v.label}{stale ? ' ·' : ''}
                  </button>
                  <button
                    onClick={() => storyId && removeLensChain(storyId, v.id)}
                    aria-label={`Delete ${v.label}`}
                    className="text-[10px] px-1 py-0.5 rounded-r border border-l-0 border-app-border opacity-40 hover:opacity-100 hover:text-red-500"
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </>
        )}
        <button
          onClick={start}
          disabled={!!problem || !aiReady}
          data-tour="blend-button"
          data-testid="blend-button"
          title={problem ?? (aiReady ? 'Weave this turn and its reply into one passage' : 'Connect an endpoint first')}
          className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-app-border opacity-60 hover:opacity-100 disabled:opacity-25 disabled:hover:opacity-25"
        >
          <Blend size={10} /> Blend
        </button>
      </div>

      {open && <BlendModal chain={chain} run={run} onRetry={() => void blend(chain)} onClose={close} />}
    </>
  );
};

const SortableChainItem = ({ chain, index }: SortableChainItemProps) => {
  const store = useAppStore();
  const storyId = useAppStore(s => s.currentStory?.id);
  const lensChains = useAuraV2Store(s => (storyId ? s.lensChainsByStory[storyId] : undefined));
  const activeByChain = useAuraV2Store(s => (storyId ? s.activeLensChainByStory[storyId] : undefined));
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: chain.id });
  const [showSettings, setShowSettings] = React.useState(false);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : 1,
  };

  /*
   * `chain.messages` is already the selected version.
   *
   * The substitution happens in `buildChains`, so the Overview, the reader, the
   * reveal and the exporters are all looking at one array. This used to resolve
   * it per-component and only here, which meant the switcher changed the
   * preview and the story you actually read was untouched.
   */
  const previewText = chain.messages.length > 0
    ? chain.messages[0].content.slice(0, 120)
    : 'Empty chain';

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'relative mb-4 rounded-xl border p-4 transition-colors',
        isDragging
          ? 'shadow-2xl ring-2 ring-accent bg-surface'
          : 'bg-app-text/5 border-transparent hover:border-app-border',
        chain.starred && 'border-yellow-500/50 bg-yellow-500/10',
      )}
    >
      <div className="flex items-start gap-4">
        <div
          {...attributes}
          {...listeners}
          aria-label="Reorder chain"
          className="mt-1 -ml-1 flex items-center justify-center min-h-11 min-w-11 shrink-0 touch-none cursor-grab active:cursor-grabbing opacity-50 hover:opacity-100"
        >
          <GripVertical size={20} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold uppercase tracking-wider text-muted">
              Chain {index + 1} • {chain.messages.length} message{chain.messages.length === 1 ? '' : 's'}
            </span>

            <div className="flex items-center gap-2">
              {chain.starred && (
                <button onClick={() => setShowSettings(!showSettings)} className="flex items-center justify-center min-h-10 min-w-10 opacity-50 hover:opacity-100" title="Star settings" aria-label="Star settings">
                  <Settings size={16} />
                </button>
              )}
              <button
                onClick={() => store.toggleStarChain(chain.id)}
                title="Star this chain"
                aria-label="Star this chain"
                className={cn('flex items-center justify-center min-h-10 min-w-10 transition-colors', chain.starred ? 'text-yellow-500' : 'opacity-30 hover:opacity-100')}
              >
                <Star size={18} fill={chain.starred ? 'currentColor' : 'none'} />
              </button>
              <button
                onClick={() => store.restreamFromId(chain.messages[0].id)}
                title="Play from here"
                aria-label="Play from here"
                className="flex items-center justify-center min-h-10 min-w-10 opacity-50 hover:opacity-100 text-accent"
              >
                <PlayCircle size={18} />
              </button>
            </div>
          </div>

          <p className="text-sm opacity-80 italic truncate">{previewText}…</p>

          <ChainVersions chain={chain} />

          {showSettings && chain.starred && (
            <div className="mt-4 p-3 rounded-lg bg-app-text/5 text-sm">
              <label className="block mb-2 text-xs font-bold uppercase text-muted">Custom Settings</label>
              <div className="flex items-center gap-4 flex-wrap">
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted">Speed</span>
                  <input
                    type="range" min="1" max="100"
                    value={chain.starSettings?.speed || store.playbackSpeed}
                    onChange={(e) => store.updateStarSettings(chain.id, { speed: Number(e.target.value) })}
                    className="w-24 accent-[var(--app-accent)]"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted">Animation</span>
                  <select
                    value={chain.starSettings?.animationStyle || store.animationStyle}
                    onChange={(e) => store.updateStarSettings(chain.id, { animationStyle: e.target.value as any })}
                    className="bg-transparent border border-app-border rounded px-1 py-0.5"
                  >
                    <option value="typewriter" className="text-black bg-white">Typing</option>
                    <option value="smooth" className="text-black bg-white">Smooth</option>
                    <option value="magic" className="text-black bg-white">Magic</option>
                    <option value="fade" className="text-black bg-white">Fade</option>
                  </select>
                </div>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={chain.starSettings?.zoom || false}
                    onChange={(e) => store.updateStarSettings(chain.id, { zoom: e.target.checked })}
                  />
                  <span className="text-xs text-muted">Soft Zoom Focus</span>
                </label>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export const OverviewMode = () => {
  const store = useAppStore();

  // A bare PointerSensor begins the drag on the first touch, which means a
  // finger laid on the handle to SCROLL the list starts reordering instead —
  // the list becomes unscrollable on a phone. Splitting mouse from touch is
  // dnd-kit's own answer: the mouse drags after a few pixels of travel, and
  // touch requires a short press-and-hold, so an ordinary scroll passes through.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = (event: any) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = store.chains.findIndex(c => c.id === active.id);
      const newIndex = store.chains.findIndex(c => c.id === over.id);
      store.reorderChains(arrayMove(store.chains, oldIndex, newIndex));
    }
  };

  return (
    <div
      className="flex-1 min-h-0 overflow-y-auto pb-40 px-4 pt-8 max-w-4xl mx-auto w-full"
      data-tour="overview-list"
    >
      <h2 className="text-2xl font-serif font-bold mb-2">Story Overview</h2>
      <p className="text-muted mb-8 text-sm">
        Drag to reorder chains. Star segments to give them custom animation and playback speed.
      </p>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={store.chains.map(c => c.id)} strategy={verticalListSortingStrategy}>
          {store.chains.map((chain, idx) => (
            <SortableChainItem key={chain.id} chain={chain} index={idx} />
          ))}
        </SortableContext>
      </DndContext>
    </div>
  );
};
