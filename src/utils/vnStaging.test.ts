import { deriveStaging, StagingInput } from './vnStaging';

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; } else { fail++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
};

const base: StagingInput = {
  primaryIsSpeech: false,
  speakerSide: null,
  descriptor: undefined,
  locationJustChanged: false,
  bothOnStage: true,
};

// A fresh location always establishes, center, no push.
eq('location change → establishing',
  deriveStaging({ ...base, locationJustChanged: true, primaryIsSpeech: true, speakerSide: 'char' }),
  { shot: 'establishing', focus: 'center', dof: false });

// Character speech pushes in on the left with DOF.
eq('char speech → close/left/dof',
  deriveStaging({ ...base, primaryIsSpeech: true, speakerSide: 'char' }),
  { shot: 'close', focus: 'left', dof: true });

// Reader speech pushes in on the right.
eq('user speech → close/right',
  deriveStaging({ ...base, primaryIsSpeech: true, speakerSide: 'user' }),
  { shot: 'close', focus: 'right', dof: true });

// Solo stage never side-focuses even on speech.
eq('solo speech → center',
  deriveStaging({ ...base, primaryIsSpeech: true, speakerSide: 'char', bothOnStage: false }),
  { shot: 'close', focus: 'center', dof: true });

// Calm narration sits wide.
eq('calm narration → wide',
  deriveStaging({ ...base, descriptor: { mood: 'tender', tension: 0.2 } }),
  { shot: 'wide', focus: 'center', dof: false });

// Tense narration tightens to mid.
eq('tense narration → mid',
  deriveStaging({ ...base, descriptor: { mood: 'ominous', tension: 0.7 } }),
  { shot: 'mid', focus: 'center', dof: false });

// The Director's explicit shot overrides the heuristic (speech but asked wide).
eq('AI shot override → wide',
  deriveStaging({ ...base, primaryIsSpeech: true, speakerSide: 'char',
                  descriptor: { mood: 'awe', tension: 0.5, shot: 'wide' } }),
  { shot: 'wide', focus: 'left', dof: false });

console.log(`\nvnStaging: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
