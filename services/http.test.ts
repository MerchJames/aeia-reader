/**
 * Run: npx tsx src/services/http.test.ts
 *
 * The shared service layer. Three optional backends now normalize URLs, attach
 * auth and phrase errors through this one file instead of three near-copies.
 *
 * The bug class this guards: a base URL normalized one way by the feature and
 * another way by the status check gives you "the server is running but Aura
 * says it isn't", which is unfalsifiable from the UI. So the cases here are the
 * ones a person actually pastes — a trailing slash, an already-versioned URL, a
 * bare host — plus the one asymmetry that is deliberate and easy to "fix" by
 * mistake: health lives at the bare root, the API lives under /v1.
 */
import {
  apiRoot, authHeaders, bareRoot, getJsonOrNull, postForBlob, postJson, serviceError, stripEnd,
} from './http';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (a === b) pass++;
  else { fail++; console.error('✗', msg, `\n    got ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

/* ---- URL normalizing ---- */

eq(apiRoot('http://localhost:8880'), 'http://localhost:8880/v1', 'a bare host gains /v1');
eq(apiRoot('http://localhost:8880/'), 'http://localhost:8880/v1', 'a trailing slash is dropped first');
eq(apiRoot('http://localhost:8880///'), 'http://localhost:8880/v1', 'and so are several');
eq(apiRoot('  http://localhost:8880  '), 'http://localhost:8880/v1', 'surrounding whitespace is trimmed');
eq(apiRoot('http://localhost:8880/v1'), 'http://localhost:8880/v1', 'an existing /v1 is left alone');
eq(apiRoot('http://localhost:8880/v2'), 'http://localhost:8880/v2', 'any /vN counts as versioned');
eq(apiRoot('http://localhost:8880/v1/'), 'http://localhost:8880/v1', 'even with a trailing slash');

// The fallback exists so a service with a known default port works with the
// field left blank — which is how both audio services actually ship.
eq(apiRoot('', 'http://localhost:8899'), 'http://localhost:8899/v1', 'an empty base falls back');
eq(apiRoot('   ', 'http://localhost:8899'), 'http://localhost:8899/v1', 'so does a whitespace-only one');
eq(apiRoot('http://box:1234', 'http://localhost:8899'), 'http://box:1234/v1', 'a set base wins over the fallback');
eq(apiRoot(''), '', 'no base and no fallback is empty, not "/v1"');
eq(apiRoot(undefined as never), '', 'and undefined does not throw');

// THE asymmetry: /health is not under /v1. Collapsing these two would break the
// audio service's status check while leaving every other call working.
eq(bareRoot('http://localhost:8899/'), 'http://localhost:8899', 'bareRoot adds no version');
eq(bareRoot('http://localhost:8899/v1'), 'http://localhost:8899/v1', 'and does not strip one either');
ok(bareRoot('http://x:1') !== apiRoot('http://x:1'), 'bareRoot and apiRoot are deliberately different');

eq(stripEnd('http://a/b///'), 'http://a/b', 'stripEnd removes every trailing slash');
eq(stripEnd(''), '', 'and tolerates empty');

/* ---- auth ---- */

eq(JSON.stringify(authHeaders('sk-1')), '{"Authorization":"Bearer sk-1"}', 'a key becomes a bearer header');
eq(JSON.stringify(authHeaders('')), '{}', 'no key means NO header — not an empty bearer');

/* ---- errors a person can act on ---- */

const res = (status: number, body: string, statusText = '') =>
  ({ status, statusText, text: async () => body, ok: false }) as unknown as Response;

const e1 = await serviceError('Kokoro', res(503, 'model still loading'));
eq(e1.message, 'Kokoro 503: model still loading', 'the error names the service and quotes it');

const e2 = await serviceError('Audio', res(500, '<html>' + 'x'.repeat(9999) + '</html>'));
ok(e2.message.length < 240, 'a giant HTML error page is clamped, not pasted into the UI');
ok(e2.message.startsWith('Audio 500: '), 'and still says which service and what status');

const e3 = await serviceError('Image', res(404, '   ', 'Not Found'));
eq(e3.message, 'Image 404 Not Found', 'an empty body falls back to the status text');

/* ---- the fetch wrappers ---- */

const realFetch = globalThis.fetch;
let lastCall: { url: string; init: RequestInit } | null = null;
const stub = (impl: (url: string, init: RequestInit) => Response) => {
  globalThis.fetch = (async (url: never, init: never) => {
    lastCall = { url: String(url), init: (init ?? {}) as RequestInit };
    return impl(String(url), (init ?? {}) as RequestInit);
  }) as never;
};
const jsonRes = (status: number, body: unknown) => ({
  ok: status < 400, status, statusText: '',
  json: async () => body,
  text: async () => JSON.stringify(body),
  blob: async () => new Blob([JSON.stringify(body)]),
}) as unknown as Response;

stub(() => jsonRes(200, { asset: { id: 'a1' } }));
const posted = await postJson<{ asset: { id: string } }>('http://x/v1/gen', { prompt: 'rain' }, { apiKey: 'k' });
eq(posted.asset.id, 'a1', 'postJson returns the parsed body');
eq(lastCall!.init.method, 'POST', 'as a POST');
eq((lastCall!.init.headers as Record<string, string>)['Content-Type'], 'application/json', 'with a JSON content type');
eq((lastCall!.init.headers as Record<string, string>).Authorization, 'Bearer k', 'and the bearer token');
eq(lastCall!.init.body, '{"prompt":"rain"}', 'and the body serialized');

stub(() => jsonRes(500, { error: 'boom' }));
let threw = '';
try { await postJson('http://x/v1/gen', {}, { label: 'Audio' }); } catch (e) { threw = (e as Error).message; }
ok(threw.startsWith('Audio 500'), 'postJson throws a labelled error on failure');

stub(() => jsonRes(200, { ok: true }));
ok((await postForBlob('http://x/v1/speech', {}, { label: 'Kokoro' })) instanceof Blob,
  'postForBlob returns bytes');

// The read paths are optional enrichment: an unreachable server is a normal
// state, not an exception to be handled at every call site.
stub(() => jsonRes(200, { voices: ['af_heart'] }));
eq(JSON.stringify(await getJsonOrNull('http://x/v1/audio/voices')), '{"voices":["af_heart"]}',
  'getJsonOrNull returns the body when it can');
stub(() => jsonRes(404, {}));
eq(await getJsonOrNull('http://x/v1/nope'), null, 'and null on a bad status');
globalThis.fetch = (async () => { throw new TypeError('Failed to fetch'); }) as never;
eq(await getJsonOrNull('http://nothing-here/v1'), null, 'and null when the host does not exist');

globalThis.fetch = realFetch;

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
