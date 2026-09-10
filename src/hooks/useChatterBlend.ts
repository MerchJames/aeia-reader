/**
 * Running a Chatter Blend.
 *
 * `chatterBlend.ts` decides what to ask and how to judge the answer; this makes
 * the call. Split the same way `usePreprocess` is split from `preprocess.ts`,
 * for the same reason: the judgement is the part worth testing, and it cannot
 * be tested with a fetch in it.
 *
 * One at a time, and never in the background. A blend is something the reader
 * asked for and is waiting on, so there is nothing to queue and nothing to
 * schedule — if a second request arrives while one is running, the first is the
 * one they are looking at.
 */

import { useCallback, useRef, useState } from 'react';
import { useAppStore } from '../store';
import { askText } from '../utils/aiCall';
import { candidateBases } from '../utils/aiClient';
import {
  blendProblem, blendSource, buildBlendPrompt, readBlend,
  type BlendResult, type BlendSource,
} from '../utils/chatterBlend';
import type { Chain } from '../types';

export interface BlendRun {
  running: boolean;
  /** The chain being blended, so the modal knows what it is looking at. */
  source: BlendSource | null;
  result: BlendResult | null;
  /** A problem with the request itself — no endpoint, nothing to blend. */
  error: string | null;
}

const IDLE: BlendRun = { running: false, source: null, result: null, error: null };

export const useChatterBlend = () => {
  const [run, setRun] = useState<BlendRun>(IDLE);
  const busy = useRef(false);

  const reset = useCallback(() => setRun(IDLE), []);

  const blend = useCallback(async (chain: Chain) => {
    if (busy.current) return;

    const app = useAppStore.getState();
    if (!app.aiBaseUrl || !app.aiModel) {
      setRun({ ...IDLE, error: 'Connect an endpoint first — a blend is a model rewriting a passage.' });
      return;
    }
    const problem = blendProblem(chain);
    if (problem) { setRun({ ...IDLE, error: problem }); return; }

    const source = blendSource(chain);
    if (!source) { setRun({ ...IDLE, error: 'There is nothing in this passage to blend.' }); return; }

    busy.current = true;
    setRun({ running: true, source, result: null, error: null });
    try {
      const reply = await askText(
        {
          base: candidateBases(app.aiBaseUrl)[0],
          key: app.aiApiKey,
          model: app.aiModel,
        },
        [{ role: 'user', content: buildBlendPrompt(source) }],
        {
          label: 'Blending',
          // Warm, because this is writing. Not hot: the job is to rearrange
          // sentences that already exist, and a high temperature is exactly how
          // a rearrangement turns into a new draft.
          params: { temperature: 0.6 },
          // Room for the whole passage plus the slack a model takes rewriting
          // it. Too small and the answer is cut off mid-sentence, which the
          // length guard then reports as a summary — a true refusal for the
          // wrong reason, and a confusing one to read.
          budget: Math.ceil((source.userText.length + source.aiText.length) / 2) + 400,
        },
      );
      setRun({ running: false, source, result: readBlend(reply, source), error: null });
    } catch (e: any) {
      setRun({ running: false, source, result: null, error: String(e?.message ?? e) });
    } finally {
      busy.current = false;
    }
  }, []);

  return { run, blend, reset };
};
