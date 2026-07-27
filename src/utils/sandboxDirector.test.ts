/**
 * Run: npx tsx src/utils/sandboxDirector.test.ts
 * Pure checks for the Sandbox AI treatment parse + sanitize (no network).
 */
import {
  buildSandboxMessages, buildStudioMessages, parseSandboxTreatment,
  parseStudioConfig, sanitizeCss, sanitizeSkeleton,
  buildCueMessages, parseCueTrack, resolveCues,
  buildPlanMessages, parseScenePlan, buildSceneMessages,
} from './sandboxDirector';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };

// Prompt carries the message but forbids reproducing it.
const msgs = buildSandboxMessages({ name: 'Mara', isUser: false, content: 'The hearth crackled.', mood: 'tense', tension: 0.7 });
ok(msgs[0].role === 'system' && /NEVER write/i.test(msgs[0].content), 'system forbids writing story text');
ok(msgs[1].content.includes('Mara') && msgs[1].content.includes('tense'), 'user carries speaker + mood');
ok(msgs[1].content.includes('The hearth crackled.'), 'user carries the text as context');

// sanitizeCss strips network + tag-escape + script-in-css.
ok(!/@import/i.test(sanitizeCss('@import url(http://evil);.card{color:red}')), 'css @import stripped');
ok(!/<\/style>/i.test(sanitizeCss('.card{}</style><script>x</script>')), 'css cannot close the style tag');
ok(!/expression/i.test(sanitizeCss('.x{width:expression(alert(1))}')), 'css expression() neutralized');
ok(sanitizeCss('.x{background:url(http://a/b.png)}').includes('none'), 'remote url() → none');
ok(sanitizeCss('.x{background:url(data:image/png;base64,AA)}').includes('data:'), 'data: url() kept');

// sanitizeSkeleton removes active content but keeps structure + placeholders.
const dirty = '<div onclick="steal()"><script>x</script><b>{{speaker}}</b><p>{{body}}</p></div>';
const clean = sanitizeSkeleton(dirty);
ok(!/<script/i.test(clean), 'skeleton script stripped');
ok(!/onclick/i.test(clean), 'skeleton event handler stripped');
ok(clean.includes('{{speaker}}') && clean.includes('{{body}}'), 'skeleton keeps placeholders');

// parse: css fence extracted, skeleton kept only when it still slots the body.
const good = parseSandboxTreatment('Here you go:\n```css\n.card{color:gold}\n```\n```html\n<div class="k">{{speaker}}: {{body}}</div>\n```');
ok(!!good && good.css.includes('gold'), 'parse extracts css fence');
ok(!!good?.skeleton && good.skeleton.includes('{{body}}'), 'parse keeps a body-slotting skeleton');

// A skeleton that loses its body after sanitizing is dropped (css still used).
const noBody = parseSandboxTreatment('```css\n.card{}\n```\n```html\n<script>{{body}}</script>\n```');
ok(!!noBody && noBody.skeleton === undefined, 'skeleton without a surviving {{body}} is dropped');

// Bare CSS (no fence) is accepted; pure prose is rejected.
ok(!!parseSandboxTreatment('.card { background: navy; padding: 12px }'), 'bare css accepted');
ok(parseSandboxTreatment('Sorry, I cannot help with that.') === null, 'prose reply → null (keep heuristic)');
ok(parseSandboxTreatment('') === null, 'empty reply → null');

// ---- Studio: theme + shell prompts and parsing ----

const themeMsgs = buildStudioMessages({ intent: 'noir', scope: 'chat', kind: 'theme', samples: ['a line'], cast: ['Mara'] });
ok(/REUSABLE theme/i.test(themeMsgs[0].content), 'theme system describes a reusable theme');
ok(themeMsgs[1].content.includes('noir') && themeMsgs[1].content.includes('the chat'), 'theme user carries intent + scope');

const shellMsgs = buildStudioMessages({ intent: 'terminal', scope: 'chat', kind: 'shell', samples: [], cast: [] });
ok(/FULL-VIEWPORT/i.test(shellMsgs[0].content), 'view system asks for a full-viewport frame');
ok(/ONE message/i.test(shellMsgs[0].content) && /playback controls/i.test(shellMsgs[0].content), 'view system: one message, Aura-provided controls');

