/**
 * Setting up scene images.
 *
 * Two backends that could hardly be less alike: one takes a sentence, the other
 * takes an entire program. The awkward part is ComfyUI, and this panel exists
 * mostly to make that part honest — it shows what auto-detection found in the
 * reader's own workflow and lets them correct it.
 *
 * Showing the detection is not a nicety. A workflow whose prompt node is
 * guessed wrong generates from the NEGATIVE prompt, which produces a picture of
 * everything you asked to avoid and reads as "this feature is bad" rather than
 * "this is pointed at the wrong node".
 */

import { useMemo, useState } from 'react';
import { AlertTriangle, Check } from 'lucide-react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { IMAGE_PRESETS } from '../utils/imagePresets';
import { appearanceFromCard } from '../utils/imagePrompt';
import { detectMapping, parseWorkflow } from '../services/image';
import { ServiceDot } from './ServiceStatus';
import type { ImageAdapterId } from '../types';

// min-h-11: these fields are always visible in the panel, and the mobile audit
// holds every tap target to 40px. py-1.5 alone gives 34.
const field = 'mt-1 w-full bg-app-text/5 border border-app-border rounded-md px-2 min-h-11 py-1.5 text-sm outline-none focus:border-accent/50';
const label = 'text-xs font-bold uppercase tracking-wider text-muted';

/** What auto-detection made of the pasted workflow. */
const WorkflowReadout = () => {
  const workflow = useAppStore(s => s.comfyWorkflow);
  const mapping = useAppStore(s => s.comfyMapping);
  const setMapping = useAppStore(s => s.setComfyMapping);

  const parsed = useMemo(() => parseWorkflow(workflow), [workflow]);
  const detection = useMemo(() => (parsed ? detectMapping(parsed) : null), [parsed]);

  if (!workflow.trim()) {
    return (
      <p className="text-[11px] text-muted leading-snug">
        In ComfyUI: build the graph you want, then <strong>Workflow → Export (API)</strong> and
        paste the file here. The UI export will not work — it is a different format and cannot be
        run.
      </p>
    );
  }
  if (!parsed) {
    return (
      <p className="text-[11px] text-amber-400/90 leading-snug flex items-start gap-1.5">
        <AlertTriangle size={12} className="mt-0.5 shrink-0" />
        That is not an API-format workflow. Use <strong>Export (API)</strong>, not Save or Export.
      </p>
    );
  }

  const textNodes = Object.entries(parsed)
    .filter(([, n]) => n.class_type.startsWith('CLIPTextEncode'))
    .map(([id]) => id);
  const chosen = mapping.positive ?? detection?.mapping.positive;

  return (
    <div className="flex flex-col gap-1.5">
      <ul className="text-[11px] text-muted leading-snug list-disc pl-4">
        {detection?.notes.map((n, i) => <li key={i}>{n}</li>)}
      </ul>
      {textNodes.length > 1 && (
        <label className="block">
          <span className="text-[11px] text-muted">Prompt node</span>
          <select
            value={chosen ?? ''}
            onChange={e => setMapping({ ...mapping, positive: e.target.value || undefined })}
            data-testid="comfy-positive-node"
            className={field}
          >
            <option value="">— auto —</option>
            {textNodes.map(id => (
              <option key={id} value={id}>
                node {id}: {String((parsed[id].inputs.text ?? parsed[id].inputs.text_g ?? '')).slice(0, 48) || '(empty)'}
              </option>
            ))}
          </select>
        </label>
      )}
      {detection && !detection.usable && !mapping.positive && (
        <p className="text-[11px] text-amber-400/90 leading-snug flex items-start gap-1.5">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          Pick which node holds the prompt — guessing wrong here would generate from the
          negative prompt.
        </p>
      )}
      {(mapping.positive || detection?.usable) && (
        <p className="text-[11px] text-emerald-500/90 flex items-center gap-1.5">
          <Check size={12} /> Ready.
        </p>
      )}
    </div>
  );
};

