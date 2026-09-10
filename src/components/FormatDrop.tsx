/**
 * Bring your own form.
 *
 * The long read's format field is a textarea, which assumes the reader is
 * inventing the shape here and now. Usually they are not — the anatomy chart,
 * the stat block, the location sheet already exists as a JSON file, an XML
 * fragment, a markdown template, or a scrap of labels pasted out of a notes
 * app. This takes that and makes it the format.
 *
 * Everything true about the result is in `formatSpec.ts`; the important half is
 * that the reader's literal text is what gets restated to the model on every
 * pass. This component's only job is to accept it three ways — drop, pick,
 * paste — and to say back what it understood, so a form that parsed into
 * nothing is visible as such before a twenty-pass run rather than after.
 */

import { useRef, useState } from 'react';
import { FileUp, Loader2, Upload, Wand2, X } from 'lucide-react';
import { useAppStore } from '../store';
import { askText } from '../utils/aiCall';
import { candidateBases } from '../utils/aiClient';
import {
  buildDraftPrompt, ideaProblem, readDraft, type DraftShape,
} from '../utils/formatDraft';
import {
  describeFormat, formatProblem, parseFormat, renderFormatInstruction,
} from '../utils/formatSpec';
import { cn } from '../utils/cn';

interface FormatDropProps {
  /** Called with the rendered instruction, ready to be a `format`. */
  onFormat: (instruction: string, title: string) => void;
  /** Shown on the button. */
  label?: string;
  className?: string;
}

/** Text-ish files only — a form is text, and a 4MB PDF is a mistake. */
const ACCEPT = '.json,.xml,.md,.markdown,.txt,.yaml,.yml,.csv,text/*,application/json,application/xml';
const MAX_FILE_BYTES = 512 * 1024;

