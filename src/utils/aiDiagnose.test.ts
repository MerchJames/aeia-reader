/**
 * Tests for endpoint failure diagnosis.
 *
 * The point of this module is that `Failed to fetch` — which is what a browser
 * reports for a server that is down, a port typed wrong, and a server that is
 * running fine but refusing cross-origin requests — must not be shown to a
 * reader as `Failed to fetch`. So the tests are mostly about which advice
 * appears first, because that is the entire value: the CORS explanation for a
 * local address, the typo explanation for a remote one.
 *
 * Run: npx tsx src/utils/aiDiagnose.test.ts
 */

import { describeSuccess, diagnose } from './aiDiagnose';

let passed = 0;
let failed = 0;

const eq = (got: unknown, want: unknown, what: string) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) { passed++; return; }
  failed++;
  console.error(`✗ ${what}\n    got  ${a}\n    want ${b}`);
};
const ok = (cond: boolean, what: string) => eq(!!cond, true, what);

const LOCAL = 'http://localhost:1234';
const REMOTE = 'https://api.openai.com';
const err = (m: string) => new Error(m);

/* ------------------------------------------------------------------ */
/* The one that cannot be distinguished, and must still help           */
/* ------------------------------------------------------------------ */

{
  const d = diagnose(err('TypeError: Failed to fetch'), LOCAL, 'llama-3');
  eq(d.kind, 'unreachable', 'a fetch failure is unreachable');
  ok(d.fixes.length > 0, 'and always comes with something to try');
  ok(/CORS/i.test(d.fixes[0]),
    'on a LOCAL address the CORS fix is offered FIRST — it is the most common '
    + 'cause and the least guessable');
  ok(d.fixes.some(f => /LM Studio/i.test(f)), 'naming the actual servers people use');
  ok(d.fixes.some(f => /OLLAMA_ORIGINS/.test(f)), 'including the exact Ollama setting');
  ok(d.title.includes('refusing this page'),
    'and the title admits the server may be running perfectly');
}

{
  const d = diagnose(err('TypeError: Failed to fetch'), REMOTE, 'gpt-4o');
  eq(d.kind, 'unreachable', 'the same error remotely is still unreachable');
  ok(!/CORS/i.test(d.fixes[0]),
    'but a REMOTE address does not lead with CORS — that is not what goes wrong there');
  ok(/typo/i.test(d.fixes[0]), 'it leads with the typo, which is');
  ok(!d.title.includes('refusing this page'), 'and does not speculate about a local server');
}

{
  // Every spelling of "no answer" the runtimes actually produce.
  for (const message of [
    'Failed to fetch', 'NetworkError when attempting to fetch resource',
    'Load failed', 'Could not reach the endpoint.', 'fetch failed',
    'connect ECONNREFUSED 127.0.0.1:1234', 'net::ERR_CONNECTION_REFUSED',
  ]) {
    eq(diagnose(err(message), LOCAL, 'm').kind, 'unreachable',
      `"${message}" is recognised as no-answer`);
  }
}

{
  // Local addresses are not only "localhost".
  for (const base of [
    'http://localhost:5001', 'http://127.0.0.1:8080', 'http://0.0.0.0:11434',
    'http://192.168.1.50:1234', 'http://10.0.0.4:5000', 'http://172.16.5.5:1234',
    'HTTP://LocalHost:1234/',
  ]) {
    ok(/CORS/i.test(diagnose(err('Failed to fetch'), base, 'm').fixes[0]),
      `${base} is treated as local`);
  }
  for (const base of ['https://api.openai.com', 'https://openrouter.ai', 'http://example.com']) {
    ok(!/CORS/i.test(diagnose(err('Failed to fetch'), base, 'm').fixes[0]),
      `${base} is treated as remote`);
  }
  // 172.32 is outside the private range; a public address that merely looks like one.
  ok(!/CORS/i.test(diagnose(err('Failed to fetch'), 'http://172.32.0.1:80', 'm').fixes[0]),
    '172.32 is outside the private block and is not treated as local');
}

/* ------------------------------------------------------------------ */
/* The ones the server actually told us                                */
/* ------------------------------------------------------------------ */

{
  const d = diagnose(err('401 Unauthorized'), REMOTE, 'gpt-4o');
  eq(d.kind, 'auth', 'a 401 is an auth problem');
  ok(d.fixes.some(f => /key/i.test(f)), 'and talks about the key');

  const localAuth = diagnose(err('Incorrect API key provided'), LOCAL, 'm');
  ok(/clearing it/i.test(localAuth.fixes[0]),
    'against a LOCAL server the first advice is to CLEAR the key — local servers '
    + 'usually ignore it, and a pasted key is the likelier mistake');
}

