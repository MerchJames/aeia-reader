/**
 * Getting the whole library out, and putting it back.
 *
 * ── What this screen is for ────────────────────────────────────────────────
 *
 * Everything this app holds lives in this browser, and by default a browser
 * makes no promise to keep it. This is the one place a reader can do something
 * about that: see whether their library is safe from eviction, ask for it to be
 * made safe, and take a copy they own.
 *
 * ── Why the storage row is first ───────────────────────────────────────────
 *
 * Because it is the part a reader does not know to worry about. "Export a
 * backup" is a familiar idea they can go looking for; "this browser may delete
 * your library when the disk fills" is not something anyone thinks to check. So
 * the state is stated before the buttons, in plain terms, whether it is good
 * news or bad.
 *
 * ── Why restore defaults to "fill" ─────────────────────────────────────────
 *
 * The dangerous restore is the one that overwrites. Both are offered because
 * both are wanted — filling gaps after a partial loss, replacing everything
 * after a fresh install — but the destructive one is never preselected and
 * never described gently. See `RestoreMode` in `utils/vault.ts`.
 */

import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, Check, Database, Download, HardDriveDownload, Loader2,
  Lock, ShieldCheck, Upload, X,
} from 'lucide-react';
import { raiseAlert } from '../utils/alerts';
import {
  askForPersistence, describeStorage, formatBytes, readStorageReport,
  type StorageReport,
} from '../utils/storageHealth';
import {
  decodeLine, describeRestore, isEmptyPlan, planRestore, readVaultHeader,
  type RestoreMode, type RestorePlan,
} from '../utils/vault';
import {
  applyRestore, buildVault, estimateVault, existingStoryIds, saveVault,
  type VaultEstimate,
} from '../utils/vaultIo';
import { cn } from '../utils/cn';

interface BackupPanelProps { onClose: () => void }

type Busy = null | { what: 'backup' | 'restore'; done: number; total: number };

