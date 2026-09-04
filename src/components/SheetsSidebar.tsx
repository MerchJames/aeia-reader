import React, { useMemo, useState, useTransition } from 'react';
import {
  BookOpen, Bot, Check, ChevronLeft, Copy, FileSpreadsheet, Layers, Loader2, PanelRight, Pin,
  Plus, Sparkles, Table2, Trash2, X,
} from 'lucide-react';
import { useAppStore } from '../store';
import { committedCount, flatMessages, useAuraV2Store } from '../stores/useAuraV2Store';
import { Sheet } from '../types';
import { pagesOf } from '../utils/pinBook';
import { askText, salvageArray, salvageObject } from '../utils/aiCall';
import { cn } from '../utils/cn';
import { downloadText, safeFilename } from '../utils/exporter';

const newId = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const DEFAULT_COLUMNS = ['Name', 'Note'];

const sheetToCsv = (sheet: Sheet): string => {
  const cols = sheet.columns.length ? sheet.columns : DEFAULT_COLUMNS;
  const escape = (v: string) => {
    const s = String(v ?? '').replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  return [
    cols.map(escape).join(','),
    ...sheet.rows.map(r => cols.map(c => escape(r[c] ?? '')).join(',')),
  ].join('\n');
};

const parseCsv = (text: string): { columns: string[]; rows: Record<string, string>[] } => {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length === 0) return { columns: [], rows: [] };
  const columns = lines[0].split(',').map(c => c.trim().replace(/^"|"$/g, '').replace(/""/g, '"'));
  const rows = lines.slice(1).map(line => {
    const cells: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = line[i + 1];
      if (ch === '"' && inQuotes && next === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQuotes = !inQuotes; }
      else if (ch === ',' && !inQuotes) { cells.push(cur); cur = ''; }
      else { cur += ch; }
    }
    cells.push(cur);
    const row: Record<string, string> = {};
    columns.forEach((c, i) => { row[c] = cells[i]?.trim().replace(/^"|"$/g, '').replace(/""/g, '"') ?? ''; });
    return row;
  });
  return { columns, rows };
};

const readText = (storyId: string): string => {
  const s = useAppStore.getState();
  const readCount = s.chains.length === 0
    ? 0
    : committedCount(s.chains, s.currentChainIndex, s.currentMessageIndex, !!s.streamingMessage);
  return flatMessages(s.chains)
    .slice(0, readCount)
    .map(m => `${m.name}: ${m.content}`)
    .join('\n\n')
    .slice(-12_000);
};

interface Finding {
  quote: string;
  issue: string;
  messageId?: string;
  saved?: boolean;
}

const normText = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Anchor a finding's quote to the read-so-far message it came from. */
const locateQuote = (quote: string): string | undefined => {
  const q = normText(quote).slice(0, 100);
  if (q.length < 8) return undefined;
  const s = useAppStore.getState();
  const readCount = s.chains.length === 0
    ? 0
    : committedCount(s.chains, s.currentChainIndex, s.currentMessageIndex, !!s.streamingMessage);
  for (const m of flatMessages(s.chains).slice(0, readCount)) {
    if (normText(m.content).includes(q)) return m.id;
  }
  return undefined;
};

const parseFindings = (reply: string): Finding[] | null => {
  try {
    // Shared salvage: fences, prose either side, a chain of thought, and a
    // reply cut off at the token limit are all ordinary here, and a strict
    // parse turned any of them into "AI action failed".
    const parsed = salvageArray(reply);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter((f: any) => f && typeof f.issue === 'string')
      .slice(0, 20)
      .map((f: any) => {
        const quote = typeof f.quote === 'string' ? f.quote.slice(0, 200) : '';
        return { quote, issue: f.issue, messageId: quote ? locateQuote(quote) : undefined };
      });
  } catch {
    return null;
  }
};

const NO_SETS: import('../types').PinSet[] = [];

