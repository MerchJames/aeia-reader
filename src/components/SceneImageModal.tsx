/**
 * Picture this scene.
 *
 * Anchored to ONE beat, like everything else the AI does here: summoned at a
 * passage, produces something belonging to that passage, goes away.
 *
 * The shape is deliberately three steps and no more —
 *   1. a model reads the passage and writes a prompt in your backend's dialect,
 *   2. YOU SEE AND EDIT THAT PROMPT,
 *   3. it generates, and the picture lands on the beat.
 *
 * Step 2 is what makes the rest unnecessary. A reader who can see and fix the
 * prompt does not need a queue, a batch runner, a gallery or a re-roll pile:
 * the failure mode those exist to paper over is not knowing what was asked for.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ImageIcon, Loader2, RefreshCw, Wand2, X } from 'lucide-react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { samplerParamsFrom } from '../utils/aiClient';
import { askText } from '../utils/aiCall';
import { resolveContent } from '../utils/lens';
import { processText } from '../utils/textProcessor';
import { appearanceFromCard, draftPrompt } from '../utils/imagePrompt';
import { IMAGE_PRESETS, presetById } from '../utils/imagePresets';
import { generateImage, imageCapabilities } from '../services/image';
import { useService } from '../services/useService';
import { putArt } from '../lib/artStorage';
import type { SceneArt } from '../types';
import { cn } from '../utils/cn';

const newId = () => `art-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const SceneImageModal = ({ messageId, onClose }: { messageId: string; onClose: () => void }) => {
  const store = useAppStore();
  const v2 = useAuraV2Store();
  const storyId = store.currentStory?.id;
  const base = useAppStore(s => s.imageBaseUrl);
  const service = useService('image', base);

  const [prompt, setPrompt] = useState('');
  const [negative, setNegative] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [usedSheet, setUsedSheet] = useState('');
  const [cast, setCast] = useState<string[]>([]);
  const ctrl = useRef<AbortController | null>(null);

  const preset = presetById(store.imagePreset);
  const caps = imageCapabilities();
  const message = store.chains.flatMap(c => c.messages).find(m => m.id === messageId);

  const passage = message && storyId
    ? processText(resolveContent(message, v2.overridesByStory[storyId], !!v2.lensOnByStory[storyId]), {
      hideMetadata: store.hideMetadata,
      substituteNames: store.substituteNames,
      characterName: store.currentStory?.characterName,
      userName: store.currentStory?.userName,
      oocHandling: store.oocHandling,
      role: message.role,
    }).processedText.trim()
    : '';

  /** The sheets in force, falling back to one read off the card. */
  const appearance = useCallback((): Record<string, string> => {
    const stored = { ...(storyId ? v2.appearanceByStory[storyId] ?? {} : {}) };
    const lead = store.currentStory?.characterName?.trim().toLowerCase();
    if (lead && !stored[lead]) {
      const seeded = appearanceFromCard(store.currentStory?.card);
      if (seeded) stored[lead] = seeded;
    }
    return stored;
  }, [storyId, v2.appearanceByStory, store.currentStory]);

  const draft = useCallback(async () => {
    if (!passage || !store.aiBaseUrl || !store.aiModel) return;
    setDrafting(true);
    setError(null);
    try {
      const result = await draftPrompt(
        {
          text: passage,
          speaker: message?.name,
          characterName: store.currentStory?.characterName,
          userName: store.currentStory?.userName,
          scene: storyId ? v2.sceneByStory[storyId]?.[messageId] : undefined,
          card: store.currentStory?.card,
          appearance: appearance(),
          presetId: store.imagePreset,
          negativeExtra: store.imageNegativeExtra,
        },
        // A little warmth: an image prompt written at temperature 0 comes back
        // as the same six adjectives for every passage in the story.
        // Shared layer: the reader edits this prompt before it fires, and a
        // chain of thought pasted into an image prompt is not a prompt.
        async (messages) => askText(
          { base: store.aiBaseUrl, key: store.aiApiKey, model: store.aiModel },
          messages,
          {
            label: 'Writing the image prompt',
            params: { temperature: 0.7 },
            reader: samplerParamsFrom(store.aiAdvanced),
          },
        ),
      );
      setPrompt(result.prompt);
      setNegative(result.negative);
      setUsedSheet(result.appearanceUsed);
      setCast(result.characters);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDrafting(false);
    }
  }, [passage, store, v2, messageId, storyId, message, appearance]);

  // Draft once on open. The reader asked for a picture of this beat; making
  // them press a second button to find out what it would be is a step for
  // nothing.
  useEffect(() => { void draft(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => () => ctrl.current?.abort(), []);

  const run = async () => {
    if (!prompt.trim() || !storyId) return;
    setGenerating(true);
    setError(null);
    ctrl.current?.abort();
    const controller = new AbortController();
    ctrl.current = controller;
    try {
      // A locked seed is what makes the same character recognisable in two
      // different scenes — where the backend has one at all.
      const seedKey = cast[0];
      const locked = caps.has('seed') && seedKey ? v2.artSeedByStory[storyId]?.[seedKey] : undefined;

      const { blob, seed } = await generateImage({
        prompt,
        negative: caps.has('negative') ? negative : undefined,
        width: preset.size.width,
        height: preset.size.height,
        seed: locked,
        signal: controller.signal,
      });

      const id = newId();
      await putArt({
        id,
        storyId,
        messageId,
        data: await blob.arrayBuffer(),
        type: blob.type || 'image/png',
        createdAt: Date.now(),
      });

      const art: SceneArt = {
        id,
        prompt,
        negative: caps.has('negative') ? negative : undefined,
        preset: preset.id,
        adapter: store.imageAdapter,
        seed,
        width: preset.size.width,
        height: preset.size.height,
        createdAt: Date.now(),
      };
      v2.addSceneArt(storyId, messageId, art);

      // First picture of a character with no locked seed sets the lock, so the
      // next scene starts from the same face rather than a new stranger.
      if (caps.has('seed') && seedKey && seed != null && locked == null) {
        v2.setArtSeed(storyId, seedKey, seed);
      }

      setPreview(URL.createObjectURL(blob));
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  const aiReady = !!store.aiBaseUrl && !!store.aiModel;

  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div
        className="bg-surface border border-app-border rounded-2xl w-full max-w-xl max-h-[calc(100dvh-2rem)] flex flex-col shadow-2xl"
        data-testid="scene-image-modal"
      >
        <div className="flex items-center justify-between px-4 sm:px-5 py-3 border-b border-app-border shrink-0">
          <div className="min-w-0">
            <h2 className="font-bold flex items-center gap-2"><ImageIcon size={16} /> Picture this scene</h2>
            <p className="text-[11px] text-muted truncate">
              {preset.label} · {preset.size.width}×{preset.size.height}
              {service.state !== 'up' && service.blockedReason ? ` · ${service.blockedReason}` : ''}
            </p>
          </div>
          <button
            onClick={() => { ctrl.current?.abort(); onClose(); }}
            aria-label="Close"
            className="flex items-center justify-center min-h-11 min-w-11 rounded-lg hover:bg-app-text/5"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-5 py-3 flex flex-col gap-3">
          {preview && (
            <img
              src={preview}
              alt=""
              data-testid="scene-image-preview"
              className="w-full rounded-xl border border-app-border"
            />
          )}

          <label className="block">
            <span className="text-xs font-bold uppercase tracking-wider text-muted flex items-center gap-2">
              Prompt
              {drafting && <Loader2 size={12} className="animate-spin" />}
              <button
                onClick={() => void draft()}
                disabled={drafting || !aiReady}
                title="Have the model read the passage again"
                className="ml-auto normal-case tracking-normal font-normal text-[11px] flex items-center gap-1 px-2 min-h-9 rounded-lg border border-app-border hover:bg-app-text/5 disabled:opacity-40"
              >
                <Wand2 size={12} /> Rewrite
              </button>
            </span>
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              rows={5}
              placeholder={aiReady ? 'reading the passage…' : 'Set an AI endpoint to have this written for you, or type one.'}
              data-testid="scene-image-prompt"
              className="mt-1 w-full bg-app-text/5 border border-app-border rounded-lg px-2 py-2 text-sm outline-none focus:border-accent/50 resize-y"
            />
          </label>

          {usedSheet && (
            <p className="text-[11px] text-muted leading-snug">
              Appearance for <strong>{cast.join(', ')}</strong> is prepended verbatim, so it cannot
              drift between pictures: <em>{usedSheet}</em>
            </p>
          )}

          {caps.has('negative') ? (
            <label className="block">
              <span className="text-xs font-bold uppercase tracking-wider text-muted">Negative</span>
              <textarea
                value={negative}
                onChange={e => setNegative(e.target.value)}
                rows={2}
                data-testid="scene-image-negative"
                className="mt-1 w-full bg-app-text/5 border border-app-border rounded-lg px-2 py-2 text-sm outline-none focus:border-accent/50 resize-y"
              />
            </label>
          ) : (
            <p className="text-[11px] text-muted leading-snug">
              {preset.usesNegative
                ? 'This workflow has no negative prompt node, so negatives are not sent.'
                : `${preset.label} ignores negative prompts, so none is sent.`}
            </p>
          )}

          {!caps.has('seed') && (
            <p className="text-[11px] text-muted leading-snug flex items-start gap-1.5">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              This backend has no seed, so the same character will look different in each
              picture. The appearance sheet is doing all the work.
            </p>
          )}

          {error && (
            <p className="text-[11px] text-amber-400/90 leading-snug" data-testid="scene-image-error">{error}</p>
          )}
        </div>

        <div className="px-4 sm:px-5 py-3 border-t border-app-border shrink-0 flex items-center gap-2">
          <button
            onClick={() => void run()}
            disabled={!prompt.trim() || generating || service.state === 'down' || !service.configured}
            data-testid="scene-image-generate"
            className={cn(
              'flex items-center justify-center gap-2 px-4 min-h-11 flex-1 rounded-lg bg-accent text-white',
              'text-sm font-medium disabled:opacity-50',
            )}
          >
            {generating ? <Loader2 size={15} className="animate-spin" /> : <ImageIcon size={15} />}
            {generating ? 'Generating…' : preview ? 'Generate another' : 'Generate'}
          </button>
          {generating && (
            <button
              onClick={() => ctrl.current?.abort()}
              className="px-3 min-h-11 rounded-lg border border-app-border text-sm hover:bg-app-text/5"
            >
              Cancel
            </button>
          )}
          {!generating && service.state === 'down' && (
            <button
              onClick={service.recheck}
              title="Check the image service again"
              className="flex items-center justify-center min-h-11 min-w-11 rounded-lg border border-app-border hover:bg-app-text/5"
            >
              <RefreshCw size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export const PRESET_IDS = IMAGE_PRESETS.map(p => p.id);
