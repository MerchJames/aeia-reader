/**
 * Several chats at once, as a map you can link across.
 *
 * The Multiverse next door maps ONE story's branches. This is the other axis:
 * two, three, four separate chats side by side, and the reader drawing a line
 * from a moment in one to a moment in another — then talking to the assistant
 * about what that line means.
 *
 * ── Why this is a canvas and not two columns ───────────────────────────────
 *
 * It was two columns, and each held every message of its story as a full-width
 * block of prose. Four stories of two hundred messages is eight hundred
 * paragraphs stacked in four narrow tubes: the only way to reach the beat you
 * had in mind was to read down to it, so a feature about linking two moments
 * spent all of its interaction budget on FINDING one.
 *
 * A node is now a card you can take in at a glance — index, speaker, one line —
 * and the canvas pans and zooms, so a story has a SHAPE rather than a scroll
 * position. What a node cannot show, hovering it does: the passage in full,
 * in a panel that does not move while you read it.
 *
 * ── Why xyflow ────────────────────────────────────────────────────────────
 *
 * The Multiverse already uses it, so this is one graph library rather than two,
 * and both are lazily loaded so a reader who opens neither pays for neither.
 * It also brings the interaction this board is FOR: dragging from one node's
 * handle to another is a connection gesture the library already understands,
 * including the live line that follows the pointer across a panning canvas —
 * which was two hundred lines of hand-measured SVG here before.
 *
 * ── The drop asks what it meant ───────────────────────────────────────────
 *
 * Finishing a drag opens the kind picker where you dropped it. The old board
 * made the link first and asked afterwards in a side panel, so every link was
 * born as "Bring them in" and stayed that way unless the reader went and
 * changed it. The kinds are the whole point — the assistant is told something
 * different for each — so the question belongs at the moment you are still
 * thinking about the two passages.
 *
 * Which passages get drawn is `utils/crossingBoard`, and it is deliberately not
 * "all of them"; the rule it will not bend is that a linked passage is always
 * on screen, because an edge with an undrawn end cannot be drawn at all.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background, BackgroundVariant, Connection, Controls, Edge, Handle, MiniMap,
  Node, NodeProps, Position, ReactFlow, useReactFlow, ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Link2, Loader2, MessageSquare, Plus, Search, Trash2, X,
} from 'lucide-react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { getStory } from '../lib/storage';
import { askText } from '../utils/aiCall';
import {
  CROSSING_KINDS, buildCrossingMessages, crossingProblem, crossingsBetween, excerptOf,
  isDuplicate, kindDef, makeCrossing, suggestedStories,
  type CrossPoint, type Crossing, type CrossingKind,
} from '../utils/crossing';
import {
  LANE_WIDTH, NODE_HEIGHT, gapIndices, laneX, layoutBoard, rowY,
  type BoardGap, type BoardRow,
} from '../utils/crossingBoard';
import type { Message, Story } from '../types';
import { cn } from '../utils/cn';

/** Columns past this and each is too narrow to read a passage in. */
const MAX_COLUMNS = 4;

/* ------------------------------------------------------------------ */
/* Nodes                                                               */
/* ------------------------------------------------------------------ */

interface PassageData extends Record<string, unknown> {
  storyId: string;
  storyTitle: string;
  index: number;
  name: string;
  preview: string;
  linked: boolean;
  hit: boolean;
}

interface LaneData extends Record<string, unknown> {
  storyId: string;
  title: string;
  total: number;
  hidden: number;
  query: string;
  onQuery: (q: string) => void;
  onRemove?: () => void;
}

interface GapData extends Record<string, unknown> {
  storyId: string;
  gap: BoardGap;
  onOpen: () => void;
}

type PassageNode = Node<PassageData, 'passage'>;
type LaneNode = Node<LaneData, 'lane'>;
type GapNode = Node<GapData, 'gap'>;
type BoardNode = PassageNode | LaneNode | GapNode;

/**
 * One passage.
 *
 * Both handles are on both sides, and both are always visible rather than
 * appearing on hover: the gesture this board exists for is dragging from one of
 * these to another, and a handle you have to discover by hovering is a gesture
 * most readers never find. Sized so a lane of them reads as a column of beats.
 */