{
  const d = diagnose(err('404 Not Found'), LOCAL, 'm');
  eq(d.kind, 'route', 'a 404 is a routing problem, not an unreachable one');
  ok(d.fixes.some(f => /\/v1/.test(f)),
    'and says not to include /v1 — the single most common base-URL mistake');
  ok(d.fixes[0].includes('localhost:1234'), 'with a local example for a local address');
  ok(diagnose(err('404'), REMOTE, 'm').fixes[0].includes('https://'),
    'and a remote example for a remote one');
}

{
  for (const message of [
    'model not found', 'No such model: llama', 'The model `x` does not exist',
    'model_not_found', 'Unknown model',
  ]) {
    eq(diagnose(err(message), LOCAL, 'llama-3').kind, 'model',
      `"${message}" is a model problem`);
  }
  ok(diagnose(err('model not found'), LOCAL, 'llama-3').title.includes('llama-3'),
    'and the message names the model that was actually asked for');
  ok(diagnose(err('model not found'), LOCAL, '').title.includes('No model was chosen'),
    'or says none was chosen, when none was');
}

{
  eq(diagnose(err('429 Too Many Requests'), REMOTE, 'm').kind, 'server', 'a 429 is a server problem');
  eq(diagnose(err('insufficient_quota'), REMOTE, 'm').kind, 'server', 'so is a quota failure');
  eq(diagnose(err('500 Internal Server Error'), LOCAL, 'm').kind, 'server', 'and a 500');
  ok(diagnose(err('503'), LOCAL, 'm').fixes.some(f => /loading|warming/i.test(f)),
    'a 503 mentions that a local model may still be loading, which is usually what it is');
}

{
  const d = diagnose(err('Unexpected token < in JSON at position 0'), LOCAL, 'm');
  eq(d.kind, 'shape', 'HTML where JSON was expected is a shape problem');
  ok(d.fixes.some(f => /proxy|login/i.test(f)),
    'and names the usual culprit rather than blaming the model');
}

/* ------------------------------------------------------------------ */
/* Never unhelpful, never throwing                                     */
/* ------------------------------------------------------------------ */

{
  const junk = [null, undefined, '', 0, {}, [], new Error(''), 'a bare string', NaN];
  let threw = false;
  for (const j of junk) {
    try {
      const d = diagnose(j, LOCAL, 'm');
      ok(!!d.title, `junk still produces a title: ${JSON.stringify(j)}`);
      ok(Array.isArray(d.fixes), 'and a fixes array');
    } catch { threw = true; }
  }
  ok(!threw, 'no input makes diagnose throw');
}

{
  const d = diagnose(err('something nobody has ever seen'), LOCAL, 'm');
  eq(d.kind, 'unknown', 'an unrecognised error is unknown');
  ok(d.fixes.length > 0, 'but still suggests something rather than shrugging');
  eq(d.raw, 'something nobody has ever seen',
    'and the exact original is kept, so a support conversation has a fact in it');
}

{
  // A cancelled test is not a failure and must not be dressed as one.
  const d = diagnose(err('The operation was aborted'), LOCAL, 'm');
  ok(/cancelled/i.test(d.title), 'an abort reads as a cancellation');
  eq(d.fixes, [], 'and offers no fixes, because nothing is broken');
}

{
  // The raw message always survives, whatever branch was taken.
  for (const message of ['401', '404', 'Failed to fetch', 'model not found', '500']) {
    eq(diagnose(err(message), LOCAL, 'm').raw, message,
      `the raw error survives the "${message}" branch`);
  }
}

/* ------------------------------------------------------------------ */
/* Success                                                             */
/* ------------------------------------------------------------------ */

{
  const s = describeSuccess('llama-3.1-8b', 'Hello.', 400);
  ok(s.includes('llama-3.1-8b'), 'success names the model');
  ok(s.includes('Ready to use'), 'and says it is ready');
  ok(!s.includes('0.4s'), 'a fast reply does not bother reporting its speed');

  ok(describeSuccess('m', 'Hi', 3400).includes('3.4s'),
    'a slow one does — that is worth knowing before relying on it');

  const empty = describeSuccess('m', '   ', 300);
  ok(empty.includes('replied with nothing'),
    'an empty reply is reported as a problem, not as success');
  ok(!empty.includes('Ready to use'), 'and is not called ready');

  ok(describeSuccess('', 'Hi', 300).includes('The endpoint answered'),
    'with no model name it still reads as a sentence');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