// Theme parse: css (+ optional skeleton).
const themeCfg = parseStudioConfig('```css\n.card{color:silver}\n```', 'theme');
ok(!!themeCfg && themeCfg.css.includes('silver') && themeCfg.skeleton === undefined, 'theme config parses css, no skeleton');

// View parse: single-message contract (css + optional {{body}} skeleton + title).
const shellReply = [
  '[TITLE: Blackwood]',
  '```css', '.stage{background:#000}', '```',
  '```html', '<h1>{{title}}</h1><b class="who">{{speaker}}</b><div>{{body}}</div>', '```',
].join('\n');
const shellCfg = parseStudioConfig(shellReply, 'shell');
ok(!!shellCfg, 'view config parses');
ok(shellCfg?.title === 'Blackwood', 'view title read from [TITLE:] sidecar');
ok(!!shellCfg?.skeleton && shellCfg.skeleton.includes('{{body}}'), 'view skeleton slots {{body}}');

// A view whose skeleton loses {{body}} keeps the css but drops the skeleton.
const viewNoBody = parseStudioConfig('```css\n.x{}\n```\n```html\n<script>{{body}}</script>\n```', 'shell');
ok(!!viewNoBody && viewNoBody.skeleton === undefined, 'view skeleton without a surviving {{body}} is dropped');
// CSS is still required.
ok(parseStudioConfig('no code here', 'shell') === null, 'view without css → null');

// ---- Studio: view trinkets wired into the prompt ----

const trinketMsgs = buildStudioMessages({ intent: 'terminal', scope: 'chat', kind: 'shell', samples: [], cast: [], controls: ['playpause', 'text'] });
ok(/data-act="toggle-playback"/.test(trinketMsgs[1].content), 'requested play/pause trinket → toggle-playback hook in prompt');
ok(/data-act="toggle-text"/.test(trinketMsgs[1].content), 'requested text switch → toggle-text hook in prompt');
ok(!/data-act="next"/.test(trinketMsgs[1].content), 'unrequested trinkets are not injected');
// A theme (not a view) never gets trinkets even if asked.
ok(!/data-act/.test(buildStudioMessages({ intent: 'x', scope: 'chat', kind: 'theme', samples: [], cast: [], controls: ['playpause'] })[1].content), 'themes get no trinkets');

// ---- Scene director: cue track parse + anchor resolution ----

const cueMsgs = buildCueMessages({ name: 'Mara', content: 'The blade had fallen but Mara had not given up. Then she got up again.' });
ok(/SCENE DIRECTOR/i.test(cueMsgs[0].content), 'cue system announces the scene director');
ok(/anchor/i.test(cueMsgs[0].content) && /verbatim/i.test(cueMsgs[0].content), 'cue system demands verbatim anchors');

const cueContent = 'The blade had fallen but Mara had not given up. Then she got up again.';
const cueReply = [
  'Sure:',
  '```json',
  JSON.stringify([
    { anchor: 'blade had fallen', kind: 'audio', sound: 'clink', label: 'sword drop' },
    { anchor: 'got up again', kind: 'fx', fx: 'rumble', label: 'she rises' },
    { anchor: 'not in the text at all', kind: 'fx', fx: 'shake' },
    { anchor: 'given up', kind: 'fx', fx: 'notarealfx' },
    { anchor: 'Mara', kind: 'audio', sound: 'notarealsound' },
  ]),
  '```',
].join('\n');
const track = parseCueTrack(cueReply, cueContent);
ok(track.length === 2, 'cue track keeps only valid, anchored cues (drops bad anchor + bad enums)');
ok(track[0].sound === 'clink' && track[1].fx === 'rumble', 'cues sorted into reading order by anchor position');
ok(track.every(c => c.id.startsWith('cue-')), 'every cue gets an id');
ok(parseCueTrack('no json here', cueContent).length === 0, 'no json → empty track');
ok(parseCueTrack('```json\n{"not":"an array"}\n```', cueContent).length === 0, 'non-array json → empty track');

