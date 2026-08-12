/**
 * Is the Director's variance (and its over-cueing) a SAMPLER problem?
 *
 * The A/B showed 13 vs 19 perform cues on identical input — run-to-run noise
 * larger than the effect being measured. The Director sends only
 * `{ temperature: 0.2, max_tokens }`, so top_p / top_k / min_p / repetition
 * penalty all fall through to whatever the backend defaults to. KoboldCpp's
 * defaults are creative-writing defaults, and one of them is actively wrong
 * here: repetition penalty on a JSON array penalises the tokens that repeat
 * most — the field names, `null`, and `[]` — which are exactly the tokens that
 * mean "this passage needs no cue".
 *
 * This runs the same batch N times under each regime and reports the spread.
 *
 *   npx tsx scripts/director-samplers.ts <story.jsonl> --base <url> --model <n> [--runs 3]
 */

import { readFileSync } from 'node:fs';
import { ScenePassage, buildEnrichMessages, outputBudget, parseDescriptors } from '../src/utils/sceneDirector';
import { SamplerParams, chatCompletion } from '../src/utils/aiClient';

const args = process.argv.slice(2);
const flag = (n: string, d = '') => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1] ?? d; };
const file = args[0]?.startsWith('--') ? '' : args[0];
const base = flag('base'), model = flag('model'), key = flag('key');
const runs = Number(flag('runs', '3'));

if (!file || !base || !model) {
  console.error('usage: npx tsx scripts/director-samplers.ts <story.jsonl> --base <url> --model <name> [--runs n]');
  process.exit(1);
}

const loadPassages = (path: string): ScenePassage[] => {
  const out: ScenePassage[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (typeof r?.mes !== 'string' || r.is_user) continue;
      out.push({ messageId: `m${out.length}`, name: r.name ?? 'Narrator', content: r.mes });
    } catch { /* metadata */ }
  }
  return out;
};

/** What ships today: one knob set, everything else left to the backend. */
const CURRENT: SamplerParams = { temperature: 0.2 };

/**
 * Annotation, not prose. Greedy decoding makes a re-read reproducible, and
 * repetition_penalty 1 stops the sampler fighting the `null`s and `[]`s that
 * mean restraint.
 */
const STRICT: SamplerParams = {
  temperature: 0, top_p: 1, top_k: 1, min_p: 0,
  repetition_penalty: 1, frequency_penalty: 0, presence_penalty: 0,
};

interface Shot { perform: number; emphasis: number; fx: number; vfx: number; quiet: number; read: number }

const once = async (batch: ScenePassage[], params: SamplerParams): Promise<Shot> => {
  const reply = await chatCompletion(
    base, key, model, buildEnrichMessages(batch), { max_tokens: outputBudget(batch.length), ...params },
  );
  const ds = parseDescriptors(reply, batch);
  const s: Shot = { perform: 0, emphasis: 0, fx: 0, vfx: 0, quiet: 0, read: ds.length };
  for (const d of ds) {
    const p = d.perform?.length ?? 0, e = d.emphasis?.length ?? 0;
    s.perform += p; s.emphasis += e;
    if (d.fx) s.fx++;
    if (d.vfx) s.vfx++;
    if (!p && !e && !d.fx && !d.vfx) s.quiet++;
  }
  return s;
};

const spread = (label: string, shots: Shot[]) => {
  const col = (k: keyof Shot) => shots.map(s => s[k]);
  const fmt = (k: keyof Shot) => {
    const v = col(k);
    const lo = Math.min(...v), hi = Math.max(...v);
    return `${String(lo).padStart(3)}–${String(hi).toString().padEnd(3)} ${lo === hi ? '(stable)' : `(±${hi - lo})`}`;
  };
  console.log(`\n  ${label}`);
  console.log(`    passages read  ${fmt('read')}   ${col('read').join(', ')}`);
  console.log(`    perform cues   ${fmt('perform')}   ${col('perform').join(', ')}`);
  console.log(`    emphasis       ${fmt('emphasis')}   ${col('emphasis').join(', ')}`);
  console.log(`    weather (fx)   ${fmt('fx')}   ${col('fx').join(', ')}`);
  console.log(`    screen vfx     ${fmt('vfx')}   ${col('vfx').join(', ')}`);
  console.log(`    left alone     ${fmt('quiet')}   ${col('quiet').join(', ')}`);
};

const main = async () => {
  const batch = loadPassages(file).slice(0, 10);
  console.log(`Same ${batch.length}-passage batch, ${runs} runs per regime.\n`);
  console.log('  current = what ships today: { temperature: 0.2 }, rest left to the backend');
  console.log('  strict  = greedy + repetition_penalty 1 (annotation, not prose)');

  const current: Shot[] = [];
  for (let i = 0; i < runs; i++) current.push(await once(batch, CURRENT));
  const strict: Shot[] = [];
  for (let i = 0; i < runs; i++) strict.push(await once(batch, STRICT));

  spread('CURRENT', current);
  spread('STRICT', strict);

  const varied = (s: Shot[], k: keyof Shot) => Math.max(...s.map(x => x[k])) - Math.min(...s.map(x => x[k]));
  console.log('\n  Determinism (range across runs; 0 = identical every time):');
  for (const k of ['perform', 'emphasis', 'fx', 'vfx', 'quiet'] as (keyof Shot)[]) {
    console.log(`    ${k.padEnd(9)} current ±${varied(current, k)}   strict ±${varied(strict, k)}`);
  }
  const mean = (s: Shot[], k: keyof Shot) => s.reduce((a, x) => a + x[k], 0) / s.length;
  console.log('\n  Restraint (mean passages left alone, of ' + batch.length + '):');
  console.log(`    current ${mean(current, 'quiet').toFixed(1)}   strict ${mean(strict, 'quiet').toFixed(1)}`);
};

void main().catch(e => { console.error(e); process.exit(1); });
