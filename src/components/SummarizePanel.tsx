import { useState, useRef } from 'react';
import { Loader2, ScrollText, Square, Table2, X } from 'lucide-react';
import { useAppStore } from '../store';
import { flushV2, useAuraV2Store } from '../stores/useAuraV2Store';
import { useSummaryStore } from '../stores/useSummaryStore';
import { resolveContent } from '../utils/lens';
import { askText } from '../utils/aiCall';
import {
  DETAIL_CHARS, DETAIL_OUTPUT, READ_DETAILS, ReadDetail, estimateBudgetChars, runSheetFill,
  sectionBudget, SummaryPassage,
} from '../utils/summarizer';
import { LONG_READ_JOBS, runLongRead } from '../utils/longRead';
import { cn } from '../utils/cn';

type Mode = 'summary' | 'sheet';

/**
 * The long read — turn a story no context could hold into one designed
 * document, landed in a versioned pin.
 *
 * Four jobs over one engine (`utils/longRead.ts`): a running account, a
 * timeline, a cast chart, and a priming brief for continuing the story
 * elsewhere. Each pass carries a small digest to the next, which is what stops
 * section nine introducing a character section two already met.
 *
 * Runs as a single-model queue by default. The lanes control trades that
 * coherence for speed and says so — parallel passes cannot hand notes to each
 * other, so they read blind.
 */
