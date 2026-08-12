/** Run: npx tsx src/utils/readingModes.test.ts */
import {
  MODE_KEYS, READING_MODES, READING_MODE_DEFS, ModeConfig, configForMode, modeDiff, modeLabel,
  modeMatches, nearestMode,
} from './readingModes';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };

// --- the bundles themselves --------------------------------------------------
ok(READING_MODE_DEFS.length === READING_MODES.length, 'every mode has a definition');
ok(READING_MODE_DEFS.every(d => READING_MODES.includes(d.mode)), 'no definition names an unknown mode');
// A mode that forgets a key would leave it wherever the last mode put it —
// picking a mode has to produce the SAME page every time, from any starting point.
for (const def of READING_MODE_DEFS) {
  const missing = MODE_KEYS.filter(k => def.config[k] === undefined);
  ok(missing.length === 0, `${def.mode} sets every mode key (missing: ${missing.join(', ')})`);
}
// Two modes that produce identical config would be a lie in the picker.
for (let i = 0; i < READING_MODE_DEFS.length; i++) {
  for (let j = i + 1; j < READING_MODE_DEFS.length; j++) {
    const a = READING_MODE_DEFS[i], b = READING_MODE_DEFS[j];
    ok(modeDiff(a.config, b.mode).length > 0, `${a.mode} and ${b.mode} are actually different`);
  }
}
ok(READING_MODE_DEFS.every(d => d.hint.trim().length > 0), 'every mode explains itself');

// The ladder: each step up may only ADD intervention, never take it away —
// that's what makes "walk it back one step" meaningful advice.
const LOUDNESS: (keyof ModeConfig)[] = [
  'expressiveText', 'cinematicPacing', 'sceneTheming', 'sceneSoundscapes',
  'sceneEmphasis', 'scenePerformance', 'emotionalTts', 'livingBackground', 'ttsEnabled',
];
for (let i = 1; i < READING_MODE_DEFS.length; i++) {
  const prev = READING_MODE_DEFS[i - 1], cur = READING_MODE_DEFS[i];
  const lost = LOUDNESS.filter(k => prev.config[k] === true && cur.config[k] !== true);
  ok(lost.length === 0, `${cur.mode} never turns off what ${prev.mode} turned on (lost: ${lost.join(', ')})`);
}
ok(
  READING_MODE_DEFS[0].config.ttsEnabled === false
  && READING_MODE_DEFS[READING_MODE_DEFS.length - 1].config.ttsEnabled === true,
  'only the loudest mode speaks',
);

// --- round-tripping ----------------------------------------------------------
for (const mode of READING_MODES) {
  const config = configForMode(mode);
  ok(modeMatches(config, mode), `${mode} matches its own config`);
  ok(modeDiff(config, mode).length === 0, `${mode} has no diff against itself`);
  ok(nearestMode(config) === mode, `${mode} is nearest to its own config`);
  ok(modeLabel(config, mode) === READING_MODE_DEFS.find(d => d.mode === mode)!.label,
    `${mode} shows a clean label when untouched`);
}

// configForMode must hand out a fresh object — a shared one would let a caller
// mutate the definition and silently redefine the mode for everyone.
const c1 = configForMode('cinema');
c1.sceneTheming = false;
ok(configForMode('cinema').sceneTheming === true, 'configForMode returns a copy, not the definition');

// --- divergence --------------------------------------------------------------
const touched: ModeConfig = { ...configForMode('cinema'), sceneSoundscapes: false };
ok(!modeMatches(touched, 'cinema'), 'changing one key breaks the match');
ok(modeDiff(touched, 'cinema').length === 1, 'and reports exactly the one key');
ok(modeDiff(touched, 'cinema')[0] === 'sceneSoundscapes', 'naming the key that changed');
ok(modeLabel(touched, 'cinema') === 'Cinema · modified', 'the label says modified');
// The INTENT is untouched by a hand edit — we never silently re-label the mode.
ok(nearestMode(touched) === 'cinema', 'a one-key edit is still nearest its own mode');

// --- partial configs (migration reads a raw persisted blob) ------------------
// Keys the old blob never had must not count as disagreements, or every
// existing reader would be "modified" the moment they upgraded.
ok(modeDiff({}, 'cinema').length === 0, 'an empty config disagrees with nothing');
ok(modeMatches({ sceneTheming: true }, 'cinema'), 'a partial config matches on the keys it has');
ok(!modeMatches({ sceneTheming: false }, 'cinema'), 'and still catches a real disagreement');

// --- nearestMode -------------------------------------------------------------
// The pre-v3 shipped defaults: Cinema, plus the perform track that used to
// default on. It must land on Cinema, not Plain, or existing readers open on a
// label that misdescribes their setup.
const legacyDefaults: Partial<ModeConfig> = {
  expressiveText: true, cinematicPacing: true, expressiveIntensity: 'expressive',
  sceneTheming: true, sceneSoundscapes: true, sceneEmphasis: false,
  scenePerformance: true, emotionalTts: true, livingBackground: false,
  streamEffect: 'none', dialogueAnimation: 'zoom', ttsEnabled: false,
};
ok(nearestMode(legacyDefaults) === 'cinema', 'the old shipped defaults read as Cinema');
ok(!modeMatches(legacyDefaults, 'cinema'), 'and honestly as modified, not a clean match');

// Everything off is Plain; everything on is Performance.
const allOff: Partial<ModeConfig> = {
  expressiveText: false, cinematicPacing: false, sceneTheming: false, sceneSoundscapes: false,
  sceneEmphasis: false, scenePerformance: false, emotionalTts: false, livingBackground: false,
  ttsEnabled: false,
};
ok(nearestMode(allOff) === 'plain', 'a silent config reads as Plain');
ok(nearestMode(configForMode('performance')) === 'performance', 'the full instrument reads as Performance');

// Ties go to the quieter mode — when we genuinely can't tell, under-claim.
const tie = nearestMode({});
ok(tie === 'plain', 'an unreadable config falls back to the quietest mode');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
