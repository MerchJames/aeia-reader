import React, { useMemo, useRef, useState } from 'react';
import { Headphones, Loader2, X } from 'lucide-react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { AbortedError, estimateSeconds, renderAudiobook, runtimeLabel } from '../utils/audiobook';
import { SpeechContext, voiceCastFor } from '../utils/speechPlan';
import { walkStory } from '../utils/storyWalk';
import { downloadBlob, safeFilename } from '../utils/exporter';
import { cn } from '../utils/cn';

/**
 * Render the open story to an audiobook.
 *
 * Kokoro-only, and the modal says why rather than greying a button out with no
 * explanation: the browser's own speech engine drives the audio device directly
 * and gives no way to capture what it says, so there is nothing to record.
 *
 * A real story is hours of synthesis, so the two things that matter here are an
 * honest estimate BEFORE you commit and a cancel that works during.
 */
export const AudiobookModal = ({ onClose }: { onClose: () => void }) => {
  const store = useAppStore();
  const v2 = useAuraV2Store();
  const story = store.currentStory;
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  const kokoro = store.ttsEngine === 'kokoro' && !!store.kokoroBaseUrl;

  const ctx: SpeechContext = useMemo(() => ({
    cast: [...new Set(store.chains.flatMap(c => c.messages).map(m => m.name))],
    characterName: story?.characterName,
    userName: story?.userName,
    overrides: story ? v2.overridesByStory[story.id] : undefined,
    lensOn: !!story && !!v2.lensOnByStory[story.id],
    hideMetadata: store.hideMetadata,
    substituteNames: store.substituteNames,
    multiVoice: store.ttsMultiVoice,
    kokoroVoice: store.kokoroVoice,
    kokoroUserVoice: store.kokoroUserVoice,
    ttsVoiceByCharacter: store.ttsVoiceByCharacter,
    autoCastVoices: store.autoCastVoices,
  }), [store.chains, story, v2.overridesByStory, v2.lensOnByStory, store.hideMetadata,
    store.substituteNames, store.ttsMultiVoice, store.kokoroVoice, store.kokoroUserVoice,
    store.ttsVoiceByCharacter, store.autoCastVoices]);

  const walked = useMemo(
    () => (story ? walkStory(story, store.chains, {
      overrides: ctx.overrides, lensOn: ctx.lensOn,
      hideMetadata: ctx.hideMetadata, substituteNames: ctx.substituteNames,
    }) : null),
    [story, store.chains, ctx],
  );
  const cast = useMemo(() => (story ? voiceCastFor(story, ctx) : []), [story, ctx]);

  if (!story || !walked) return null;
  const estimate = runtimeLabel(estimateSeconds(walked.wordCount, store.ttsRate));

  const run = async () => {
    const c = new AbortController();
    ctrl.current = c;
    setError(null);
    setResult(null);
    setProgress({ done: 0, total: 1, label: '' });
    try {
      const out = await renderAudiobook(story, store.chains, {
        overrides: ctx.overrides, lensOn: ctx.lensOn,
        hideMetadata: ctx.hideMetadata, substituteNames: ctx.substituteNames,
      }, ctx, v2.sceneByStory[story.id], {
        base: store.kokoroBaseUrl,
        apiKey: store.kokoroApiKey,
        speed: store.ttsRate,
        signal: c.signal,
        onProgress: (done, total, label) => setProgress({ done, total, label }),
      });
      const name = safeFilename(story.title);
      downloadBlob(`${name}.mp3`, out.audio);
      downloadBlob(`${name}.cue`, new Blob([out.cue], { type: 'text/plain;charset=utf-8' }));
      setResult(
        `${runtimeLabel(out.totalSec)} across ${out.chapters.length} chapter${out.chapters.length === 1 ? '' : 's'}.`
        + (out.failed ? ` ${out.failed} passage${out.failed === 1 ? '' : 's'} could not be synthesised and were skipped.` : ''),
      );
    } catch (e) {
      setError(e instanceof AbortedError ? 'Cancelled — nothing was saved.' : (e as Error).message);
    } finally {
      setProgress(null);
      ctrl.current = null;
    }
  };

  const running = !!progress;
  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg max-h-[calc(100dvh-2rem)] flex flex-col rounded-2xl bg-app-surface border border-app-text/10 shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-app-text/10 shrink-0">
          <span className="flex items-center gap-2 font-semibold">
            <Headphones size={17} className="text-accent" /> Audiobook
          </span>
          <button
            onClick={() => { ctrl.current?.abort(); onClose(); }}
            aria-label="Close"
            className="flex items-center justify-center min-h-10 min-w-10 rounded-lg text-app-text/40 hover:text-app-text"
          >
            <X size={17} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          {!kokoro ? (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <p className="font-medium mb-1">This needs Kokoro.</p>
              <p className="text-app-text/70 leading-snug">
                Your browser’s built-in voices can speak, but they cannot be recorded —
                the engine plays straight to the speakers and hands back nothing to save.
                Point Aeia at a Kokoro server in Settings → Read aloud, and this will
                render the whole story with your cast’s voices.
              </p>
            </div>
          ) : (
            <>
              <div className="text-sm text-app-text/70 leading-relaxed">
                <b className="text-app-text">{story.title}</b> — {walked.messages.length} passages,{' '}
                {walked.wordCount.toLocaleString()} words, roughly <b className="text-app-text">{estimate}</b> of audio.
                Saved as one MP3 plus a CUE sheet marking each chapter.
              </div>

              <div>
                <div className="text-[10px] uppercase tracking-wider text-app-text/35 mb-1.5">Cast</div>
                <div className="flex flex-wrap gap-1.5">
                  {cast.map(({ name, voice }) => (
                    <span key={name} className="rounded-full border border-app-text/15 px-2 py-0.5 text-[11px]">
                      {name} <span className="text-app-text/40">{voice}</span>
                    </span>
                  ))}
                </div>
                {!store.ttsMultiVoice && (
                  <p className="text-[11px] text-app-text/45 mt-1.5">
                    Multi-voice is off, so everything is read in one voice. Turn it on in
                    Settings → Read aloud to cast each character.
                  </p>
                )}
              </div>

              {running && (
                <div>
                  <div className="h-1.5 rounded-full bg-app-text/10 overflow-hidden">
                    <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
                  </div>
                  <p className="text-[11px] text-app-text/50 mt-1.5">
                    {progress!.done} of {progress!.total} passages · {progress!.label}
                  </p>
                </div>
              )}

              {result && <p className="text-sm text-emerald-500">Saved. {result}</p>}
              {error && <p className="text-sm text-amber-500">{error}</p>}
            </>
          )}
        </div>

        <div className="flex items-center gap-2 px-5 py-4 border-t border-app-text/10 shrink-0">
          <span className="text-[11px] text-app-text/40 mr-auto">
            Nothing leaves your machine but the text sent to your own Kokoro server.
          </span>
          {running ? (
            <button
              onClick={() => ctrl.current?.abort()}
              className="flex items-center gap-1.5 px-4 min-h-10 rounded-lg border border-app-text/15 text-sm"
            >
              <Loader2 size={14} className="animate-spin" /> Cancel
            </button>
          ) : (
            <button
              onClick={() => void run()}
              disabled={!kokoro}
              data-testid="render-audiobook"
              className={cn(
                'px-4 min-h-10 rounded-lg text-sm font-medium',
                kokoro ? 'bg-accent text-white hover:opacity-90' : 'bg-app-text/10 text-app-text/40 cursor-not-allowed',
              )}
            >
              {result ? 'Render again' : 'Render audiobook'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
