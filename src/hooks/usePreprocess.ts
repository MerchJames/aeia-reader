/**
 * Running the second pass on a reply SillyTavern just generated.
 *
 * `preprocess.ts` decides what each stage asks and how to read the answer; this
 * makes the calls, gathers the facts, and reports progress back over the
 * bridge. Kept apart so the judgement has tests and this has one job.
 *
 * ── Where the facts come from ──────────────────────────────────────────────
 *
 * The reader's own material, in the order it is likely to matter: the pins in
 * the active set first (that set is already the reader's statement of what is
 * currently relevant), then sheets, then any pin outside the set. Relevance
 * scoring narrows that further before a single call is made — working out
 * whether to spend a call must not itself cost one.
 *
 * ── Why it is sequential ───────────────────────────────────────────────────
 *
 * The checks could run in parallel and finish sooner. They do not, for two
 * reasons: a local model serving one request at a time gains nothing from
 * parallel requests and often degrades, and a serial run can stop early. Most
 * replies contradict nothing, so most runs are a handful of cheap NONEs — but
 * a run that has already found its repair budget has no reason to keep asking.
 */

import { useCallback, useRef } from 'react';
import { useAppStore } from '../store';
import { useAuraV2Store } from '../stores/useAuraV2Store';
import { askText } from '../utils/aiCall';
import { candidateBases } from '../utils/aiClient';
import { repairFormatting } from '../utils/textProcessor';
import {
  MAX_CHECKS, MAX_REPAIRS,
  applyRepair, buildCheckPrompt, buildRepairPrompt, emptyRun, readVerdict,
  relevantFacts, type CheckFact, type PreprocessRun, type RunFinding,
} from '../utils/preprocess';

export interface PreprocessOptions {
  /** Called before each stage, so the extension's status line can say so. */
  onStage?: (label: string, step: number, total: number) => void;
  /**
   * Whose pins and sheets to check against.
   *
   * Defaults to the open story, which is right everywhere except the proxy:
   * there the chat lives in SillyTavern and Aeia may be sitting on its library
   * with nothing open at all. The reader names the story in the proxy's
   * settings, and it arrives here.
   */
  storyId?: string;
}

/**
 * Everything the reader keeps that could contradict a reply.
 *
 * Pins in the active set come first because the set IS the reader's answer to
 * "what matters right now"; a pin they deliberately left out of it should not
 * outrank one they put in.
 */
const gatherFacts = (storyId: string): CheckFact[] => {
  const v2 = useAuraV2Store.getState();
  const pins = v2.pinsByStory[storyId] ?? [];
  const activeSetId = v2.activePinSetByStory?.[storyId];
  const sets = v2.pinSetsByStory?.[storyId] ?? [];
  const activeIds = new Set(
    // `inContext` rather than `docked`: the reader has already said these are
    // the pins the AI should be reasoning with, which is exactly this question.
    (sets.find((s: { id: string }) => s.id === activeSetId)?.inContext ?? []) as string[],
  );

  const fromPin = (p: { id: string; title: string; content: string }): CheckFact => ({
    id: p.id, source: 'pin', title: p.title, text: p.content,
  });

  const inSet = pins.filter((p: { id: string }) => activeIds.has(p.id)).map(fromPin);
  const outSet = pins.filter((p: { id: string }) => !activeIds.has(p.id)).map(fromPin);

  const sheets = (v2.sheetsByStory[storyId] ?? []).map((s: {
    id: string; title: string; columns: string[]; rows: Record<string, string>[];
  }) => ({
    id: s.id,
    source: 'sheet' as const,
    title: s.title,
    // A table is not prose, and a model reads it better as labelled lines than
    // as a grid it has to reconstruct.
    text: s.rows
      .map(row => s.columns.map(c => `${c}: ${row[c] ?? ''}`).join('; '))
      .join('\n'),
  }));

  return [...inSet, ...sheets, ...outSet];
};