// Scene cues: a full-presentation swap parses to a theme cue with sanitized css,
// optional entry fx, and a pace; unusable css is dropped.
const sceneReply = [
  '```json',
  JSON.stringify([
    { anchor: 'blade had fallen', kind: 'scene', css: 'body{background:#100}.card{transform:perspective(400px) rotateX(4deg)}', pace: 'slow', fx: 'zoom', label: 'door opens' },
    { anchor: 'given up', kind: 'scene', css: '@import url(http://evil);' },
  ]),
  '```',
].join('\n');
const scenes = parseCueTrack(sceneReply, cueContent);
ok(scenes.length === 1, 'scene with only a remote @import (sanitises to empty) is dropped');
ok(scenes[0].kind === 'theme' && /perspective/.test(scenes[0].css || '') && !/@import/i.test(scenes[0].css || ''), 'scene css kept + sanitised');
ok(scenes[0].pace === 'slow' && scenes[0].fx === 'zoom', 'scene carries pace + entry fx');

// resolveCues turns anchors into offsets AFTER the phrase, in order, dropping stale ones.
const resolved = resolveCues(track, cueContent);
ok(resolved.length === 2 && resolved[0].at < resolved[1].at, 'resolveCues orders by offset');
ok(resolved[0].at === cueContent.indexOf('blade had fallen') + 'blade had fallen'.length, 'offset lands just after the anchor phrase');
ok(resolveCues([{ id: 'x', anchor: 'ghost words', kind: 'fx', fx: 'shake' }], cueContent).length === 0, 'anchors no longer present are dropped');

// ---- Two-pass director: plan a shot list, then build one beat ----

const planMsgs = buildPlanMessages({ name: 'Mara', content: cueContent });
ok(/SHOT LIST/i.test(planMsgs[0].content) && /do NOT build/i.test(planMsgs[0].content), 'plan system pitches a shot list, no building yet');

const planReply = [
  '```json',
  JSON.stringify([
    { anchor: 'blade had fallen', kind: 'scene', intent: 'the view drops to the floor where the blade lies' },
    { anchor: 'got up again', kind: 'fx', intent: 'a defiant rise' },
    { anchor: 'nowhere in the text', kind: 'scene', intent: 'dropped — bad anchor' },
    { anchor: 'given up', kind: 'scene', intent: '' }, // no intent → dropped
  ]),
  '```',
].join('\n');
const plan = parseScenePlan(planReply, cueContent);
ok(plan.length === 2, 'plan keeps only anchored beats with an intent');
ok(plan[0].kind === 'scene' && plan[0].intent.includes('blade') && plan[0].id.startsWith('cue-'), 'plan item carries kind + intent + id');
ok(plan[0].anchor === 'blade had fallen' && plan[1].anchor === 'got up again', 'plan sorted into reading order');
ok(parseScenePlan('no json', cueContent).length === 0, 'plan with no json → empty');

// Per-beat build prompt carries the approved anchor + intent + kind.
const buildMsgs = buildSceneMessages({ name: 'Mara', content: cueContent }, plan[0]);
ok(/ONE approved shot/i.test(buildMsgs[0].content), 'build system builds one shot');
ok(buildMsgs[1].content.includes('blade had fallen') && buildMsgs[1].content.includes('the view drops'), 'build user carries the approved anchor + intent');
// The build system carries the craft guidance (anti-slop + fixed-viewport sizing).
ok(/AI-slop/i.test(buildMsgs[0].content) && /FIXED, NON-SCROLLING/i.test(buildMsgs[0].content), 'build system warns against slop + states the fixed viewport');

// Standing guidance threads into BOTH passes when present, and is absent otherwise.
const gPlan = buildPlanMessages({ name: 'Mara', content: cueContent, guidance: '1970s giallo horror' });
ok(/STANDING GUIDANCE/i.test(gPlan[1].content) && /giallo horror/.test(gPlan[1].content), 'plan carries standing guidance');
const gBuild = buildSceneMessages({ name: 'Mara', content: cueContent, guidance: '1970s giallo horror' }, plan[0]);
ok(/giallo horror/.test(gBuild[1].content), 'build carries standing guidance');
ok(!/STANDING GUIDANCE/i.test(buildMsgs[1].content), 'no guidance line when none given');

