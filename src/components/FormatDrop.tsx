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
import { FileUp, Upload, X } from 'lucide-react';
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

        <div className="flex items-center gap-2">
          <button
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-app-border hover:bg-app-text/5"
          >
            <Upload size={11} /> Choose a file
          </button>
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