export const usePreprocess = () => {
  /** One run at a time. A second reply arriving mid-run waits its turn. */
  const busy = useRef(false);

  const run = useCallback(async (
    reply: string,
    opts: PreprocessOptions = {},
  ): Promise<PreprocessRun> => {
    const started = Date.now();
    const out = emptyRun(reply);
    const app = useAppStore.getState();
    const storyId = opts.storyId || app.currentStory?.id;

    if (busy.current) return out;
    busy.current = true;

    try {
      /* ---- Stage one: deterministic, free, and always worth doing ---- */
      opts.onStage?.('Tidying the shape', 1, 1);
      // `repairFormatting` is the deterministic pass the reader already has —
      // unbalanced emphasis, stray markup, the shapes a model gets slightly
      // wrong. No model, no cost, and worth running before spending a call.
      const shaped = repairFormatting(reply);
      if (shaped !== reply) { out.text = shaped; out.reformatted = true; }

      // Everything past here needs a model and something to check against.
      if (!storyId || !app.aiBaseUrl || !app.aiModel) { out.ms = Date.now() - started; return out; }

      const facts = relevantFacts(out.text, gatherFacts(storyId), MAX_CHECKS);
      if (!facts.length) { out.ms = Date.now() - started; return out; }

  /**
   * Through the call layer, not the client.
   *
   * It matters more here than almost anywhere else in the app: a reasoning
   * model answers this check with its chain of thought wrapped around the
   * verdict, and the parser reads the FIRST thing that looks like a claim. A
   * model thinking out loud about whether something might contradict would be
   * read as saying it does, and every message would get rewritten. `askText`
   * strips the thinking before the parser ever sees it.
   */
      const target = {
        base: candidateBases(app.aiBaseUrl)[0],
        key: app.aiApiKey,
        model: app.aiModel,
      };
      const total = facts.length + 1;
      const findings: RunFinding[] = [];
      let repairs = 0;

      for (let i = 0; i < facts.length; i++) {
        const fact = facts[i];
        if (repairs >= MAX_REPAIRS) break;
        opts.onStage?.(`Checking against ${fact.title}`, i + 2, total);

        let verdictRaw = '';
        try {
          verdictRaw = await askText(
            target,
            [{ role: 'user', content: buildCheckPrompt(out.text, fact) }],
            // Deterministic: this is a classification, not writing. The budget
            // is the ANSWER's room — the layer adds headroom for thinking on
            // top, which is the whole reason a one-word verdict needs a number
            // here at all.
            { params: { temperature: 0 }, budget: 120, label: 'Checking' },
          );
          out.calls++;
        } catch {
          // A failed check is not a failed reply. Skip it and carry on — the
          // reader gets what the model wrote, which is the safe outcome.
          continue;
        }

        const verdict = readVerdict(verdictRaw, out.text);
        if (!verdict.contradicts) {
          if (verdict.rejected) {
            findings.push({
              factId: fact.id, factTitle: fact.title, sentence: '',
              repaired: false, skipped: verdict.rejected,
            });
          }
          continue;
        }

        opts.onStage?.(`Fixing one line against ${fact.title}`, i + 2, total);
        let rewritten = '';
        try {
          rewritten = await askText(
            target,
            [{ role: 'user', content: buildRepairPrompt(out.text, verdict.sentence, fact) }],
            // A little warmth: this one is writing, and a temperature of zero
            // produces the flattest possible sentence.
            { params: { temperature: 0.4 }, budget: 250, label: 'Repairing' },
          );
          out.calls++;
        } catch {
          findings.push({
            factId: fact.id, factTitle: fact.title, sentence: verdict.sentence,
            repaired: false, skipped: 'the repair call failed',
          });
          continue;
        }

        const repair = applyRepair(out.text, verdict.sentence, rewritten);
        findings.push({
          factId: fact.id, factTitle: fact.title, sentence: verdict.sentence,
          repaired: repair.ok, skipped: repair.refused,
        });
        if (repair.ok) { out.text = repair.text; repairs++; }
      }

      out.findings = findings;
      out.ms = Date.now() - started;
      return out;
    } catch {
      // Anything unexpected leaves the reply exactly as it arrived. A
      // pre-processor that can lose a message is worse than none.
      return { ...out, text: out.reformatted ? out.text : reply, ms: Date.now() - started };
    } finally {
      busy.current = false;
    }
  }, []);

  return run;
};