// Focal-edge + speaker-attribution direction reaches both passes.
ok(/REVEAL EDGE/i.test(planMsgs[0].content) && /REVEAL EDGE/i.test(buildMsgs[0].content), 'both passes name the live reveal edge as the focal point');
ok(/WHO SPEAKS/i.test(planMsgs[0].content) && /WHO SPEAKS/i.test(buildMsgs[0].content), 'both passes tell the director to attribute quotes by speaker');

// Cast is offered to the director (excluding the message author) so a quoted NPC
// can be voiced distinctly; absent when no other cast is present.
const castPlan = buildPlanMessages({ name: 'Mara', content: cueContent, cast: ['Mara', 'Kael', 'the Innkeeper'] });
ok(/attribute each quote/i.test(castPlan[1].content) && /Kael/.test(castPlan[1].content) && /Innkeeper/.test(castPlan[1].content), 'plan lists the surrounding cast');
ok(!/\bMara\b.*Mara/.test(castPlan[1].content.split('attribute each quote')[1] ?? ''), 'the speaking author is not re-listed as other cast');
ok(!/attribute each quote/i.test(buildMsgs[1].content), 'no cast line when none supplied');

// --- Adaptive soundscapes: the audio library palette + asset reuse -----------
const palette = [
  { id: 'music__medieval-panflute__aaaaaaaaaa', category: 'music', tags: ['medieval', 'panflute', 'pastoral'] },
  { id: 'ambience__tavern-murmur__bbbbbbbbbb', category: 'ambience', tags: ['tavern', 'crowd'] },
  { id: 'sfx__door-creak__cccccccccc', category: 'sfx', tags: ['door', 'creak'] },
];
const libPlan = buildPlanMessages({ name: 'Mara', content: cueContent, audioLibrary: palette });
ok(/AUDIO LIBRARY/i.test(libPlan[1].content) && libPlan[1].content.includes('music__medieval-panflute__aaaaaaaaaa'),
  'plan lists the audio library palette by id');
ok(/ADAPTIVE SOUNDSCAPE/i.test(libPlan[0].content) && /REUSE/i.test(libPlan[0].content),
  'plan system instructs reuse of existing clips');
// Beds (music/ambience) are listed before one-shot sfx so continuity is the easy reach.
ok(libPlan[1].content.indexOf('music__') < libPlan[1].content.indexOf('sfx__door'),
  'palette lists beds before one-shots');
ok(!/AUDIO LIBRARY/i.test(buildPlanMessages({ name: 'Mara', content: cueContent })[1].content),
  'no library block when no palette supplied');

// A valid asset id on an audio beat is honoured; an invented one is ignored.
const reusePlanReply = ['```json', JSON.stringify([
  { anchor: 'blade had fallen', kind: 'audio', intent: 'sombre bed', asset: 'music__medieval-panflute__aaaaaaaaaa' },
  { anchor: 'got up again', kind: 'audio', intent: 'a made-up clip', asset: 'music__does-not-exist__zzzzzzzzzz' },
]), '```'].join('\n');
const validIds = new Set(palette.map(p => p.id));
const reusePlan = parseScenePlan(reusePlanReply, cueContent, validIds);
ok(reusePlan[0].assetId === 'music__medieval-panflute__aaaaaaaaaa', 'valid asset id is carried onto the plan item');
ok(reusePlan[1].assetId === undefined, 'an asset id not in the palette is rejected');
// Without a palette, no asset id is ever attached (even if the model sends one).
ok(parseScenePlan(reusePlanReply, cueContent)[0].assetId === undefined, 'asset id ignored when no palette is offered');
// asset is only honoured for audio beats, never scene/fx.
const sceneAssetReply = ['```json', JSON.stringify([
  { anchor: 'blade had fallen', kind: 'scene', intent: 'x', asset: 'music__medieval-panflute__aaaaaaaaaa' },
]), '```'].join('\n');
ok(parseScenePlan(sceneAssetReply, cueContent, validIds)[0].assetId === undefined, 'asset id ignored on a non-audio beat');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