export const SummarizePanel = ({
  base, apiKey, model, onClose,
}: {
  base: string;
  apiKey: string;
  model: string;
  onClose: () => void;
}) => {
  const running = useSummaryStore(s => s.running);
  const phase = useSummaryStore(s => s.phase);
  const done = useSummaryStore(s => s.done);
  const total = useSummaryStore(s => s.total);
  const error = useSummaryStore(s => s.error);

  const [mode, setMode] = useState<Mode>('summary');
  const [jobId, setJobId] = useState(LONG_READ_JOBS[0].id);
  const [lanes, setLanes] = useState(1);
  const [instruction, setInstruction] = useState('');
  const [sheetTitle, setSheetTitle] = useState('Story sheet');
  const [sheetColumns, setSheetColumns] = useState('Character, Role, Status');
  const [ratio, setRatio] = useState(0.8);
  const [detail, setDetail] = useState<ReadDetail>('normal');
  const [result, setResult] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const contextTokens = useAppStore(s => s.aiAdvanced.contextSize);
  // Story size, for the "~N sections" readout — the number that tells a reader
  // at a glance whether this run will actually walk their story or gulp it.
  const storyChars = useAppStore(s =>
    s.chains.reduce((n, c) => n + c.messages.reduce((m, x) => m + x.content.length, 0), 0));
  // Detail decides how much story a section covers; the window is only a
  // ceiling on it. Sizing sections by the window alone turned a 128k-token
  // setting into a one-pass "summary" of the whole chat — see sectionBudget.
  const budgetChars = sectionBudget(detail, contextTokens, ratio);
  const sheetBudgetChars = estimateBudgetChars(contextTokens, ratio);

  const run = async () => {
    const app = useAppStore.getState();
    const story = app.currentStory;
    if (!story || !base || !model || running) return;
    const v2 = useAuraV2Store.getState();
    const overrides = v2.overridesByStory[story.id];
    const lensOn = !!v2.lensOnByStory[story.id];
    const passages: SummaryPassage[] = app.chains
      .flatMap(c => c.messages)
      .map(m => ({ name: m.name, content: resolveContent(m, overrides, lensOn) }))
      .filter(p => p.content.trim());
    if (passages.length === 0) return;

    const job = LONG_READ_JOBS.find(j => j.id === jobId) ?? LONG_READ_JOBS[0];
    const store = useSummaryStore.getState();
    const controller = new AbortController();
    abortRef.current = controller;
    setResult(null);
    // Every summariser request goes through the shared layer, so a thinking
    // model's deliberation never lands in the summary the reader reads — and a
    // reply that ran out of room mid-thought is retried with more, instead of
    // being reported as an empty summary.
    const adv = app.aiAdvanced;
    const send = (messages: any, signal?: AbortSignal) =>
      askText({ base, key: apiKey, model }, messages, {
        label: 'Summarising',
        params: { temperature: 0.3 },
        // Room for the section, stated. Left out — as it was — no `max_tokens`
        // is sent at all and the endpoint's own default applies; several of the
        // backends this app targets cap that low enough to cut a section off
        // mid-sentence, which reads as a model that writes badly rather than
        // one that was never given room. `ask` adds reasoning headroom on top.
        // The reader's own "max output tokens" wins where they have set one —
        // before this, that setting did nothing at all here.
        budget: adv.maxTokens > 0 ? adv.maxTokens : DETAIL_OUTPUT[detail],
        signal,
      });

    // --- Sheet mode: fill a structured table with deduped rows. ---
    if (mode === 'sheet') {
      const columns = sheetColumns.split(',').map(c => c.trim()).filter(Boolean);
      if (columns.length === 0) return;
      store.begin();
      try {
        const rows = await runSheetFill({
          passages, budgetChars: sheetBudgetChars, columns,
          instruction: instruction.trim() || `Extract every distinct ${columns[0].toLowerCase()} and its details.`,
          card: story.card, send, signal: controller.signal,
          onPhase: (p, d, t) => useSummaryStore.getState().step(p, d, t),
        });
        if (controller.signal.aborted) { store.end(); return; }
        if (rows.length === 0) { store.fail('No rows were extracted.'); return; }
        useAuraV2Store.getState().addSheet(story.id, {
          title: sheetTitle.trim() || 'Story sheet', columns, rows,
        });
        void flushV2();
        store.end();
        setResult(`Created sheet “${sheetTitle.trim() || 'Story sheet'}” with ${rows.length} rows.`);
      } catch (e: any) {
        if (!controller.signal.aborted) store.fail(e?.message ?? 'Sheet fill failed.');
        else store.end();
      }
      return;
    }

    store.begin();
    try {
      const read = await runLongRead({
        job,
        passages,
        budgetChars,
        card: story.card,
        title: story.title,
        instruction: instruction.trim() || undefined,
        concurrency: lanes,
        send,
        signal: controller.signal,
        onPhase: (p, d, t) => useSummaryStore.getState().step(
          p === 'assembling' ? 'reducing' : 'mapping', d, t),
      });
      const doc = read.document;
      if (controller.signal.aborted) { store.end(); return; }
      if (!doc) { store.fail('Nothing came back to build a document from.'); return; }

      // Land in the story's summary pin — version it if it already exists.
      const v2now = useAuraV2Store.getState();
      const existingId = v2now.summaryPinByStory[story.id];
      const existing = existingId
        ? (v2now.pinsByStory[story.id] ?? []).find(p => p.id === existingId)
        : undefined;
      if (existing) {
        v2now.addPinVersion(story.id, existing.id, {
          content: doc, source: 'ai', instruction: job.label,
        });
      } else {
        // `addPin` returns '' when the story is at its pin cap. This used to be
        // void, and the code here then took `pins.slice(-1)[0]` as "the pin I
        // just made" — at the cap, an unrelated pin, which was then marked as
        // the summary pin so the NEXT run overwrote it. Now it says so instead.
        const createdId = v2now.addPin(story.id, {
          title: 'Story summary', format: 'markdown', content: doc, inContext: false, docked: true,
        });
        if (createdId) v2now.setSummaryPin(story.id, createdId);
        else {
          store.fail(
            'The document is ready but this story is at its pin limit, so nothing was saved. '
            + 'Delete a pin and run again — or copy it out of the preview below.',
          );
          setResult(doc);
          return;
        }
      }
      // A document the reader waited minutes for is the definition of a
      // deliberate edit: it writes through rather than waiting on the 400ms
      // debounce, which an unload can cut off.
      void flushV2();
      store.end();
      // A model that ignores the format is the difference between this engine
      // and the map-reduce it replaced, and the only symptom in the document
      // itself is prose that repeats itself. Say it plainly instead.
      setResult(read.malformed
        ? `⚠ ${read.malformed} of ${read.sections} passes did not follow the format`
          + `${read.blind ? `, and ${read.blind} handed nothing forward` : ''}`
          + `. The document is below; a different model may do better.\n\n${doc}`
        : doc);
    } catch (e: any) {
      if (!controller.signal.aborted) store.fail(e?.message ?? 'Summary failed.');
      else store.end();
    }
  };

  const stop = () => { abortRef.current?.abort(); useSummaryStore.getState().end(); };

  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="absolute inset-0 z-20 bg-surface/97 backdrop-blur-sm overflow-y-auto p-3.5 space-y-3 text-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 font-bold">
          <ScrollText size={15} className="text-accent" /> Summarize story
        </div>
        <button onClick={onClose} className="p-1 rounded-md hover:bg-app-text/10"><X size={15} /></button>
      </div>

      <p className="text-[11px] text-muted">
        Reads the whole story in chunks that fit your model's context and writes
        each part — then combines them into a versioned “Story summary” pin, or
        fills a table. Runs one request at a time on your single model.
      </p>

      <div className="grid grid-cols-2 gap-1.5">
        {([['summary', 'Summary', ScrollText], ['sheet', 'Sheet', Table2]] as const).map(([m, label, Icon]) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            disabled={running}
            className={cn(
              'flex items-center justify-center gap-1.5 py-1.5 text-xs rounded-md border transition-colors',
              mode === m
                ? 'border-accent bg-accent/10 text-accent font-bold'
                : 'border-transparent bg-app-text/5 hover:bg-app-text/10',
            )}
          >
            <Icon size={13} /> {label}
          </button>
        ))}
      </div>

      {mode === 'summary' ? (
        <div className="space-y-2">
          <div>
            <p className="text-xs font-medium mb-1.5 opacity-80">Document</p>
            <div className="grid grid-cols-2 gap-1.5">
              {LONG_READ_JOBS.map(j => (
                <button
                  key={j.id}
                  onClick={() => setJobId(j.id)}
                  disabled={running}
                  title={j.purpose}
                  data-testid={`long-read-${j.id}`}
                  className={cn(
                    'py-1.5 text-xs rounded-md border transition-colors capitalize',
                    jobId === j.id
                      ? 'border-accent bg-accent/10 text-accent font-bold'
                      : 'border-transparent bg-app-text/5 hover:bg-app-text/10',
                  )}
                >
                  {j.id}
                </button>
              ))}
            </div>
          </div>
          {/* The trade, stated where it is made. One lane is the whole reason
            * this engine beats the map-reduce it replaced; more lanes give that
            * back for speed, and a reader who is not told will read the seams
            * as the model being bad at its job. */}
          <label className="flex items-center gap-2 text-xs">
            <span className="opacity-80">At once</span>
            <input
              type="range"
              min={1}
              max={4}
              step={1}
              value={lanes}
              disabled={running}
              onChange={e => setLanes(Number(e.target.value))}
              data-testid="long-read-lanes"
              className="flex-1 accent-current"
            />
            <span className="tabular-nums w-4 text-right">{lanes}</span>
          </label>
          <p className="text-[11px] text-muted leading-snug">
            {lanes === 1
              ? 'One at a time: each stretch is handed what the last one learned, so the document stays coherent end to end.'
              : `${lanes} at a time — faster, and each stretch reads blind. Sections will not know about each other, and the seams show.`}
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          <input
            value={sheetTitle}
            onChange={e => setSheetTitle(e.target.value)}
            disabled={running}
            placeholder="Sheet title"
            className="w-full rounded-md bg-app-bg border border-app-border px-2 py-1.5 text-xs focus:outline-none focus:border-accent"
          />
          <input
            value={sheetColumns}
            onChange={e => setSheetColumns(e.target.value)}
            disabled={running}
            placeholder="Columns, comma-separated (first is the key)"
            className="w-full rounded-md bg-app-bg border border-app-border px-2 py-1.5 text-xs focus:outline-none focus:border-accent"
          />
          <p className="text-[10px] text-muted">
            Rows are gathered across the story and de-duplicated by the first column.
          </p>
        </div>
      )}

      <textarea
        value={instruction}
        onChange={e => setInstruction(e.target.value)}
        disabled={running}
        rows={2}
        placeholder="Optional extra instruction (overrides the format's default)…"
        className="w-full resize-none rounded-md bg-app-bg border border-app-border px-2 py-1.5 text-xs focus:outline-none focus:border-accent"
      />

      {/*
        * How much story one section covers.
        *
        * This is the control that decides whether a long read is a summary or a
        * compression. It used to be implied by the context window alone, which
        * meant a reader who set 128k got the whole chat in ONE pass — and one
        * reply about a quarter of a million characters is a paragraph about the
        * ending. The window is now only a ceiling; this is the dial.
        */}
      <div>
        <div className="flex items-center justify-between text-[11px] opacity-80 mb-1">
          <span>Detail</span>
          <span className="font-mono">
            {storyChars > 0 ? `~${Math.max(1, Math.ceil(storyChars / budgetChars))} sections` : ''}
          </span>
        </div>
        <div className="grid grid-cols-4 gap-1">
          {READ_DETAILS.map(d => (
            <button
              key={d.id}
              onClick={() => setDetail(d.id)}
              disabled={running}
              title={d.hint}
              className={cn(
                'text-[11px] px-1.5 py-1 rounded-md border disabled:opacity-40',
                detail === d.id
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-app-border hover:bg-app-text/5',
              )}
            >
              {d.label}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-muted mt-0.5">
          {READ_DETAILS.find(d => d.id === detail)?.hint}
          {' · '}~{budgetChars.toLocaleString()} chars per section
          {', '}{(useAppStore.getState().aiAdvanced.maxTokens || DETAIL_OUTPUT[detail]).toLocaleString()} tokens to write it
        </p>
        {contextTokens > 0 && budgetChars < DETAIL_CHARS[detail] && (
          <p className="text-[10px] text-amber-500 mt-0.5">
            Sections are smaller than this setting asks for — your context
            ({contextTokens.toLocaleString()} tok) is the limit.
          </p>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between text-[11px] opacity-80 mb-1">
          <span>Context fill per chunk</span>
          <span className="font-mono">{Math.round(ratio * 100)}%</span>
        </div>
        <input
          type="range" min={0.5} max={0.95} step={0.05} value={ratio}
          onChange={e => setRatio(parseFloat(e.target.value))}
          disabled={running}
          className="w-full accent-accent"
        />
        <p className="text-[10px] text-muted mt-0.5">
          A ceiling only — how much of the window one pass may fill.
          {contextTokens > 0 ? ` Context ${contextTokens.toLocaleString()} tok.` : ' Context unset — set it in Advanced.'}
        </p>
      </div>

      {running ? (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px]">
            <span className="capitalize flex items-center gap-1.5">
              <Loader2 size={12} className="animate-spin" />
              {phase === 'reducing' ? 'Combining sections…' : `Reading section ${done + 1}/${Math.max(total, 1)}`}
            </span>
            <button onClick={stop} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-app-text/10 hover:bg-app-text/20">
              <Square size={10} /> Stop
            </button>
          </div>
          <div className="h-1.5 rounded-full bg-app-text/10 overflow-hidden">
            <div className="h-full bg-accent transition-all" style={{ width: `${phase === 'reducing' ? 100 : pct}%` }} />
          </div>
        </div>
      ) : (
        <button
          onClick={() => void run()}
          disabled={!base || !model}
          className="w-full py-2 rounded-lg bg-accent text-white font-medium disabled:opacity-40"
        >
          {mode === 'sheet' ? 'Fill the sheet from the story' : 'Summarize the whole story'}
        </button>
      )}

      {error && <p className="text-[11px] text-red-500">{error}</p>}
      {result && !running && (
        <div className="rounded-md border border-accent/40 bg-accent/[0.06] p-2 text-[11px]">
          <p className="font-medium text-accent mb-1">
            {mode === 'sheet' ? 'Done.' : 'Done — pinned as “Story summary”.'}
          </p>
          <p className="opacity-70 line-clamp-3 whitespace-pre-wrap">
            {mode === 'sheet' ? result : `${result.slice(0, 240)}…`}
          </p>
        </div>
      )}
    </div>
  );
};