const PassageNodeView = ({ data, selected }: NodeProps<PassageNode>) => (
  <div
    style={{ width: LANE_WIDTH, height: NODE_HEIGHT }}
    className={cn(
      'group relative rounded-lg border px-2.5 py-1.5 bg-surface/95 backdrop-blur-sm transition-colors overflow-hidden',
      selected
        ? 'border-accent ring-2 ring-accent/50'
        : data.hit
          ? 'border-accent/70 bg-accent/[0.07]'
          : data.linked
            ? 'border-accent/40 bg-accent/[0.04]'
            : 'border-app-border hover:border-accent/50',
    )}
    data-testid="crossing-node"
  >
    <Handle
      type="target"
      position={Position.Left}
      className="!bg-app-border !border-0 !w-2 !h-2 group-hover:!bg-[var(--app-accent)]"
    />
    <div className="flex items-center gap-1.5 mb-0.5">
      <span className="text-[9px] font-mono text-muted shrink-0">#{data.index + 1}</span>
      <span className="text-[10px] font-bold truncate">{data.name}</span>
      {data.linked && <Link2 size={9} className="text-accent shrink-0 ml-auto" />}
    </div>
    <p className="text-[10.5px] leading-snug opacity-70 line-clamp-2">
      {data.preview || '(empty)'}
    </p>
    <Handle
      type="source"
      position={Position.Right}
      className="!bg-app-border !border-0 !w-2 !h-2 group-hover:!bg-[var(--app-accent)]"
    />
  </div>
);

/** A lane's header: which story this column is, and how to search inside it. */
const LaneNodeView = ({ data }: NodeProps<LaneNode>) => (
  <div style={{ width: LANE_WIDTH }} className="rounded-xl border border-app-border bg-surface/90 backdrop-blur px-3 py-2">
    <div className="flex items-center gap-1.5 mb-1.5">
      <MessageSquare size={12} className="text-accent shrink-0" />
      <span className="text-xs font-bold truncate" title={data.title}>{data.title}</span>
      <span className="text-[10px] text-muted shrink-0 tabular-nums">{data.total}</span>
      {data.onRemove && (
        <button
          onClick={data.onRemove}
          className="ml-auto p-0.5 rounded hover:bg-app-text/10 opacity-50 hover:opacity-100 shrink-0"
          aria-label={`Remove ${data.title} from the board`}
        >
          <X size={12} />
        </button>
      )}
    </div>
    {/* `nodrag`/`nowheel` or the canvas eats the click and the caret. */}
    <div className="relative nodrag nowheel">
      <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 opacity-50" />
      <input
        value={data.query}
        onChange={e => data.onQuery(e.target.value)}
        placeholder="Find a passage or #12…"
        aria-label={`Search ${data.title}`}
        className="w-full pl-6 pr-2 py-1 text-[11px] bg-app-text/5 border border-transparent rounded-md outline-none focus:border-accent/50"
      />
    </div>
    {data.hidden > 0 && (
      <p className="text-[9px] text-muted mt-1">
        {data.hidden} more not shown — search, or open a gap
      </p>
    )}
  </div>
);

/** What is not being drawn, standing where it would be. */
const GapNodeView = ({ data }: NodeProps<GapNode>) => {
  const n = data.gap.to - data.gap.from + 1;
  return (
    <button
      onClick={data.onOpen}
      style={{ width: LANE_WIDTH }}
      className="rounded-lg border border-dashed border-app-border/70 py-1 text-[10px] text-muted hover:border-accent hover:text-accent transition-colors"
      title={`Show messages ${data.gap.from + 1}–${data.gap.to + 1}`}
      data-testid="crossing-gap"
    >
      ⋯ {n} more
    </button>
  );
};

const nodeTypes = { passage: PassageNodeView, lane: LaneNodeView, gap: GapNodeView };

/* ------------------------------------------------------------------ */
/* The board                                                           */
/* ------------------------------------------------------------------ */

/** A drop waiting to be told what it meant. */
interface PendingLink {
  from: CrossPoint;
  to: CrossPoint;
  /** Where on screen to put the question. */
  x: number;
  y: number;
}