/** The appearance sheet for this story's lead — the continuity control. */
const AppearanceSheet = () => {
  const story = useAppStore(s => s.currentStory);
  const sheets = useAuraV2Store(s => (story ? s.appearanceByStory[story.id] : undefined));
  const setAppearance = useAuraV2Store(s => s.setAppearance);
  const seeds = useAuraV2Store(s => (story ? s.artSeedByStory[story.id] : undefined));
  const setArtSeed = useAuraV2Store(s => s.setArtSeed);

  const name = story?.characterName?.trim();
  const key = name?.toLowerCase() ?? '';
  const [draft, setDraft] = useState<string | null>(null);
  if (!story || !name) return null;

  const stored = sheets?.[key] ?? '';
  const value = draft ?? stored;
  const seed = seeds?.[key];

  return (
    <div className="flex flex-col gap-1.5">
      <span className={label}>What {name} looks like</span>
      <textarea
        value={value}
        rows={3}
        placeholder={appearanceFromCard(story.card) || 'red hair in a short braid, green eyes, long grey coat'}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => { if (draft !== null) { setAppearance(story.id, key, draft); setDraft(null); } }}
        data-testid="appearance-sheet"
        className={`${field} resize-y`}
      />
      <p className="text-[11px] text-muted leading-snug">
        Prepended verbatim to every prompt, ahead of the scene, so it cannot drift between
        pictures. Left empty, this is read off the character card. Asking the model to remember
        a face across separate calls is the one thing it cannot do — this is the fix.
      </p>
      {seed != null && (
        <p className="text-[11px] text-muted flex items-center gap-2">
          Seed locked to <code>{seed}</code>
          <button
            onClick={() => setArtSeed(story.id, key, null)}
            className="px-2 min-h-9 rounded-lg border border-app-border hover:bg-app-text/5"
          >
            Unlock
          </button>
        </p>
      )}
    </div>
  );
};

export const SceneImageSettings = () => {
  const store = useAppStore();

  return (
    <div className="flex flex-col gap-2">
      <label className="block">
        <span className={`${label} flex items-center gap-1.5`}>
          Backend <ServiceDot id="image" />
        </span>
        <select
          value={store.imageAdapter}
          onChange={e => store.setImageAdapter(e.target.value as ImageAdapterId)}
          data-testid="image-adapter"
          className={field}
        >
          <option value="comfy">ComfyUI</option>
          <option value="openai">OpenAI-compatible (/v1/images)</option>
        </select>
      </label>

      <label className="block">
        <span className={label}>Address</span>
        <input
          type="text"
          value={store.imageBaseUrl}
          onChange={e => store.setImageBaseUrl(e.target.value)}
          placeholder={store.imageAdapter === 'comfy' ? 'http://localhost:8188' : 'http://localhost:8080/v1'}
          data-testid="image-base-url"
          className={field}
        />
      </label>

      {store.imageAdapter === 'openai' ? (
        <>
          <label className="block">
            <span className={label}>API key (optional)</span>
            <input
              type="password"
              value={store.imageApiKey}
              onChange={e => store.setImageApiKey(e.target.value)}
              placeholder="leave blank for local"
              className={field}
            />
          </label>
          <label className="block">
            <span className={label}>Model</span>
            <input
              type="text"
              value={store.imageModel}
              onChange={e => store.setImageModel(e.target.value)}
              placeholder="dall-e-3"
              className={field}
            />
          </label>
          <p className="text-[11px] text-muted leading-snug">
            This endpoint has no seed and no reference image, so continuity rests entirely on the
            appearance sheet below.
          </p>
        </>
      ) : (
        <>
          <label className="block">
            <span className={label}>Workflow (API format)</span>
            <textarea
              value={store.comfyWorkflow}
              onChange={e => store.setComfyWorkflow(e.target.value)}
              rows={4}
              spellCheck={false}
              placeholder='{"3": {"class_type": "KSampler", …}}'
              data-testid="comfy-workflow"
              className={`${field} font-mono text-[11px] resize-y`}
            />
          </label>
          <WorkflowReadout />
        </>
      )}

      <label className="block">
        <span className={label}>Prompt style</span>
        <select
          value={store.imagePreset}
          onChange={e => store.setImagePreset(e.target.value)}
          data-testid="image-preset"
          className={field}
        >
          {IMAGE_PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>
      <p className="text-[11px] text-muted leading-snug">
        {IMAGE_PRESETS.find(p => p.id === store.imagePreset)?.hint}
      </p>

      <label className="block">
        <span className={label}>Always avoid (added to every negative)</span>
        <input
          type="text"
          value={store.imageNegativeExtra}
          onChange={e => store.setImageNegativeExtra(e.target.value)}
          placeholder="modern clothing, glasses…"
          className={field}
        />
      </label>

      <AppearanceSheet />

      <p className="text-[11px] text-muted leading-snug border-t border-app-border/60 pt-2">
        Pictures are filed against the passage they were made for and never touch the source
        chat or the Lens — turning the Lens off does not remove them, and exporting the story
        carries them along, embedded.
      </p>
    </div>
  );
};