export const FormatDrop = ({ onFormat, label = 'Use a form', className }: FormatDropProps) => {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [asking, setAsking] = useState(false);
  const [idea, setIdea] = useState('');
  const [shape, setShape] = useState<DraftShape>('auto');
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [examples, setExamples] = useState<string[]>([]);
  const aiReady = useAppStore(s => !!s.aiBaseUrl && !!s.aiModel);

  const draft = async () => {
    const problem = ideaProblem(idea);
    if (problem) { setDraftError(problem); return; }
    const app = useAppStore.getState();
    setDrafting(true);
    setDraftError(null);
    setExamples([]);
    try {
      const reply = await askText(
        { base: candidateBases(app.aiBaseUrl)[0], key: app.aiApiKey, model: app.aiModel },
        [{ role: 'user', content: buildDraftPrompt(idea, shape) }],
        // Cool: this is structure, not writing, and a warm model starts
        // inventing fields nobody asked for — which is one of the two things
        // the prompt spends its length forbidding.
        { label: 'Drafting a form', params: { temperature: 0.2 }, budget: 900 },
      );
      const result = readDraft(reply);
      if (result.rejected) { setDraftError(result.rejected); return; }
      // Into the box, not straight into use. Everything after this is the
      // path a pasted form already takes, including the parse and the refusal.
      setText(result.text);
      setExamples(result.examples);
      setAsking(false);
      setError(null);
    } catch (e: any) {
      setDraftError(String(e?.message ?? e));
    } finally {
      setDrafting(false);
    }
  };

  const spec = text.trim() ? parseFormat(text) : null;
  const problem = text.trim() ? formatProblem(text) : null;

  const readFile = async (file: File) => {
    setError(null);
    if (file.size > MAX_FILE_BYTES) {
      setError(`${file.name} is ${Math.round(file.size / 1024)}KB. A form should be the shape, not the content.`);
      return;
    }
    try {
      setText(await file.text());
    } catch {
      setError('That file could not be read as text.');
    }
  };

  const apply = () => {
    if (!spec || problem) return;
    onFormat(renderFormatInstruction(spec), spec.title);
    setOpen(false);
    setText('');
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        data-testid="format-drop-open"
        className={cn(
          'flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-md border border-app-border hover:bg-app-text/5',
          className,
        )}
      >
        <FileUp size={12} /> {label}
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-app-border overflow-hidden" data-testid="format-drop">
      <div className="flex items-center gap-2 px-2 py-1.5 bg-app-text/[0.03] border-b border-app-border/60">
        <FileUp size={12} className="text-accent shrink-0" />
        <span className="text-[11px] font-medium">Use a form</span>
        <button
          onClick={() => { setOpen(false); setText(''); setError(null); }}
          className="ml-auto p-0.5 rounded hover:bg-app-text/10 opacity-70 hover:opacity-100"
          aria-label="Cancel"
        >
          <X size={12} />
        </button>
      </div>

      <div
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void readFile(file);
          else {
            // A drag out of another app is often text, not a file.
            const dropped = e.dataTransfer.getData('text/plain');
            if (dropped) setText(dropped);
          }
        }}
        className={cn('p-2 space-y-2 transition-colors', dragging && 'bg-accent/10')}
      >
        <textarea
          value={text}
          onChange={e => { setText(e.target.value); setError(null); }}
          rows={7}
          placeholder={'Paste your form, or drop a file.\n\n{\n  "anatomy": {\n    "limbs": ["name and what it does"]\n  }\n}'}
          aria-label="The form to use"
          data-testid="format-drop-text"
          className="w-full text-[11px] font-mono rounded-lg border border-app-border bg-transparent px-2 py-1.5 resize-y"
        />

        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={e => {
            const file = e.target.files?.[0];
            if (file) void readFile(file);
            e.target.value = '';
          }}
        />

        {error && <p className="text-[11px] text-red-500">{error}</p>}
        {!error && problem && <p className="text-[11px] text-amber-500">{problem}</p>}
        {!error && !problem && spec && (
          <p className="text-[11px] text-muted" data-testid="format-drop-read">
            {describeFormat(spec)}
          </p>
        )}

        {/* Describing a form instead of writing one.
          *
          * Folded away until asked for: the box above is the feature, and this
          * is the way out for somebody who has an idea rather than a file. It
          * writes INTO that box rather than applying anything, so whatever comes
          * back is editable, checkable, and refusable like any pasted form —
          * which matters, because what comes back is going to be restated to a
          * model on every pass of a long read. */}
        {asking && (
          <div className="space-y-1.5 rounded-lg border border-accent/30 bg-accent/[0.04] p-2">
            <textarea
              value={idea}
              onChange={e => { setIdea(e.target.value); setDraftError(null); }}
              rows={3}
              placeholder="An anatomy chart: each limb, its condition, and any injuries — plus a line for overall state."
              aria-label="What the document should contain"
              data-testid="format-idea"
              className="w-full text-[11px] rounded-md border border-app-border bg-transparent px-2 py-1.5 resize-y"
            />
            <div className="flex items-center gap-1.5">
              <select
                value={shape}
                onChange={e => setShape(e.target.value as DraftShape)}
                aria-label="Shape"
                className="text-[11px] rounded-md border border-app-border bg-transparent px-1.5 py-1"
              >
                <option value="auto">Any shape</option>
                <option value="json">JSON</option>
                <option value="markdown">Headings</option>
                <option value="outline">Outline</option>
              </select>
              <div className="flex-1" />
              <button
                onClick={() => { setAsking(false); setDraftError(null); }}
                className="text-[11px] px-2 py-1 rounded-md border border-app-border hover:bg-app-text/5"
              >
                Cancel
              </button>
              <button
                onClick={draft}
                disabled={drafting || !!ideaProblem(idea)}
                data-testid="format-draft"
                className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-md bg-accent text-white disabled:opacity-40"
              >
                {drafting ? <Loader2 size={11} className="animate-spin" /> : <Wand2 size={11} />}
                {drafting ? 'Writing…' : 'Write it'}
              </button>
            </div>
            {draftError && <p className="text-[11px] text-amber-500">{draftError}</p>}
            {!draftError && examples.length > 0 && (
              <p className="text-[11px] text-amber-500">
                {/* Advisory, not a refusal — see `exampleValues`. A form is
                    restated on every pass, so example content quietly steers
                    twenty of them. */}
                Some placeholders read like content rather than instructions ({examples.join(', ')}).
                Edit them above if they were not meant as examples.
              </p>
            )}
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-app-border hover:bg-app-text/5"
          >
            <Upload size={11} /> Choose a file
          </button>
          {aiReady && !asking && (
            <button
              onClick={() => setAsking(true)}
              data-testid="format-assist"
              title="Describe what you want and have it written as a form"
              className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-accent/40 text-accent hover:bg-accent/10"
            >
              <Wand2 size={11} /> Help me write one
            </button>
          )}
          <div className="flex-1" />
          <button
            onClick={apply}
            disabled={!spec || !!problem}
            data-testid="format-drop-apply"
            className="text-[11px] px-2.5 py-1 rounded-md bg-accent text-white disabled:opacity-40"
          >
            Use this form
          </button>
        </div>
      </div>
    </div>
  );
};