/**
 * Named, swappable pin arrangements ("saved views"). Saving a set snapshots
 * which pins are docked and which are flagged for AI context; clicking a set
 * re-applies both across the shared pin pool. While a set is active, any pin
 * or Bot-button toggle flows straight back into it (see the store's
 * mirrorActiveSet), so a set always reflects your latest choices.
 */
const PinSetBar = ({ storyId }: { storyId: string }) => {
  const sets = useAuraV2Store(s => s.pinSetsByStory[storyId] ?? NO_SETS);
  const activeId = useAuraV2Store(s => s.activePinSetByStory[storyId] ?? null);
  const createPinSet = useAuraV2Store(s => s.createPinSet);
  const applyPinSet = useAuraV2Store(s => s.applyPinSet);
  const renamePinSet = useAuraV2Store(s => s.renamePinSet);
  const duplicatePinSet = useAuraV2Store(s => s.duplicatePinSet);
  const removePinSet = useAuraV2Store(s => s.removePinSet);
  const setActivePinSet = useAuraV2Store(s => s.setActivePinSet);

  const saveCurrent = () => {
    const name = window.prompt('Name this pin set:', `Set ${sets.length + 1}`);
    if (name !== null) createPinSet(storyId, name);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-bold uppercase tracking-wider text-muted flex items-center gap-1.5">
          <Layers size={11} /> Pin sets
        </p>
        <button
          onClick={saveCurrent}
          title="Save the current arrangement — which pins are docked and which are in AI context — as a new set"
          className="flex items-center gap-1 text-[10px] font-medium text-muted hover:text-app-text px-1.5 py-0.5 rounded-md hover:bg-app-text/10"
        >
          <Plus size={11} /> Save current
        </button>
      </div>
      {sets.length === 0 ? (
        <p className="text-[11px] text-muted leading-snug">
          Save your docked pins and AI-context picks as a named set, then swap between
          sets anytime — switching restores both what's shown and what the AI sees.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {sets.map(s => {
            const active = s.id === activeId;
            return (
              <div
                key={s.id}
                className={cn(
                  'group flex items-center rounded-full border text-[11px] transition-colors',
                  active
                    ? 'border-accent bg-accent/15 text-accent'
                    : 'border-app-border bg-app-text/5 hover:bg-app-text/10',
                )}
              >
                <button
                  onClick={() => (active ? setActivePinSet(storyId, null) : applyPinSet(storyId, s.id))}
                  onDoubleClick={() => {
                    const name = window.prompt('Rename pin set:', s.name);
                    if (name !== null) renamePinSet(storyId, s.id, name);
                  }}
                  title={`${s.docked.length} shown · ${s.inContext.length} in AI context${active ? ' — click to deactivate' : ''}\nDouble-click to rename`}
                  className="pl-2.5 pr-1 py-1 font-medium max-w-[9rem] truncate"
                >
                  {s.name}
                </button>
                <span className="flex items-center gap-0.5 pr-1 text-[9px] opacity-70" title={`${s.inContext.length} pins fed to the AI`}>
                  <Bot size={9} />{s.inContext.length}
                </span>
                <button
                  onClick={() => duplicatePinSet(storyId, s.id)}
                  title="Duplicate this set"
                  className="p-0.5 opacity-0 group-hover:opacity-60 hover:!opacity-100"
                >
                  <Copy size={10} />
                </button>
                <button
                  onClick={() => {
                    if (window.confirm(`Delete pin set "${s.name}"? Your pins are kept.`)) removePinSet(storyId, s.id);
                  }}
                  title="Delete this set (pins are kept)"
                  className="p-0.5 pr-1.5 opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:!text-red-500"
                >
                  <X size={10} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

/**
 * Sheets, as a column of the Codex.
 *
 * They used to be their own right-hand drawer, sharing it with the pins — two
 * unrelated things in one panel because both happened to be "stuff beside the
 * story". But a sheet is a tracker of who and what and where, which is exactly
 * what the Codex already is; and the pins are documents, which is a different
 * job entirely. So the sheets moved in with their relatives and the drawer
 * became what it was mostly being used for.
 *
 * No drawer chrome here: this renders inside whatever is hosting it.
 */
export const SheetsPanel = () => {
  const currentSheetId = useAuraV2Store(s => s.currentSheetId);
  const setCurrentSheetId = useAuraV2Store(s => s.setCurrentSheetId);
  const addSheet = useAuraV2Store(s => s.addSheet);
  const updateSheet = useAuraV2Store(s => s.updateSheet);
  const removeSheet = useAuraV2Store(s => s.removeSheet);
  const addSheetRow = useAuraV2Store(s => s.addSheetRow);
  const updateSheetCell = useAuraV2Store(s => s.updateSheetCell);
  const removeSheetRow = useAuraV2Store(s => s.removeSheetRow);
  const addAnnotation = useAuraV2Store(s => s.addAnnotation);
  const updatePin = useAuraV2Store(s => s.updatePin);
  const removePin = useAuraV2Store(s => s.removePin);

  const story = useAppStore(s => s.currentStory);
  const sheets = useAuraV2Store(s => (story ? s.sheetsByStory[story.id] : undefined));
  const pins = useAuraV2Store(s => (story ? s.pinsByStory[story.id] : undefined));
  const aiConfigured = useAppStore(s => !!(s.aiBaseUrl && s.aiModel));

  const [aiBusy, startAi] = useTransition();
  const [aiAction, setAiAction] = useState<string | null>(null);
  const [aiReport, setAiReport] = useState<string | null>(null);
  const [findings, setFindings] = useState<Finding[] | null>(null);

  const currentSheet = useMemo(
    () => sheets?.find(s => s.id === currentSheetId) ?? sheets?.[0] ?? null,
    [sheets, currentSheetId],
  );

  if (!story) return null;

  const createSheet = () => {
    addSheet(story.id, { title: 'New sheet', columns: DEFAULT_COLUMNS, rows: [] });
  };

  const runAi = (action: 'draft' | 'update' | 'continuity') => {
    if (!aiConfigured || !currentSheet) return;
    setAiAction(action);
    setAiReport(null);
    setFindings(null);
    startAi(async () => {
      try {
        const s = useAppStore.getState();
        const text = readText(story.id);
        const sheetJson = JSON.stringify({ title: currentSheet.title, columns: currentSheet.columns, rows: currentSheet.rows });
        let system = '';
        let user = '';
        if (action === 'draft') {
          system = 'You are a reading assistant. Given a story excerpt, draft a concise table of important facts (characters, places, items, relationships, or anything the reader might want to track). Reply ONLY as a JSON object with keys: title (string), columns (string array), rows (array of objects keyed by column names). Do not wrap in markdown.';
          user = text;
        } else if (action === 'update') {
          system = 'You are a reading assistant. Given an existing tracking sheet and new story text, update the sheet: add new rows, fill empty cells, and do not remove existing data unless it is contradicted. Reply ONLY as a JSON object with keys: title (string), columns (string array), rows (array of objects keyed by column names). Do not wrap in markdown.';
          user = `Existing sheet:\n${sheetJson}\n\nNew text:\n${text}`;
        } else {
          system = 'You are a continuity checker. Compare the provided tracking sheet against the story text and find contradictions, outdated facts, or sheet entries the text disagrees with. Reply ONLY as a JSON array (no markdown, no prose): [{"quote": "<short verbatim excerpt (max 120 chars) copied exactly from the story text where the problem shows>", "issue": "<one-sentence description of the contradiction>"}]. Reply [] if everything is consistent.';
          user = `Sheet:\n${sheetJson}\n\nStory text:\n${text}`;
        }
        const reply = await askText({ base: s.aiBaseUrl, key: s.aiApiKey, model: s.aiModel }, [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ], { label: action === 'continuity' ? 'Checking continuity' : 'Filling the sheet' });
        if (action === 'continuity') {
          const parsed = parseFindings(reply);
          // Structured findings with jump links when the model cooperates;
          // its raw text as a plain report when it doesn't.
          if (parsed) setFindings(parsed);
          else setAiReport(reply.trim());
        } else {
          const parsed = salvageObject<any>(reply);
          if (!parsed) throw new Error('the reply had no sheet in it');
          updateSheet(story.id, currentSheet.id, {
            title: String(parsed.title || currentSheet.title),
            columns: Array.isArray(parsed.columns) && parsed.columns.length
              ? parsed.columns.map(String)
              : currentSheet.columns,
            rows: Array.isArray(parsed.rows)
              ? parsed.rows.map((r: any) => Object.fromEntries(
                  Object.entries(r).map(([k, v]) => [k, String(v ?? '')]),
                ))
              : currentSheet.rows,
          });
        }
      } catch (e: any) {
        setAiReport(`AI action failed: ${e?.message ?? 'unknown error'}`);
      } finally {
        setAiAction(null);
      }
    });
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {!currentSheet ? (
        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center space-y-4">
          <FileSpreadsheet size={40} className="opacity-30" />
          <p className="text-sm text-muted">
            No sheets yet. Create a blank one or ask the AI to draft a table from the text you've read.
          </p>
          <button
            onClick={createSheet}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium hover:opacity-90"
          >
            <Plus size={15} /> New sheet
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 px-3 py-2 border-b border-app-border bg-app-text/[0.02]">
            <button
              onClick={() => setCurrentSheetId(null)}
              className="p-1.5 rounded-lg hover:bg-app-text/10"
              title="All sheets"
            >
              <ChevronLeft size={16} />
            </button>
            <input
              value={currentSheet.title}
              onChange={(e) => updateSheet(story.id, currentSheet.id, { title: e.target.value })}
              className="flex-1 bg-transparent font-bold text-sm outline-none min-w-0"
            />
            <button
              onClick={() => downloadText(`${safeFilename(story.title)}-${safeFilename(currentSheet.title)}.csv`, sheetToCsv(currentSheet))}
              className="p-1.5 rounded-lg hover:bg-app-text/10 text-xs text-muted"
              title="Export CSV"
            >
              CSV
            </button>
            <button
              onClick={() => removeSheet(story.id, currentSheet.id)}
              className="p-1.5 rounded-lg hover:bg-red-500/10 text-red-500"
              title="Delete sheet"
            >
              <Trash2 size={15} />
            </button>
          </div>

          <div className="flex items-center gap-2 px-3 py-2 border-b border-app-border flex-wrap">
            <button
              onClick={() => runAi('draft')}
              disabled={!aiConfigured || aiBusy}
              className="flex items-center gap-1 px-2 py-1 rounded-lg border border-app-border text-xs hover:bg-app-text/5 disabled:opacity-40"
            >
              {aiAction === 'draft' ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
              Draft
            </button>
            <button
              onClick={() => runAi('update')}
              disabled={!aiConfigured || aiBusy}
              className="flex items-center gap-1 px-2 py-1 rounded-lg border border-app-border text-xs hover:bg-app-text/5 disabled:opacity-40"
            >
              {aiAction === 'update' ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
              Update
            </button>
            <button
              onClick={() => runAi('continuity')}
              disabled={!aiConfigured || aiBusy}
              className="flex items-center gap-1 px-2 py-1 rounded-lg border border-app-border text-xs hover:bg-app-text/5 disabled:opacity-40"
            >
              {aiAction === 'continuity' ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              Check
            </button>
          </div>

          {aiReport && (
            <div className="mx-3 mt-2 p-2.5 rounded-lg bg-app-text/5 border border-app-border text-xs whitespace-pre-wrap">
              {aiReport}
            </div>
          )}

          {findings && (
            <div className="mx-3 mt-2 space-y-1.5 max-h-56 overflow-y-auto">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-bold uppercase tracking-wider text-muted">
                  Continuity check — {findings.length === 0 ? 'all clear' : `${findings.length} finding${findings.length === 1 ? '' : 's'}`}
                </p>
                <button
                  onClick={() => setFindings(null)}
                  className="p-1 rounded hover:bg-app-text/10 opacity-60 hover:opacity-100"
                  title="Dismiss report"
                >
                  <X size={12} />
                </button>
              </div>
              {findings.length === 0 ? (
                <p className="p-2.5 rounded-lg bg-app-text/5 border border-app-border text-xs">
                  The story matches this sheet — no contradictions found.
                </p>
              ) : (
                findings.map((f, i) => (
                  <div key={i} className="p-2.5 rounded-lg bg-app-text/5 border border-app-border text-xs space-y-1">
                    <p className="font-medium">{f.issue}</p>
                    {f.quote && <p className="italic opacity-70">“{f.quote}”</p>}
                    <div className="flex items-center gap-2 pt-0.5">
                      {f.messageId ? (
                        <>
                          <button
                            onClick={() => React.startTransition(() =>
                              useAppStore.getState().jumpToMessage(f.messageId!))}
                            className="px-2 py-0.5 rounded-md border border-app-border hover:bg-app-text/5 font-medium"
                          >
                            Go to
                          </button>
                          {f.saved ? (
                            <span className="flex items-center gap-1 text-muted">
                              <Check size={11} /> Saved
                            </span>
                          ) : (
                            <button
                              onClick={() => {
                                addAnnotation(story.id, {
                                  messageId: f.messageId!,
                                  anchorText: f.quote || undefined,
                                  note: `Continuity: ${f.issue}`,
                                  role: 'ai',
                                });
                                setFindings(prev => prev?.map((x, j) => (j === i ? { ...x, saved: true } : x)) ?? null);
                              }}
                              className="px-2 py-0.5 rounded-md border border-app-border hover:bg-app-text/5"
                            >
                              Save as note
                            </button>
                          )}
                        </>
                      ) : (
                        <span className="text-muted opacity-70">couldn't locate this passage</span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          <div className="flex-1 min-h-0 overflow-auto p-3">
            <SheetEditor
              sheet={currentSheet}
              onUpdate={(updates) => updateSheet(story.id, currentSheet.id, updates)}
              onAddRow={() => addSheetRow(story.id, currentSheet.id)}
              onUpdateCell={(rowIndex, column, value) => updateSheetCell(story.id, currentSheet.id, rowIndex, column, value)}
              onRemoveRow={(rowIndex) => removeSheetRow(story.id, currentSheet.id, rowIndex)}
            />
          </div>
        </>
      )}

      {currentSheet && (
        <div className="border-t border-app-border p-3">
          <button
            onClick={createSheet}
            className="flex items-center justify-center gap-1.5 w-full px-3 py-1.5 rounded-lg border border-app-border text-sm hover:bg-app-text/5"
          >
            <Plus size={15} /> Add another sheet
          </button>
        </div>
      )}
    </div>
  );
};

const SheetEditor = ({
  sheet, onUpdate, onAddRow, onUpdateCell, onRemoveRow,
}: {
  sheet: Sheet;
  onUpdate: (updates: Partial<Omit<Sheet, 'id'>>) => void;
  onAddRow: () => void;
  onUpdateCell: (rowIndex: number, column: string, value: string) => void;
  onRemoveRow: (rowIndex: number) => void;
}) => {
  const [editingColumns, setEditingColumns] = useState(false);
  const [columnText, setColumnText] = useState(sheet.columns.join(', '));

  const columns = sheet.columns.length ? sheet.columns : DEFAULT_COLUMNS;

  const saveColumns = () => {
    const next = columnText.split(',').map(c => c.trim()).filter(Boolean);
    onUpdate({ columns: next.length ? next : DEFAULT_COLUMNS });
    setEditingColumns(false);
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-muted">Columns</span>
          {editingColumns ? (
            <div className="flex items-center gap-1">
              <button onClick={saveColumns} className="p-1 rounded hover:bg-app-text/10"><Check size={12} /></button>
              <button onClick={() => { setEditingColumns(false); setColumnText(sheet.columns.join(', ')); }} className="p-1 rounded hover:bg-app-text/10"><X size={12} /></button>
            </div>
          ) : (
            <button onClick={() => setEditingColumns(true)} className="text-xs text-accent hover:underline">Edit</button>
          )}
        </div>
        {editingColumns ? (
          <input
            value={columnText}
            onChange={(e) => setColumnText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') saveColumns(); }}
            className="w-full bg-app-bg border border-app-border rounded px-2 py-1 text-xs"
            placeholder="Comma-separated column names"
          />
        ) : (
          <div className="flex flex-wrap gap-1">
            {columns.map(c => (
              <span key={c} className="px-2 py-0.5 rounded-full bg-app-text/10 text-xs">{c}</span>
            ))}
          </div>
        )}
      </div>

      <div className="border border-app-border rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-app-text/5">
            <tr>
              {columns.map(c => <th key={c} className="px-2 py-1.5 text-left font-semibold border-b border-app-border">{c}</th>)}
              <th className="px-2 py-1.5 border-b border-app-border w-8" />
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((row, i) => (
              <tr key={i} className="group border-b border-app-border/60 last:border-b-0">
                {columns.map(c => (
                  <td key={c} className="p-1 border-r border-app-border/40 last:border-r-0">
                    <input
                      value={row[c] ?? ''}
                      onChange={(e) => onUpdateCell(i, c, e.target.value)}
                      className="w-full bg-transparent px-1 py-0.5 outline-none focus:bg-app-text/5 rounded"
                    />
                  </td>
                ))}
                <td className="p-1 text-center">
                  <button
                    onClick={() => onRemoveRow(i)}
                    className="opacity-0 group-hover:opacity-60 hover:!opacity-100 p-1 rounded hover:bg-red-500/10 text-red-500"
                  >
                    <Trash2 size={12} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {sheet.rows.length === 0 && (
          <div className="p-4 text-center text-xs text-muted">No rows yet.</div>
        )}
      </div>

      <button
        onClick={onAddRow}
        className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-app-border text-xs hover:bg-app-text/5"
      >
        <Plus size={13} /> Add row
      </button>
    </div>
  );
};

/**
 * The Pins drawer — everything the reader has kept beside the story.
 *
 * This is the panel the toolbar's third button opens. It used to be "Sheets",
 * with the pins bolted to the bottom of it in a 288px-tall scroller; in
 * practice the pins were what people came for and the sheets were the thing in
 * the way, so they swapped places. Sheets are a Codex column now.
 *
 * Three things live here, in the order a reader reaches for them: the SETS
 * (which arrangement of pins is on), the pins themselves, and — on each one —
 * the two switches that decide where a pin is (docked in the margin) and
 * whether the assistant can see it.
 */
export const PinsSidebar = () => {
  const open = useAuraV2Store(s => s.sheetsOpen);
  const setOpen = useAuraV2Store(s => s.setSheetsOpen);
  const updatePin = useAuraV2Store(s => s.updatePin);
  const removePin = useAuraV2Store(s => s.removePin);
  const mergePinPages = useAuraV2Store(s => s.mergePinPages);
  const story = useAppStore(s => s.currentStory);
  const pins = useAuraV2Store(s => (story ? s.pinsByStory[story.id] : undefined));
  /** Which pin is being folded into another, if any. */
  const [merging, setMerging] = useState<string | null>(null);

  if (!open || !story) return null;

  const list = pins ?? [];
  const mergeSource = merging ? list.find(p => p.id === merging) ?? null : null;

  return (
    <div className="fixed inset-y-0 right-0 z-50 w-full max-w-md bg-surface text-app-text border-l border-app-border shadow-2xl flex flex-col">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-app-border">
        <Pin size={17} className="text-accent" />
        <div className="min-w-0">
          <h2 className="font-bold leading-tight text-sm">Pins</h2>
          <p className="text-[10px] text-muted leading-tight truncate">
            Documents you keep beside the story, and the sets they arrange into
          </p>
        </div>
        <button
          onClick={() => setOpen(false)}
          className="ml-auto p-2 rounded-full hover:bg-app-text/10 transition-colors"
          title="Close pins"
        >
          <X size={16} />
        </button>
      </div>

      <div className="p-3 border-b border-app-border">
        <PinSetBar storyId={story.id} />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-1.5">
        {list.length === 0 ? (
          <p className="text-[11px] text-muted leading-snug">
            Hover any table or code block in the story (or select text) and hit the pin —
            AI-written charts &amp; stat tables dock in the right margin on wide windows,
            and can be fed back to the AI as reference.
          </p>
        ) : list.map(p => {
          const pageCount = pagesOf(p).length;
          return (
            <div key={p.id} className="rounded-lg bg-app-text/5">
              <div className="flex items-center gap-1.5 px-2 py-1.5 text-xs">
                {pageCount > 1
                  ? <BookOpen size={11} className="text-accent shrink-0" />
                  : <Pin size={11} className="text-accent shrink-0" />}
                <span className="truncate flex-1" title={p.title}>{p.title}</span>
                {pageCount > 1 && (
                  <span
                    className="shrink-0 text-[10px] tabular-nums text-muted"
                    title={`${pageCount} pages`}
                  >
                    {pageCount}p
                  </span>
                )}
                <button
                  onClick={() => updatePin(story.id, p.id, { inContext: !p.inContext })}
                  title={p.inContext ? 'In AI context — click to exclude' : 'Include in AI context'}
                  className={cn(
                    'p-1 rounded-md transition-colors',
                    p.inContext ? 'text-accent bg-accent/15' : 'opacity-50 hover:opacity-100 hover:bg-app-text/10',
                  )}
                >
                  <Bot size={12} />
                </button>
                <button
                  onClick={() => updatePin(story.id, p.id, { docked: !p.docked })}
                  title={p.docked ? 'Docked in the margin — click to undock' : 'Dock in the right margin'}
                  className={cn(
                    'p-1 rounded-md transition-colors',
                    p.docked ? 'text-accent bg-accent/15' : 'opacity-50 hover:opacity-100 hover:bg-app-text/10',
                  )}
                >
                  <PanelRight size={12} />
                </button>
                {/* Folding one pin into another as pages — the "these forty
                  * journal entries are one thing" move. Only offered when
                  * there is something to fold it into. */}
                {list.length > 1 && (
                  <button
                    onClick={() => setMerging(merging === p.id ? null : p.id)}
                    title="Fold this pin into another as pages"
                    aria-pressed={merging === p.id}
                    data-testid="pin-merge"
                    className={cn(
                      'p-1 rounded-md transition-colors',
                      merging === p.id ? 'text-accent bg-accent/15' : 'opacity-50 hover:opacity-100 hover:bg-app-text/10',
                    )}
                  >
                    <Layers size={12} />
                  </button>
                )}
                <button
                  onClick={() => removePin(story.id, p.id)}
                  title="Delete pin"
                  className="p-1 rounded-md opacity-50 hover:opacity-100 hover:bg-red-500/10 hover:text-red-500 transition-colors"
                >
                  <Trash2 size={12} />
                </button>
              </div>
              {mergeSource?.id === p.id && (
                <div className="px-2 pb-2 space-y-1">
                  <p className="text-[10px] text-muted">
                    Add “{p.title}” to the end of which pin? It stops being its own pin.
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {list.filter(t => t.id !== p.id).map(t => (
                      <button
                        key={t.id}
                        onClick={() => { mergePinPages(story.id, t.id, p.id); setMerging(null); }}
                        className="text-[10px] px-2 py-1 rounded-md border border-app-border hover:border-accent hover:bg-accent/10 max-w-40 truncate"
                        title={t.title}
                      >
                        {t.title}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
