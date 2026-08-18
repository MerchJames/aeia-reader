/**
 * The generated-sound library, as something you can look at.
 *
 * `aura-audio` has been wired for a while — the Director searches it, the
 * Sandbox plays from it, scenes pull ambience out of it — but there was no way
 * to SEE it. You could not hear what you had, tell a good take from the four
 * bad ones before it, delete a miss, or ask for a specific clip; the only
 * interface was a scene happening to want something.
 *
 * So: search, audition, generate, delete. Nothing else. No mixer, no waveform
 * editing, no per-clip volume — the Director owns how a clip is used, this owns
 * only what exists.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Play, RefreshCw, Search, Sparkles, Square, Trash2, X } from 'lucide-react';
import { useAppStore } from '../store';
import type { AudioCategory } from '../types';
import {
  AudioAsset, audioAssetUrl, deleteAudioAsset, generateAudio, searchAudioLibrary,
} from '../utils/audioLibrary';
import { useService } from '../services/useService';
import { cn } from '../utils/cn';

const CATEGORIES: readonly (AudioCategory | 'all')[] = ['all', 'sfx', 'ambience', 'music'];

const secs = (n: number) => (n >= 60 ? `${Math.floor(n / 60)}m ${n % 60}s` : `${n}s`);

export const AudioLibraryModal = ({ onClose }: { onClose: () => void }) => {
  const base = useAppStore(s => s.audioBaseUrl);
  const service = useService('audio', base);

  const [assets, setAssets] = useState<AudioAsset[]>([]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<AudioCategory | 'all'>('all');
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Generate form.
  const [prompt, setPrompt] = useState('');
  const [genCategory, setGenCategory] = useState<AudioCategory>('sfx');
  const [generating, setGenerating] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const searchCtrl = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    searchCtrl.current?.abort();
    const ctrl = new AbortController();
    searchCtrl.current = ctrl;
    setLoading(true);
    const found = await searchAudioLibrary(
      base,
      { q: query.trim() || undefined, category: category === 'all' ? undefined : category },
      ctrl.signal,
    );
    if (ctrl.signal.aborted) return;
    // Newest first: the clip you just made is the one you want to hear.
    setAssets([...found].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)));
    setLoading(false);
  }, [base, query, category]);

  // Debounced, so typing a search does not fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => { void refresh(); }, 250);
    return () => clearTimeout(t);
  }, [refresh]);

  // One <audio> for the whole list — auditioning a second clip stops the first,
  // which is what "audition" means and also stops six of them overlapping.
  useEffect(() => () => { audioRef.current?.pause(); }, []);

  const audition = (asset: AudioAsset) => {
    if (playing === asset.id) {
      audioRef.current?.pause();
      setPlaying(null);
      return;
    }
    audioRef.current?.pause();
    const el = new Audio(audioAssetUrl(base, asset.id));
    el.onended = () => setPlaying(null);
    el.onerror = () => { setPlaying(null); setNote(`Could not play "${asset.description || asset.prompt}".`); };
    audioRef.current = el;
    setPlaying(asset.id);
    void el.play().catch(() => setPlaying(null));
  };

  const remove = async (asset: AudioAsset) => {
    setBusyId(asset.id);
    setNote(null);
    const ok = await deleteAudioAsset(base, asset.id);
    setBusyId(null);
    if (!ok) { setNote('The service would not delete that clip.'); return; }
    if (playing === asset.id) { audioRef.current?.pause(); setPlaying(null); }
    setAssets(list => list.filter(a => a.id !== asset.id));
  };

  const generate = async (variant?: number) => {
    const text = prompt.trim();
    if (!text || generating) return;
    setGenerating(true);
    setNote(null);
    try {
      const asset = await generateAudio(base, {
        prompt: text,
        category: genCategory,
        loop: genCategory !== 'sfx',
        description: text,
        variant,
      });
      setAssets(list => [asset, ...list.filter(a => a.id !== asset.id)]);
      audition(asset);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div
        className="bg-surface border border-app-border rounded-2xl w-full max-w-2xl max-h-[calc(100dvh-2rem)] flex flex-col shadow-2xl"
        data-testid="audio-library"
      >
        <div className="flex items-center justify-between px-4 sm:px-5 py-3 border-b border-app-border shrink-0">
          <div className="min-w-0">
            <h2 className="font-bold">Sound library</h2>
            <p className="text-[11px] text-muted truncate">
              {service.state === 'up'
                ? `${assets.length} shown${service.detail ? ` · ${service.detail}` : ''}`
                : service.blockedReason ?? 'checking…'}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex items-center justify-center min-h-11 min-w-11 rounded-lg hover:bg-app-text/5"
          >
            <X size={18} />
          </button>
        </div>

        {service.state === 'down' ? (
          <div className="p-6 text-sm text-muted flex flex-col items-start gap-3">
            <p>{service.blockedReason}</p>
            <p className="text-[11px] leading-snug">
              The reader does not need it — scenes fall back to built-in procedural
              sound, and everything else works untouched. Start <code>aura-audio</code>{' '}
              and press check.
            </p>
            <button
              onClick={service.recheck}
              className="flex items-center gap-1.5 px-3 min-h-11 rounded-lg border border-app-border text-sm hover:bg-app-text/5"
            >
              <RefreshCw size={14} /> Check again
            </button>
          </div>
        ) : (
          <>
            <div className="px-4 sm:px-5 py-3 flex flex-col gap-2 border-b border-app-border shrink-0">
              <div className="flex items-center gap-2">
                <div className="relative flex-1 min-w-0">
                  <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
                  <input
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    placeholder="rain, tavern door, cello…"
                    aria-label="Search the sound library"
                    data-testid="audio-search"
                    className="w-full bg-app-text/5 border border-app-border rounded-lg pl-8 pr-2 min-h-11 text-sm outline-none focus:border-accent/50"
                  />
                </div>
                <button
                  onClick={() => void refresh()}
                  aria-label="Refresh"
                  title="Refresh"
                  className="flex items-center justify-center min-h-11 min-w-11 rounded-lg border border-app-border hover:bg-app-text/5"
                >
                  <RefreshCw size={14} className={cn(loading && 'animate-spin')} />
                </button>
              </div>
              <div className="flex gap-1.5 overflow-x-auto">
                {CATEGORIES.map(c => (
                  <button
                    key={c}
                    onClick={() => setCategory(c)}
                    data-testid={`audio-cat-${c}`}
                    className={cn(
                      'px-3 min-h-9 rounded-full border text-xs capitalize shrink-0 transition-colors',
                      category === c
                        ? 'bg-accent text-white border-accent'
                        : 'border-app-border text-muted hover:bg-app-text/5',
                    )}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-5 py-3 flex flex-col gap-2">
              {assets.length === 0 && !loading && (
                <p className="text-sm text-muted py-6 text-center">
                  {query ? 'Nothing matches that.' : 'The library is empty. Make something below.'}
                </p>
              )}
              {assets.map(a => (
                <div
                  key={a.id}
                  data-testid="audio-asset"
                  className="flex items-center gap-2 p-2 rounded-xl border border-app-border/60"
                >
                  <button
                    onClick={() => audition(a)}
                    aria-label={playing === a.id ? `Stop ${a.description || a.prompt}` : `Play ${a.description || a.prompt}`}
                    className="flex items-center justify-center min-h-11 min-w-11 rounded-lg border border-app-border hover:bg-app-text/5 shrink-0"
                  >
                    {playing === a.id ? <Square size={13} /> : <Play size={13} />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm truncate" title={a.prompt}>{a.description || a.prompt}</div>
                    <div className="text-[11px] text-muted truncate">
                      {a.category} · {secs(a.seconds)}{a.loop ? ' · loops' : ''}
                      {a.tags?.length ? ` · ${a.tags.slice(0, 4).join(', ')}` : ''}
                    </div>
                  </div>
                  <button
                    onClick={() => void remove(a)}
                    disabled={busyId === a.id}
                    aria-label={`Delete ${a.description || a.prompt}`}
                    className="flex items-center justify-center min-h-11 min-w-11 rounded-lg text-red-500 hover:bg-red-500/10 shrink-0 disabled:opacity-50"
                  >
                    {busyId === a.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                  </button>
                </div>
              ))}
            </div>

            <div className="px-4 sm:px-5 py-3 border-t border-app-border shrink-0 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <input
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') void generate(); }}
                  placeholder="describe a sound: steady rain on a canvas tent…"
                  aria-label="Describe a sound to generate"
                  data-testid="audio-prompt"
                  className="flex-1 min-w-0 bg-app-text/5 border border-app-border rounded-lg px-2 min-h-11 text-sm outline-none focus:border-accent/50"
                />
                <select
                  value={genCategory}
                  onChange={e => setGenCategory(e.target.value as AudioCategory)}
                  aria-label="Category"
                  className="bg-app-text/5 border border-app-border rounded-lg px-2 min-h-11 text-sm outline-none"
                >
                  <option value="sfx">sfx</option>
                  <option value="ambience">ambience</option>
                  <option value="music">music</option>
                </select>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void generate()}
                  disabled={!prompt.trim() || generating}
                  data-testid="audio-generate"
                  className="flex items-center justify-center gap-1.5 px-4 min-h-11 flex-1 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-50"
                >
                  {generating ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
                  {generating ? 'Generating…' : 'Generate'}
                </button>
                {/* The service caches by (category, prompt, length), so asking
                  * again returns the same file. `variant` is the documented way
                  * to force a genuinely different take. */}
                <button
                  onClick={() => void generate(Date.now() % 100000)}
                  disabled={!prompt.trim() || generating}
                  title="Another take on the same prompt"
                  className="px-3 min-h-11 rounded-lg border border-app-border text-sm disabled:opacity-50 hover:bg-app-text/5"
                >
                  Re-roll
                </button>
              </div>
              {note && <p className="text-[11px] text-amber-400/90 leading-snug">{note}</p>}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
