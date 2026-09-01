import { useMemo, useRef, useState } from 'react';
import {
  ArrowDown, ArrowUp, ListOrdered, Loader2, Square, Trash2, X,
} from 'lucide-react';
import { useAppStore } from '../store';
import { flushV2, useAuraV2Store } from '../stores/useAuraV2Store';
import { buildZoneBody, zoneSummary } from '../utils/contextZone';
import { resolveContent } from '../utils/lens';
import { askText } from '../utils/aiCall';
import { LONG_READ_JOBS } from '../utils/longRead';
import { ZoneSection, ZoneTask, runZoneTask, taskFromJob } from '../utils/zoneTask';
import { cn } from '../utils/cn';

/**
 * Tasks: read these zones, in this order, into that document.
 *
 * The long read next door walks a whole story cut by budget. This walks a list
 * the reader made — and the difference that matters is that a task is SAVED.
 * The document's shape is authored once and restated to the model on every
 * pass, so re-running after editing zone two produces the same document with
 * new material rather than a new document that happens to be about the same
 * thing.
 *
 * It lands as a version of a pin the reader chooses, so the dock accumulates
 * versions of one document instead of four pins with the same name.
 */
export const TaskPanel = ({
  base, apiKey, model, onClose,
}: {
  base: string;
  apiKey: string;
  model: string;
  onClose: () => void;
}) => {
  const storyId = useAppStore(s => s.currentStory?.id);
  const tasks = useAuraV2Store(s => (storyId ? s.tasksByStory[storyId] : undefined)) ?? [];
  const zones = useAuraV2Store(s => (storyId ? s.zonesByStory[storyId] : undefined)) ?? [];
  const pins = useAuraV2Store(s => (storyId ? s.pinsByStory[storyId] : undefined)) ?? [];
  const chains = useAppStore(s => s.chains);
  const timelines = useAppStore(s => s.currentStory?.timelines) ?? [];

  const [selectedId, setSelectedId] = useState<string>(tasks[0]?.id ?? '');
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const task = tasks.find(t => t.id === selectedId);
  const zoneName = (id: string) => zones.find(z => z.id === id)?.name ?? '(deleted zone)';
  const summaries = useMemo(
    () => Object.fromEntries(zones.map(z => [z.id, zoneSummary(z, chains, timelines)])),
    [zones, chains, timelines],
  );

  const patch = (updates: Partial<Omit<ZoneTask, 'id'>>) => {
    if (storyId && task) useAuraV2Store.getState().updateTask(storyId, task.id, updates);
  };

  const create = (jobId: string) => {
    if (!storyId) return;
    const job = LONG_READ_JOBS.find(j => j.id === jobId) ?? LONG_READ_JOBS[0];
    const seed = taskFromJob(job, `New ${job.label.toLowerCase()}`, 'draft');
    const id = useAuraV2Store.getState().addTask(storyId, {
      name: seed.name,
      zoneIds: [],
      purpose: seed.purpose,
      format: seed.format,
      keyBrief: seed.keyBrief,
      // Front matter off by default: rewriting the top of the document on every
      // run is exactly the "remaking the form each time" a task exists to stop.
      assemble: undefined,
      targetPinId: null,
    });
    setSelectedId(id);
    setShowForm(true);
  };

  const moveZone = (index: number, dir: -1 | 1) => {
    if (!task) return;
    const next = [...task.zoneIds];
    const to = index + dir;
    if (to < 0 || to >= next.length) return;
    [next[index], next[to]] = [next[to], next[index]];
    patch({ zoneIds: next });
  };

  const run = async () => {
    const app = useAppStore.getState();
    const story = app.currentStory;
    if (!story || !task || !base || !model || running) return;
    if (!task.zoneIds.length) { setError('This task has no zones yet.'); return; }

    const v2 = useAuraV2Store.getState();
    const overrides = v2.overridesByStory[story.id];
    const lensOn = !!v2.lensOnByStory[story.id];
    // The same text the reader sees, Lens included — a document quoting the
    // raw JSON back at someone who has rewritten it quotes a story that no
    // longer exists for them.
    const text = (m: { id: string; content: string }) =>
      resolveContent(m as never, overrides, lensOn);

    const sections: ZoneSection[] = task.zoneIds.map(id => {
      const zone = zones.find(z => z.id === id);
      if (!zone) return { zoneId: id, name: '(deleted zone)', body: '' };
      const built = buildZoneBody(zone, app.chains, text, story.timelines ?? []);
      return { zoneId: id, name: zone.name, body: built.empty ? '' : built.body };
    });

    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const out = await runZoneTask({
        task,
        sections,
        card: story.card,
        title: story.title,
        signal: controller.signal,
        // Through the shared call layer, so a thinking model's chain of thought
        // never lands in the document and a reply that ran out of room mid-
        // thought is retried rather than reported as an empty section.
        send: (messages, signal) => askText({ base, key: apiKey, model }, messages,
          { label: 'Running task', params: { temperature: 0.3 }, signal }),
        onPhase: (p, d, t, name) => setPhase(
          p === 'assembling' ? 'Writing the front matter…'
            : p === 'done' ? ''
              : `Reading ${name ?? ''} (${d + 1}/${t})`,
        ),
      });

      if (!out.document) {
        setError(out.skipped.length === sections.length
          ? 'Every zone in this task is empty.'
          : 'Nothing came back to build a document from.');
        return;
      }

      const now = useAuraV2Store.getState();
      let pinId = task.targetPinId;
      let version: number | null = null;
      const target = pinId ? (now.pinsByStory[story.id] ?? []).find(p => p.id === pinId) : undefined;
      if (target) {
        now.addPinVersion(story.id, target.id, {
          content: out.document, source: 'ai', instruction: task.name,
        });
        const after = (useAuraV2Store.getState().pinsByStory[story.id] ?? []).find(p => p.id === target.id);
        version = after ? (after.activeVersion ?? 0) + 1 : null;
      } else {
        // No target, or the reader deleted it: make one and remember it, so the
        // NEXT run versions this document rather than making a second pin.
        // '' means the story is at its pin cap — say so rather than reporting a
        // version number for a pin that was never made.
        pinId = now.addPin(story.id, {
          title: task.name, format: 'markdown', content: out.document,
          inContext: false, docked: true,
        }) || null;
        if (!pinId) {
          setError('This story is at its pin limit, so the document was not saved. '
            + 'Delete a pin, or point the task at an existing one, and run again.');
          return;
        }
        version = 1;
        if (storyId) useAuraV2Store.getState().updateTask(storyId, task.id, { targetPinId: pinId });
      }
      if (storyId) useAuraV2Store.getState().recordTaskRun(storyId, task.id, out.sections, version);
      // Minutes of work; it does not wait on the debounce.
      void flushV2();
      setResult(
        `${out.sections} section${out.sections === 1 ? '' : 's'} → version ${version ?? '?'}`
        + (out.skipped.length ? ` · skipped ${out.skipped.join(', ')}` : '')
        + (out.aborted ? ' · stopped early' : '')
        + (out.malformed ? ` · ⚠ ${out.malformed} pass${out.malformed === 1 ? '' : 'es'} ignored the format` : ''),
      );
    } catch (e: any) {
      if (!controller.signal.aborted) setError(e?.message ?? 'The task failed.');
    } finally {
      setRunning(false);
      setPhase('');
      abortRef.current = null;
    }
  };

  const unused = zones.filter(z => !task?.zoneIds.includes(z.id));

  return (
    <div className="absolute inset-0 z-20 bg-app-surface flex flex-col">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-app-border shrink-0">
        <ListOrdered size={15} className="text-accent" />
        <span className="text-sm font-medium">Tasks</span>
        <div className="flex-1" />
        <button onClick={onClose} className="p-1 rounded hover:bg-app-text/10" title="Close">
          <X size={15} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3 text-sm">
        {!zones.length && (
          <p className="text-xs text-muted">
            A task reads context zones in order. Make a zone first — the ⧉ button beside
            the scope selector.
          </p>
        )}

        {/* Which task */}
        <div className="flex flex-wrap items-center gap-1.5">
          {tasks.map(t => (
            <button
              key={t.id}
              onClick={() => { setSelectedId(t.id); setResult(null); setError(null); }}
              className={cn(
                'text-xs px-2.5 py-1 rounded-full border',
                t.id === selectedId
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-app-border hover:bg-app-text/5',
              )}
            >
              {t.name}
            </button>
          ))}
          <select
            value=""
            onChange={e => e.target.value && create(e.target.value)}
            className="text-xs px-2 py-1 rounded-full border border-app-border bg-transparent"
            aria-label="New task from a format"
            data-testid="new-task"
          >
            <option value="">+ New task…</option>
            {LONG_READ_JOBS.map(j => (
              <option key={j.id} value={j.id}>from {j.label.toLowerCase()}</option>
            ))}
          </select>
        </div>

        {task && (
          <>
            <input
              value={task.name}
              onChange={e => patch({ name: e.target.value })}
              className="w-full text-sm rounded-lg border border-app-border bg-transparent px-2.5 py-1.5"
              aria-label="Task name"
            />

            {/* The order. This is the content of the task. */}
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted mb-1">
                Zones, in reading order
              </p>
              {!task.zoneIds.length && (
                <p className="text-xs text-muted mb-1">Nothing yet — add one below.</p>
              )}
              <div className="space-y-1">
                {task.zoneIds.map((id, i) => (
                  <div
                    key={`${id}-${i}`}
                    className="flex items-center gap-1.5 rounded-lg border border-app-border px-2 py-1"
                    data-testid="task-zone"
                  >
                    <span className="text-[10px] font-mono tabular-nums text-muted w-4">{i + 1}</span>
                    <span className="flex-1 truncate text-xs">
                      {zoneName(id)}
                      <span className="text-muted"> · {summaries[id] ?? 'gone'}</span>
                    </span>
                    <button
                      onClick={() => moveZone(i, -1)}
                      disabled={i === 0}
                      className="p-0.5 rounded hover:bg-app-text/10 disabled:opacity-25"
                      title="Move up"
                    >
                      <ArrowUp size={12} />
                    </button>
                    <button
                      onClick={() => moveZone(i, 1)}
                      disabled={i === task.zoneIds.length - 1}
                      className="p-0.5 rounded hover:bg-app-text/10 disabled:opacity-25"
                      title="Move down"
                    >
                      <ArrowDown size={12} />
                    </button>
                    <button
                      onClick={() => patch({ zoneIds: task.zoneIds.filter((_, k) => k !== i) })}
                      className="p-0.5 rounded hover:bg-app-text/10 hover:text-red-500"
                      title="Remove from this task"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
              {!!unused.length && (
                <select
                  value=""
                  onChange={e => e.target.value && patch({ zoneIds: [...task.zoneIds, e.target.value] })}
                  className="mt-1 w-full text-xs px-2 py-1 rounded-lg border border-app-border bg-transparent"
                  aria-label="Add a zone"
                  data-testid="add-zone"
                >
                  <option value="">+ Add a zone…</option>
                  {unused.map(z => <option key={z.id} value={z.id}>{z.name}</option>)}
                </select>
              )}
            </div>

            {/* Where it lands */}
            <label className="block">
              <span className="text-[11px] uppercase tracking-wide text-muted">Lands in</span>
              <select
                value={task.targetPinId ?? ''}
                onChange={e => patch({ targetPinId: e.target.value || null })}
                className="mt-1 w-full text-xs px-2 py-1.5 rounded-lg border border-app-border bg-transparent"
                data-testid="task-target"
              >
                <option value="">a new pin called “{task.name}”</option>
                {pins.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.title}{p.versions?.length ? ` (v${p.versions.length})` : ''}
                  </option>
                ))}
              </select>
              <span className="text-[10px] text-muted">
                Each run adds a version. Nothing is overwritten.
              </span>
            </label>

            <button
              onClick={() => setShowForm(v => !v)}
              className="text-xs text-accent hover:underline"
            >
              {showForm ? 'Hide the document’s shape' : 'Edit the document’s shape'}
            </button>

            {showForm && (
              <div className="space-y-2">
                <label className="block">
                  <span className="text-[11px] uppercase tracking-wide text-muted">What it is</span>
                  <input
                    value={task.purpose}
                    onChange={e => patch({ purpose: e.target.value })}
                    className="mt-1 w-full text-xs rounded-lg border border-app-border bg-transparent px-2 py-1.5"
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] uppercase tracking-wide text-muted">
                    The shape of each section — restated on every pass
                  </span>
                  <textarea
                    value={task.format}
                    onChange={e => patch({ format: e.target.value })}
                    rows={8}
                    className="mt-1 w-full text-xs font-mono rounded-lg border border-app-border bg-transparent px-2 py-1.5 resize-y"
                    data-testid="task-format"
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] uppercase tracking-wide text-muted">
                    What it carries between sections
                  </span>
                  <textarea
                    value={task.keyBrief}
                    onChange={e => patch({ keyBrief: e.target.value })}
                    rows={4}
                    className="mt-1 w-full text-xs font-mono rounded-lg border border-app-border bg-transparent px-2 py-1.5 resize-y"
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] uppercase tracking-wide text-muted">
                    Your steer, applied to every pass (optional)
                  </span>
                  <input
                    value={task.instruction ?? ''}
                    onChange={e => patch({ instruction: e.target.value })}
                    className="mt-1 w-full text-xs rounded-lg border border-app-border bg-transparent px-2 py-1.5"
                  />
                </label>
                <label className="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={!!task.assemble}
                    onChange={e => patch({
                      assemble: e.target.checked
                        ? (LONG_READ_JOBS.find(j => j.format === task.format)?.assemble
                          ?? LONG_READ_JOBS[0].assemble)
                        : undefined,
                    })}
                    className="mt-0.5"
                  />
                  <span>
                    Write front matter at the end
                    <span className="block text-[10px] text-muted">
                      Costs one more pass, and rewrites the top of the document on every run.
                    </span>
                  </span>
                </label>
              </div>
            )}

            {task.lastRun && (
              <p className="text-[11px] text-muted">
                Last run {new Date(task.lastRun.at).toLocaleString()} ·
                {' '}{task.lastRun.sections} section{task.lastRun.sections === 1 ? '' : 's'}
                {task.lastRun.pinVersion ? ` · version ${task.lastRun.pinVersion}` : ''}
              </p>
            )}

            <div className="flex items-center gap-2">
              <button
                onClick={run}
                disabled={running || !task.zoneIds.length || !base || !model}
                className="text-xs px-3 py-1.5 rounded-full bg-accent text-white disabled:opacity-40"
                data-testid="run-task"
              >
                {running ? <Loader2 size={13} className="animate-spin" /> : 'Run'}
              </button>
              {running && (
                <button
                  onClick={() => abortRef.current?.abort()}
                  className="text-xs px-2.5 py-1.5 rounded-full border border-app-border hover:bg-app-text/5"
                >
                  <Square size={12} />
                </button>
              )}
              {phase && <span className="text-[11px] text-muted">{phase}</span>}
              <div className="flex-1" />
              <button
                onClick={() => {
                  if (!storyId) return;
                  useAuraV2Store.getState().removeTask(storyId, task.id);
                  setSelectedId('');
                }}
                className="p-1 rounded hover:bg-app-text/10 hover:text-red-500"
                title="Delete this task"
              >
                <Trash2 size={13} />
              </button>
            </div>

            {result && <p className="text-xs text-accent" data-testid="task-result">{result}</p>}
            {error && <p className="text-xs text-red-500">{error}</p>}
          </>
        )}
      </div>
    </div>
  );
};