export const BackupPanel = ({ onClose }: BackupPanelProps) => {
  const [storage, setStorage] = useState<StorageReport | null>(null);
  const [estimate, setEstimate] = useState<VaultEstimate | null>(null);
  const [includeArt, setIncludeArt] = useState(true);
  const [busy, setBusy] = useState<Busy>(null);
  const [asking, setAsking] = useState(false);

  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const [mode, setMode] = useState<RestoreMode>('fill');
  const [vaultName, setVaultName] = useState('');
  const [problem, setProblem] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  /** The opened vault's decoded records, kept so a mode switch can re-plan. */
  const decodedRef = useRef<ReturnType<typeof decodeLine>[] | null>(null);

  useEffect(() => {
    void readStorageReport().then(setStorage);
    void estimateVault().then(setEstimate).catch(() => setEstimate(null));
  }, []);

  const askPersist = async () => {
    setAsking(true);
    try {
      await askForPersistence();
      // Re-read rather than trust the return: Chrome can grant on its own
      // heuristics a moment later, and the row should show what IS, not what
      // the call happened to answer.
      setStorage(await readStorageReport());
    } finally {
      setAsking(false);
    }
  };

  const doBackup = async () => {
    setBusy({ what: 'backup', done: 0, total: 1 });
    try {
      const blob = await buildVault({
        includeArt,
        onProgress: (done, total) => setBusy({ what: 'backup', done, total }),
      });
      const name = saveVault(blob);
      raiseAlert({
        tone: 'info',
        title: `Backup saved — ${formatBytes(blob.size)}`,
        detail: `${name}. Keep it somewhere that is not this device.`,
      });
    } catch (e: any) {
      raiseAlert({
        tone: 'danger',
        title: 'The backup could not be written',
        detail: String(e?.message ?? e),
        key: 'backup-failed',
      });
    } finally {
      setBusy(null);
    }
  };

  /**
   * Read a chosen vault into a plan, without writing anything.
   *
   * The whole file is read as text first. That is the one place this feature
   * genuinely needs the memory, and it is bounded by what the reader chose to
   * open — a fair trade for being able to show them exactly what a restore
   * would do before it does any of it.
   */
  const openVault = async (file: File) => {
    setProblem('');
    setPlan(null);
    setVaultName(file.name);

    const text = await file.text();
    const lines = text.split('\n').filter(l => l.trim());
    if (!lines.length) { setProblem('That file is empty.'); return; }

    const { error } = readVaultHeader(lines[0]);
    if (error) { setProblem(error); return; }

    // Decoded once and kept, so switching modes re-plans instantly instead of
    // asking the reader to open the file again. The decoded records are the
    // same objects the plan already holds, so this costs no extra memory —
    // the file TEXT, which would double it, is dropped here.
    const decoded = lines.map(decodeLine);
    decodedRef.current = decoded;
    setPlan(planRestore(decoded, await existingStoryIds(), mode));
  };

  /**
   * Re-plan when the mode changes.
   *
   * `added` and `overwritten` are split by the mode, so a plan made in `fill`
   * genuinely does not describe what `replace` would do. Showing the old counts
   * under the new mode would mean the sentence above the button is wrong at the
   * exact moment it matters most.
   */
  useEffect(() => {
    if (!plan || plan.mode === mode || !decodedRef.current) return;
    let live = true;
    void existingStoryIds().then(ids => {
      if (live && decodedRef.current) setPlan(planRestore(decodedRef.current, ids, mode));
    });
    return () => { live = false; };
  }, [mode, plan]);

  const doRestore = async () => {
    if (!plan || isEmptyPlan(plan)) return;
    setBusy({ what: 'restore', done: 0, total: 1 });
    try {
      const result = await applyRestore(
        plan,
        (done, total) => setBusy({ what: 'restore', done, total }),
      );
      raiseAlert({
        tone: result.failed.length ? 'warn' : 'info',
        title: `Restored ${result.stories} stor${result.stories === 1 ? 'y' : 'ies'}`
          + `${result.media ? ` and ${result.media} files` : ''}`,
        detail: result.failed.length
          ? `${result.failed.length} items would not write. Reload to see what came back.`
          : 'Reload the app to see everything that came back.',
        sticky: true,
      });
      setPlan(null);
    } catch (e: any) {
      raiseAlert({
        tone: 'danger',
        title: 'The restore stopped partway',
        detail: String(e?.message ?? e),
        key: 'restore-failed',
      });
    } finally {
      setBusy(null);
    }
  };

  const pct = busy && busy.total > 0 ? Math.round((busy.done / busy.total) * 100) : 0;
  const safe = storage?.durability === 'persisted';

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-2xl max-h-[88vh] flex flex-col rounded-xl border border-app-border
                      bg-app-surface shadow-2xl">

        <header className="flex items-center gap-2 px-4 py-3 border-b border-app-border">
          <Database size={16} className="text-app-muted" />
          <h2 className="font-medium text-app-text">Your library</h2>
          <button onClick={onClose} className="ml-auto p-1 rounded hover:bg-app-bg text-app-muted"
            aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-5">

          {/* ---- Is it safe here? ---- */}
          <section>
            <div className={cn(
              'flex gap-3 p-3 rounded-lg border',
              safe ? 'border-app-border' : 'border-amber-500/40 bg-amber-500/5',
            )}>
              {safe
                ? <ShieldCheck size={16} className="shrink-0 mt-0.5 text-emerald-400" />
                : <AlertTriangle size={16} className="shrink-0 mt-0.5 text-amber-400" />}
              <div className="flex-1 min-w-0">
                <p className="text-sm text-app-text leading-relaxed">
                  {storage ? describeStorage(storage) : 'Checking this browser’s storage…'}
                </p>
                {storage && !safe && storage.durability !== 'unsupported' && (
                  <button
                    onClick={() => void askPersist()}
                    disabled={asking}
                    className="mt-2 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs
                               bg-app-accent text-white disabled:opacity-50"
                  >
                    {asking ? <Loader2 size={12} className="animate-spin" /> : <Lock size={12} />}
                    Ask this browser to keep it
                  </button>
                )}
              </div>
            </div>
            {storage && !safe && storage.durability !== 'unsupported' && (
              <p className="mt-1.5 text-[11px] text-app-muted leading-relaxed">
                Some browsers grant this straight away; others decide based on how much you use
                Aeia, and may say yes later. Either way, keep a backup.
              </p>
            )}
          </section>

          {/* ---- Take a copy ---- */}
          <section className="space-y-2">
            <h3 className="text-xs uppercase tracking-wider text-app-muted">Back up</h3>
            <p className="text-sm text-app-muted leading-relaxed">
              One file with every story, and every note, pin, sheet, codex entry and Lens edit
              attached to them. It holds your whole library, so treat it as private — it is not
              a thing to share.
            </p>

            {estimate && (
              <ul className="text-xs text-app-muted grid grid-cols-2 sm:grid-cols-4 gap-2 py-1">
                <li><b className="text-app-text tabular-nums">{estimate.stories}</b> stories</li>
                <li><b className="text-app-text tabular-nums">{estimate.slices}</b> data records</li>
                <li><b className="text-app-text tabular-nums">{estimate.media}</b> images & files</li>
                <li><b className="text-app-text tabular-nums">
                  {formatBytes(includeArt ? estimate.mediaBytes : estimate.mediaBytes - estimate.artBytes)}
                </b> of media</li>
              </ul>
            )}

            {estimate && estimate.artBytes > 0 && (
              <label className="flex items-start gap-2 text-xs text-app-muted cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeArt}
                  onChange={e => setIncludeArt(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  Include generated scene art ({formatBytes(estimate.artBytes)}). Fonts, sprites
                  and backdrops you added are always included — those cannot be made again.
                </span>
              </label>
            )}

            <button
              onClick={() => void doBackup()}
              disabled={!!busy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm
                         bg-app-accent text-white disabled:opacity-50"
            >
              {busy?.what === 'backup'
                ? <><Loader2 size={14} className="animate-spin" /> Writing… {pct}%</>
                : <><Download size={14} /> Save a backup</>}
            </button>
          </section>

          {/* ---- Put one back ---- */}
          <section className="space-y-2 pt-1 border-t border-app-border">
            <h3 className="text-xs uppercase tracking-wider text-app-muted pt-4">Restore</h3>

            {!plan ? (
              <>
                <p className="text-sm text-app-muted leading-relaxed">
                  Open a backup to see what it holds. Nothing is written until you say so.
                </p>
                <button
                  onClick={() => fileRef.current?.click()}
                  disabled={!!busy}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm
                             border border-app-border text-app-text disabled:opacity-50"
                >
                  <Upload size={14} /> Open a backup
                </button>
                <input
                  ref={fileRef} type="file" accept=".jsonl,.json" className="hidden"
                  onChange={e => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) void openVault(f);
                  }}
                />
                {problem && (
                  <p className="text-sm text-red-400 leading-relaxed flex gap-2">
                    <AlertTriangle size={15} className="shrink-0 mt-0.5" />{problem}
                  </p>
                )}
              </>
            ) : (
              <>
                <p className="text-xs text-app-muted truncate">{vaultName}</p>

                <div className="grid sm:grid-cols-2 gap-2">
                  {([
                    ['fill', 'Add what’s missing', 'Keeps every story you already have, exactly as it is.'],
                    ['replace', 'Replace what I have', 'Overwrites stories that are in both. Anything you changed since the backup is lost.'],
                  ] as const).map(([value, label, hint]) => (
                    <button
                      key={value}
                      onClick={() => setMode(value)}
                      className={cn(
                        'text-left p-2.5 rounded-lg border text-xs',
                        mode === value
                          ? 'border-app-accent bg-app-accent/10 text-app-text'
                          : 'border-app-border text-app-muted hover:text-app-text',
                      )}
                    >
                      <span className="flex items-center gap-1 font-medium mb-0.5">
                        {mode === value && <Check size={11} />}{label}
                      </span>
                      <span className="block leading-relaxed">{hint}</span>
                    </button>
                  ))}
                </div>

                <p className="text-sm text-app-text leading-relaxed">
                  {describeRestore(plan)}
                </p>


                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    onClick={() => void doRestore()}
                    disabled={!!busy || isEmptyPlan(plan)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm
                               bg-app-accent text-white disabled:opacity-50"
                  >
                    {busy?.what === 'restore'
                      ? <><Loader2 size={14} className="animate-spin" /> Restoring… {pct}%</>
                      : <><HardDriveDownload size={14} /> Restore</>}
                  </button>
                  <button
                    onClick={() => { setPlan(null); setProblem(''); decodedRef.current = null; }}
                    disabled={!!busy}
                    className="px-3 py-1.5 rounded-lg text-sm border border-app-border
                               text-app-muted disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};