export const CrossingBoard = () => (
  // The provider is what lets the picker convert a drop position into canvas
  // coordinates, and the board into a fitted view.
  <ReactFlowProvider>
    <CrossingBoardInner />
  </ReactFlowProvider>
);

const CrossingBoardInner = () => {
  const open = useAuraV2Store(s => s.crossingBoardOpen);
  const setOpen = useAuraV2Store(s => s.setCrossingBoardOpen);
  const board = useAuraV2Store(s => s.crossingBoard);
  const setBoard = useAuraV2Store(s => s.setCrossingBoard);
  const crossings = useAuraV2Store(s => s.crossings);
  const addCrossing = useAuraV2Store(s => s.addCrossing);
  const removeCrossing = useAuraV2Store(s => s.removeCrossing);
  const updateCrossing = useAuraV2Store(s => s.updateCrossing);
  const stories = useAppStore(s => s.library);
  const currentStoryId = useAppStore(s => s.currentStory?.id);
  const currentIndex = useAppStore(s => {
    if (!s.currentStory) return 0;
    let n = 0;
    for (let c = 0; c < s.currentChainIndex; c++) n += s.chains[c]?.messages.length ?? 0;
    return n + s.currentMessageIndex;
  });

  const [loaded, setLoaded] = useState<Record<string, Story>>({});
  const [loading, setLoading] = useState(false);
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<{ storyId: string; index: number } | null>(null);
  /** A link the pointer is over in the side list — lit on the canvas. */
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingLink | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queries, setQueries] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Map<string, Set<number>>>(new Map());
  const surfaceRef = useRef<HTMLDivElement>(null);
  const flow = useReactFlow();

  /**
   * The board seeds itself from the story being read plus the most-crossed
   * others. Opening onto an empty board would make the first question "which
   * two of my forty chats?", which is a worse question than the one this
   * feature exists to answer.
   */
  useEffect(() => {
    if (!open || board.length) return;
    const ranked = suggestedStories(crossings, stories);
    const seed = [
      ...(currentStoryId ? [currentStoryId] : []),
      ...ranked.map(s => s.id).filter(id => id !== currentStoryId),
    ].slice(0, 2);
    if (seed.length) setBoard(seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Transcripts are not in the app store — only the open story is. Each lane is
  // fetched once and kept for the session.
  useEffect(() => {
    if (!open) return;
    const missing = board.filter(id => !loaded[id]);
    if (!missing.length) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const got: Record<string, Story> = {};
      for (const id of missing) {
        try {
          const story = await getStory(id);
          if (story) got[id] = story;
        } catch { /* a story that will not load simply has no lane */ }
      }
      if (!cancelled) {
        setLoaded(prev => ({ ...prev, ...got }));
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, board, loaded]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (pending) setPending(null);
      else if (selected) setSelected(null);
      else setOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, pending, selected, setOpen]);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 3200);
    return () => clearTimeout(t);
  }, [error]);

  const columns = useMemo(
    () => board.map(id => loaded[id]).filter((s): s is Story => !!s),
    [board, loaded],
  );

  const shown = useMemo(
    () => crossings.filter(c => board.includes(c.a.storyId) && board.includes(c.b.storyId)),
    [crossings, board],
  );

  const openGap = useCallback((storyId: string, gap: BoardGap) => {
    setExpanded(prev => {
      const next = new Map(prev);
      const set = new Set(next.get(storyId) ?? []);
      gapIndices(gap).forEach(i => set.add(i));
      next.set(storyId, set);
      return next;
    });
  }, []);

  /**
   * The lanes, laid out one story at a time.
   *
   * `layoutBoard` takes ONE query and this board has one search box per lane,
   * so each lane is laid out with its own and placed by `laneX`. Cheap either
   * way — the work is a pass over indices — but doing it per lane means typing
   * in one search box does not re-lay the other three.
   */
  const lanes = useMemo(() => columns.map((story, i) => {
    const [only] = layoutBoard([{ storyId: story.id, messages: story.messages }], {
      crossings: shown,
      query: queries[story.id] ?? '',
      focus: story.id === currentStoryId ? { storyId: story.id, index: currentIndex } : undefined,
      expanded,
    });
    return { story, laid: { ...only, x: laneX(i) } };
  }), [columns, queries, shown, currentStoryId, currentIndex, expanded]);

  const pointFor = useCallback((story: Story, index: number): CrossPoint => {
    const msg = story.messages[index];
    return {
      storyId: story.id,
      storyTitle: story.title,
      messageId: msg.id,
      index: index + 1,
      name: msg.name,
      excerpt: excerptOf(msg.content),
    };
  }, []);

  /** Passage nodes by id, so a connection can be turned back into two points. */
  const pointsByNode = useMemo(() => {
    const map = new Map<string, { story: Story; index: number }>();
    for (const { story, laid } of lanes) {
      for (const row of laid.rows) {
        if (row.kind !== 'entry') continue;
        map.set(`${story.id}::${row.entry.message.id}`, { story, index: row.entry.index });
      }
    }
    return map;
  }, [lanes]);

  const nodes: BoardNode[] = useMemo(() => {
    const out: BoardNode[] = [];
    lanes.forEach(({ story, laid }) => {
      out.push({
        id: `lane::${story.id}`,
        type: 'lane',
        position: { x: laid.x, y: 0 },
        draggable: false,
        selectable: false,
        data: {
          storyId: story.id,
          title: story.title,
          total: laid.total,
          hidden: laid.hidden,
          query: queries[story.id] ?? '',
          onQuery: (q: string) => setQueries(prev => ({ ...prev, [story.id]: q })),
          onRemove: board.length > 1
            ? () => setBoard(board.filter(id => id !== story.id))
            : undefined,
        },
      } satisfies LaneNode);

      laid.rows.forEach((row: BoardRow) => {
        const y = rowY(row.at);
        if (row.kind === 'gap') {
          out.push({
            id: `gap::${story.id}::${row.gap.from}`,
            type: 'gap',
            position: { x: laid.x, y },
            draggable: false,
            selectable: false,
            data: { storyId: story.id, gap: row.gap, onOpen: () => openGap(story.id, row.gap) },
          } satisfies GapNode);
          return;
        }
        out.push({
          id: `${story.id}::${row.entry.message.id}`,
          type: 'passage',
          position: { x: laid.x, y },
          draggable: false,
          data: {
            storyId: story.id,
            storyTitle: story.title,
            index: row.entry.index,
            name: row.entry.message.name,
            preview: row.entry.message.content.replace(/\s+/g, ' ').slice(0, 160),
            linked: row.entry.linked,
            hit: row.entry.hit,
          },
        } satisfies PassageNode);
      });
    });
    return out;
  }, [lanes, queries, board, setBoard, openGap]);

  const edges: Edge[] = useMemo(() => shown.map(c => {
    const lit = selected === c.id || hoveredEdge === c.id;
    return {
      id: c.id,
      source: `${c.a.storyId}::${c.a.messageId}`,
      target: `${c.b.storyId}::${c.b.messageId}`,
      animated: selected === c.id,
      selected: selected === c.id,
      label: kindDef(c.kind).label,
      labelStyle: { fontSize: 10, fill: 'var(--app-text)' },
      labelBgStyle: { fill: 'var(--app-surface)', fillOpacity: 0.85 },
      style: {
        stroke: lit ? 'var(--app-accent)' : 'var(--app-border)',
        strokeWidth: lit ? 2.5 : 1.5,
        opacity: lit ? 1 : 0.6,
      },
    };
  }), [shown, selected, hoveredEdge]);

  /**
   * A drag that landed on another node.
   *
   * The link is NOT made here — `setPending` opens the kind picker, and the
   * picker makes it. The board used to create the crossing on drop and ask
   * afterwards in a side panel, which meant every link was born as the first
   * kind in the list and most stayed that way.
   */
  const onConnect = useCallback((conn: Connection) => {
    const a = conn.source ? pointsByNode.get(conn.source) : undefined;
    const b = conn.target ? pointsByNode.get(conn.target) : undefined;
    if (!a || !b) return;
    const from = pointFor(a.story, a.index);
    const to = pointFor(b.story, b.index);
    const problem = crossingProblem(from, to);
    if (problem) { setError(problem); return; }
    if (isDuplicate(crossings, from, to)) {
      setError('Those two are already linked.');
      return;
    }
    // Put the question near the passages it is about, not in a corner.
    const rect = surfaceRef.current?.getBoundingClientRect();
    const at = flow.flowToScreenPosition({
      x: (nodes.find(n => n.id === conn.target)?.position.x ?? 0) + LANE_WIDTH / 2,
      y: (nodes.find(n => n.id === conn.target)?.position.y ?? 0) + NODE_HEIGHT,
    });
    setPending({
      from,
      to,
      x: at.x - (rect?.left ?? 0),
      y: at.y - (rect?.top ?? 0),
    });
  }, [pointsByNode, pointFor, crossings, flow, nodes]);

  const commitPending = (kind: CrossingKind) => {
    if (!pending) return;
    const made = makeCrossing(pending.from, pending.to, kind);
    addCrossing(made);
    setPending(null);
    setSelected(made.id);
  };

  const hoveredMessage = useMemo((): { story: Story; index: number; message: Message } | null => {
    if (!hovered) return null;
    const story = loaded[hovered.storyId];
    const message = story?.messages[hovered.index];
    return story && message ? { story, index: hovered.index, message } : null;
  }, [hovered, loaded]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] bg-app-bg text-app-text flex flex-col" data-testid="crossing-board">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-app-border bg-surface/85 backdrop-blur-md shrink-0">
        <Link2 size={18} className="text-accent" />
        <div className="min-w-0">
          <h2 className="font-bold leading-tight">Branching</h2>
          <p className="text-[11px] text-muted leading-tight">
            {columns.length < 2
              ? 'Add a second story, then drag from one passage to another.'
              : `${columns.length} stories · ${shown.length} link${shown.length === 1 ? '' : 's'} — drag from a passage’s edge across to another story.`}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {board.length < MAX_COLUMNS && (
            <button
              onClick={() => setPicking(true)}
              data-testid="crossing-add-story"
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm border border-app-border hover:bg-app-text/5"
            >
              <Plus size={14} /> Story
            </button>
          )}
          <button
            onClick={() => setOpen(false)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm hover:bg-app-text/5"
            title="Back to reading (Esc)"
          >
            <X size={16} /> Close
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex">
        <div ref={surfaceRef} className="relative flex-1 min-w-0">
          {columns.length === 0 && !loading && (
            <div className="absolute inset-0 flex items-center justify-center">
              <p className="text-sm text-muted">Add a story to begin.</p>
            </div>
          )}
          {loading && !columns.length && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 size={20} className="animate-spin opacity-60" />
            </div>
          )}

          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onConnect={onConnect}
            onNodeMouseEnter={(_, node) => {
              const point = pointsByNode.get(node.id);
              if (point) setHovered({ storyId: point.story.id, index: point.index });
            }}
            onNodeMouseLeave={() => setHovered(null)}
            onEdgeClick={(_, edge) => setSelected(edge.id)}
            onPaneClick={() => { setPending(null); setSelected(null); }}
            fitView
            fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
            minZoom={0.15}
            maxZoom={1.6}
            proOptions={{ hideAttribution: true }}
            className="bg-app-bg"
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--app-border)" />
            <Controls showInteractive={false} className="!bg-surface !border-app-border" />
            {columns.length > 1 && (
              <MiniMap
                pannable
                zoomable
                className="!bg-surface !border-app-border"
                nodeColor={n => (n.type === 'passage' && (n.data as PassageData).linked
                  ? 'var(--app-accent)' : 'var(--app-border)')}
              />
            )}
          </ReactFlow>

          {/* The passage in full, while the pointer is on its node. Fixed to a
            * corner rather than following the pointer: a tooltip that moves is
            * a tooltip you cannot read a paragraph in, and it would sit over
            * the very node you are about to drag from. */}
          {hoveredMessage && !pending && (
            <div className="absolute left-3 bottom-3 z-20 w-96 max-w-[45vw] rounded-xl border border-app-border bg-surface/95 backdrop-blur-md shadow-2xl p-3 pointer-events-none">
              <div className="flex items-center gap-1.5 mb-1.5">
                <span className="text-[10px] font-mono text-muted">#{hoveredMessage.index + 1}</span>
                <span className="text-[11px] font-bold truncate">{hoveredMessage.message.name}</span>
                <span className="text-[10px] text-muted truncate ml-auto">
                  {hoveredMessage.story.title}
                </span>
              </div>
              <p className="text-xs leading-relaxed opacity-85 max-h-56 overflow-hidden whitespace-pre-wrap">
                {hoveredMessage.message.content.slice(0, 900)}
                {hoveredMessage.message.content.length > 900 && '…'}
              </p>
            </div>
          )}

          {/* What did that link mean? Asked at the drop, while both passages
            * are still in mind. */}
          {pending && (
            <div
              className="absolute z-30 w-72 rounded-xl border border-app-border bg-surface shadow-2xl p-2"
              style={{
                left: Math.min(Math.max(8, pending.x), (surfaceRef.current?.clientWidth ?? 800) - 296),
                top: Math.min(Math.max(8, pending.y), (surfaceRef.current?.clientHeight ?? 600) - 320),
              }}
              data-testid="crossing-kind-picker"
            >
              <p className="text-[11px] text-muted px-1.5 pb-1.5 leading-snug">
                <span className="font-bold text-app-text">{pending.from.storyTitle} #{pending.from.index}</span>
                {' → '}
                <span className="font-bold text-app-text">{pending.to.storyTitle} #{pending.to.index}</span>
                <br />What is this link?
              </p>
              {CROSSING_KINDS.map(k => (
                <button
                  key={k.kind}
                  onClick={() => commitPending(k.kind)}
                  className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-accent/10 group/kind"
                >
                  <span className="block text-xs font-bold group-hover/kind:text-accent">{k.label}</span>
                  <span className="block text-[10px] text-muted leading-snug">{k.hint}</span>
                </button>
              ))}
              <button
                onClick={() => setPending(null)}
                className="w-full text-center text-[10px] text-muted py-1 hover:text-app-text"
              >
                Cancel (Esc)
              </button>
            </div>
          )}
        </div>

        {selected && (
          <CrossingPanel
            crossing={crossings.find(c => c.id === selected) ?? null}
            stories={loaded}
            onClose={() => setSelected(null)}
            onDelete={id => { removeCrossing(id); setSelected(null); }}
            onPatch={updateCrossing}
          />
        )}
        {!selected && shown.length > 0 && (
          <CrossingList
            crossings={shown}
            onPick={setSelected}
            onHover={setHoveredEdge}
          />
        )}
      </div>

      {error && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-[80] px-4 py-2 rounded-lg bg-app-text text-app-bg text-xs font-medium shadow-xl max-w-md text-center">
          {error}
        </div>
      )}

      {picking && (
        <StoryPicker
          exclude={board}
          onPick={id => { setBoard([...board, id]); setPicking(false); }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* The links, listed                                                   */
/* ------------------------------------------------------------------ */

const CrossingList = ({
  crossings, onPick, onHover,
}: {
  crossings: Crossing[];
  onPick: (id: string) => void;
  onHover: (id: string | null) => void;
}) => (
  <div className="w-64 shrink-0 border-l border-app-border bg-surface/60 flex flex-col">
    <div className="px-3 py-2 border-b border-app-border/60 text-[10px] uppercase tracking-wide text-muted">
      Links
    </div>
    <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
      {crossings.map(c => (
        <button
          key={c.id}
          onClick={() => onPick(c.id)}
          onMouseEnter={() => onHover(c.id)}
          onMouseLeave={() => onHover(null)}
          className="w-full text-left rounded-lg px-2 py-1.5 hover:bg-app-text/5"
        >
          <span className="block text-[11px] font-bold text-accent truncate">
            {kindDef(c.kind).label}
          </span>
          <span className="block text-[10px] text-muted truncate">
            {c.a.storyTitle} #{c.a.index} ↔ {c.b.storyTitle} #{c.b.index}
          </span>
          {c.note && <span className="block text-[10px] opacity-70 truncate italic">{c.note}</span>}
        </button>
      ))}
    </div>
  </div>
);

/* ------------------------------------------------------------------ */
/* One link, and the conversation about it                             */
/* ------------------------------------------------------------------ */

const CrossingPanel = ({
  crossing, stories, onClose, onDelete, onPatch,
}: {
  crossing: Crossing | null;
  stories: Record<string, Story>;
  onClose: () => void;
  onDelete: (id: string) => void;
  onPatch: (id: string, patch: Partial<Omit<Crossing, 'id'>>) => void;
}) => {
  const base = useAppStore(s => s.aiBaseUrl);
  const key = useAppStore(s => s.aiApiKey);
  const model = useAppStore(s => s.aiModel);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // A different link is a different conversation. Without this, switching links
  // shows the previous one's answer under the new one's passages.
  useEffect(() => { setAnswer(null); setFailed(null); setQuestion(''); }, [crossing?.id]);

  if (!crossing) return null;

  /**
   * A window of messages around each end, rather than the one line.
   *
   * A single message is rarely enough to say anything useful about — "she set
   * the lamp down" has no meaning without what was being said. Small on
   * purpose: two ends of a wide window is most of a context.
   */
  const contextAround = (storyId: string, messageId: string): string | undefined => {
    const story = stories[storyId];
    if (!story) return undefined;
    const at = story.messages.findIndex(m => m.id === messageId);
    if (at < 0) return undefined;
    return story.messages
      .slice(Math.max(0, at - 2), at + 3)
      .map((m, i) => `${m.name}${Math.max(0, at - 2) + i === at ? ' ← THIS ONE' : ''}: ${m.content}`)
      .join('\n\n')
      .slice(0, 4000);
  };

  const discuss = async () => {
    if (!base || !model || running) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setFailed(null);
    setAnswer(null);
    try {
      const out = await askText(
        { base, key, model },
        buildCrossingMessages({
          crossing,
          aContext: contextAround(crossing.a.storyId, crossing.a.messageId),
          bContext: contextAround(crossing.b.storyId, crossing.b.messageId),
          aCard: stories[crossing.a.storyId]?.card,
          bCard: stories[crossing.b.storyId]?.card,
          question: question.trim() || undefined,
        }),
        { label: 'Thinking about the link', params: { temperature: 0.7 }, signal: controller.signal },
      );
      setAnswer(out.trim() || null);
      if (!out.trim()) setFailed('The model returned an empty reply.');
    } catch (e: any) {
      if (e?.name !== 'AbortError') setFailed(e?.message ?? 'Request failed.');
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const end = (p: CrossPoint, label: string) => (
    <div className="rounded-lg border border-app-border p-2">
      <p className="text-[10px] uppercase tracking-wide text-muted mb-1">
        {label} · {p.storyTitle} #{p.index}
      </p>
      <p className="text-[11px] font-bold mb-0.5">{p.name}</p>
      <p className="text-[11px] leading-snug opacity-75">{p.excerpt}</p>
    </div>
  );

  return (
    <div className="w-80 shrink-0 border-l border-app-border bg-surface flex flex-col">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-app-border shrink-0">
        <Link2 size={14} className="text-accent" />
        <span className="text-xs font-bold">This link</span>
        <button
          onClick={() => onDelete(crossing.id)}
          className="ml-auto p-1 rounded hover:bg-red-500/10 text-muted hover:text-red-500"
          title="Delete this link"
          aria-label="Delete this link"
        >
          <Trash2 size={13} />
        </button>
        <button onClick={onClose} className="p-1 rounded hover:bg-app-text/10" aria-label="Close">
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {end(crossing.a, 'A')}
        {end(crossing.b, 'B')}

        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted mb-1.5">What kind of link</p>
          <div className="space-y-1">
            {CROSSING_KINDS.map(k => (
              <button
                key={k.kind}
                onClick={() => onPatch(crossing.id, { kind: k.kind as CrossingKind })}
                className={cn(
                  'w-full text-left rounded-lg px-2 py-1.5 border transition-colors',
                  crossing.kind === k.kind
                    ? 'border-accent bg-accent/10' : 'border-transparent hover:bg-app-text/5',
                )}
              >
                <span className={cn('block text-[11px] font-bold', crossing.kind === k.kind && 'text-accent')}>
                  {k.label}
                </span>
                <span className="block text-[10px] text-muted leading-tight">{k.hint}</span>
              </button>
            ))}
          </div>
        </div>

        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-muted">Your note</span>
          <textarea
            rows={2}
            value={crossing.note ?? ''}
            onChange={e => onPatch(crossing.id, { note: e.target.value })}
            placeholder="Why are these connected?"
            className="mt-1 w-full text-[11px] rounded-lg border border-app-border bg-transparent px-2 py-1.5 resize-y outline-none focus:border-accent/50"
          />
        </label>

        <div className="space-y-1.5">
          <textarea
            rows={2}
            value={question}
            onChange={e => setQuestion(e.target.value)}
            placeholder={kindDef(crossing.kind).ask.slice(0, 90) + '…'}
            aria-label="Ask something else about this link"
            className="w-full text-[11px] rounded-lg border border-app-border bg-transparent px-2 py-1.5 resize-y outline-none focus:border-accent/50"
          />
          <div className="flex items-center gap-2">
            <p className="text-[10px] text-muted flex-1 min-w-0">
              {question.trim() ? 'Your question.' : `Asks: ${kindDef(crossing.kind).label.toLowerCase()}.`}
            </p>
            {running ? (
              <button
                onClick={() => abortRef.current?.abort()}
                className="text-[11px] px-2.5 py-1 rounded-md bg-app-text/10 hover:bg-app-text/20"
              >
                Stop
              </button>
            ) : (
              <button
                onClick={() => void discuss()}
                disabled={!base || !model}
                title={!base || !model ? 'Connect an AI endpoint first' : undefined}
                data-testid="crossing-discuss"
                className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-md bg-accent text-white disabled:opacity-40"
              >
                Discuss
              </button>
            )}
          </div>
        </div>

        {running && (
          <p className="text-[11px] text-muted flex items-center gap-1.5">
            <Loader2 size={12} className="animate-spin" /> Reading both passages…
          </p>
        )}
        {failed && <p className="text-[11px] text-red-500">{failed}</p>}
        {answer && (
          <div className="rounded-lg border border-app-border p-2.5">
            <p className="text-[11px] leading-relaxed whitespace-pre-wrap">{answer}</p>
          </div>
        )}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Choosing a story for a column                                       */
/* ------------------------------------------------------------------ */

const StoryPicker = ({
  exclude, onPick, onClose,
}: {
  exclude: string[];
  onPick: (id: string) => void;
  onClose: () => void;
}) => {
  const stories = useAppStore(s => s.library);
  const crossings = useAuraV2Store(s => s.crossings);
  const [query, setQuery] = useState('');
  const ranked = useMemo(
    () => suggestedStories(crossings, stories)
      .filter(s => !exclude.includes(s.id))
      .filter(s => !query.trim() || s.title.toLowerCase().includes(query.trim().toLowerCase())),
    [crossings, stories, exclude, query],
  );

  return (
    <div
      className="fixed inset-0 z-[85] flex items-center justify-center bg-black/50 p-4"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md max-h-[70vh] flex flex-col rounded-2xl bg-surface border border-app-border shadow-2xl overflow-hidden">
        <div className="px-3 py-2.5 border-b border-app-border shrink-0">
          <input
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Which story?"
            aria-label="Which story"
            className="w-full px-2.5 py-1.5 text-sm bg-app-text/5 border border-transparent rounded-lg outline-none focus:border-accent/50"
          />
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-1.5">
          {ranked.map(s => (
            <button
              key={s.id}
              onClick={() => onPick(s.id)}
              className="w-full flex items-center gap-2 text-left px-2.5 py-2 rounded-lg hover:bg-app-text/5"
            >
              <span className="min-w-0 flex-1 text-sm truncate">{s.title}</span>
              {s.crossings > 0 && (
                <span className="text-[10px] text-accent shrink-0">
                  {s.crossings} link{s.crossings === 1 ? '' : 's'}
                </span>
              )}
            </button>
          ))}
          {!ranked.length && (
            <p className="text-xs text-muted text-center py-6">
              {query ? 'No story by that name.' : 'Every story is already on the board.'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
};
