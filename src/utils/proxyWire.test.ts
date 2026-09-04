/**
 * Run: npx tsx src/utils/proxyWire.test.ts
 *
 * Aeia between SillyTavern and the model, at the level of what goes on the wire.
 *
 * Two properties are load-bearing, and everything else here is detail:
 *
 * **A second choice is only ever sent when SillyTavern asked for two.** Its
 * streaming reader routes events by `choices[0].index` — but only when it
 * requested more than one response. If it did not, an event with index 1 is not
 * a swipe: it is appended to the message. Getting this wrong does not fail
 * loudly, it silently glues the original onto the end of every reply.
 *
 * **Nothing the reader configured is dropped.** The request is passed through
 * with its sampler settings intact, including fields this code has never heard
 * of. A proxy that forwarded only what it recognised would quietly undo half of
 * somebody's preset.
 */
import {
  canSwipe, completionBody, deltaEvent, finishEvent, readDelta, readRequest,
  takeEvents, upstreamBody,
} from './proxyWire';

let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error('✗', msg); } };
const eq = (a: unknown, b: unknown, msg: string) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.error('✗', msg, `\n    got  ${JSON.stringify(a)}\n    want ${JSON.stringify(b)}`); }
};

const REQUEST = {
  model: 'my-model',
  messages: [{ role: 'user', content: 'Hello.' }],
  stream: true,
  n: 2,
  temperature: 0.9,
  // A field invented for this test, standing in for every sampler setting a
  // backend might have that this code has never heard of.
  min_p: 0.05,
};

/* ── Reading what SillyTavern sent ───────────────────────────────────────── */
{
  const req = readRequest(JSON.stringify(REQUEST));
  eq(req?.model, 'my-model', 'the model is read');
  eq(req?.stream, true, 'and whether it wants a stream');
  eq(req?.n, 2, 'and how many responses it asked for');
  eq(req?.messages.length, 1, 'and the prompt itself');
  eq(req?.rest.temperature, 0.9, 'everything else is kept aside, not discarded');
  eq(req?.rest.min_p, 0.05, 'including settings this code has never heard of');
  ok(!('messages' in (req?.rest ?? {})), 'and the parts we handle are not in it twice');

  eq(readRequest('{"messages":[]}')?.n, 1, 'no n means one — absent is not zero');
  eq(readRequest('{"messages":[],"n":"2"}')?.n, 1, 'and a string is not a count');
  eq(readRequest('{"messages":[]}')?.stream, false, 'streaming is opt-in, as in the API');

  eq(readRequest('not json'), null, 'nonsense is not a request');
  eq(readRequest('[]'), null, 'nor is an array');
  eq(readRequest('{"model":"m"}'), null, 'and a body with no messages is not a completion');
}

/* ── The trap: when a second choice is allowed ───────────────────────────── */
{
  ok(canSwipe({ n: 2 }), 'two asked for, so a second choice is read as a swipe');
  ok(canSwipe({ n: 4 }), 'more than two, likewise');
  ok(!canSwipe({ n: 1 }),
    'ONE asked for — a second choice would be appended to the message, not swiped');
  ok(!canSwipe({ n: 0 }), 'and a nonsense count is not permission');
}

/* ── What goes upstream ──────────────────────────────────────────────────── */
{
  const req = readRequest(JSON.stringify(REQUEST))!;
  const sent = JSON.parse(upstreamBody(req, req.messages));
  eq(sent.temperature, 0.9, 'the reader’s settings travel to the model');
  eq(sent.min_p, 0.05, 'all of them');
  eq(sent.stream, true, 'and the streaming choice is honoured upstream too');
  // We are not asking the model for two takes — we make the second one.
  // Forwarding n=2 would pay for a generation nobody ever reads.
  eq(sent.n, 1, 'but only ONE generation is ever asked for');
  eq(sent.model, 'my-model', 'the model SillyTavern named is used by default');

  eq(JSON.parse(upstreamBody(req, req.messages, 'other-model')).model, 'other-model',
    'unless Aeia has been told to write with a different one');

  const changed = [{ role: 'system', content: 'shaped' }, ...req.messages];
  eq(JSON.parse(upstreamBody(req, changed)).messages.length, 2,
    'and the prompt sent is the one the pipeline produced, not the one that arrived');
}

/* ── Answering: the streamed shape ───────────────────────────────────────── */
{
  const event = JSON.parse(deltaEvent('She set the lamp down.', 0, 'm', 'fixed-id'));
  eq(event.choices[0].index, 0, 'the message is choice 0');
  eq(event.choices[0].delta.content, 'She set the lamp down.', 'carrying the text');
  eq(event.object, 'chat.completion.chunk', 'shaped as the client expects');

  const swipe = JSON.parse(deltaEvent('The original.', 1, 'm', 'fixed-id'));
  eq(swipe.choices[0].index, 1, 'and the original is choice 1, which becomes swipe 2');
  ok(Array.isArray(swipe.choices) && swipe.choices.length === 1,
    'one choice per event — SillyTavern reads choices[0] and ignores any others');

  const done = JSON.parse(finishEvent(0, 'm', 'fixed-id'));
  eq(done.choices[0].finish_reason, 'stop', 'each choice ends with a reason');
  eq(done.choices[0].delta.content, undefined, 'and no text');
}

/* ── Answering: the whole-body shape ─────────────────────────────────────── */
{
  const body = JSON.parse(completionBody(['processed', 'original'], 'm', 'fixed-id'));
  eq(body.choices.length, 2, 'both versions travel in one body');
  eq(body.choices[0].message.content, 'processed', 'the processed one first, as the message');
  eq(body.choices[1].index, 1, 'the original second, as the swipe');
  eq(body.object, 'chat.completion', 'and it is a completion, not a chunk');

  eq(JSON.parse(completionBody(['only'], 'm')).choices.length, 1,
    'one version when there is only one');
}

/* ── Reading the backend ─────────────────────────────────────────────────── */
{
  eq(readDelta('{"choices":[{"delta":{"content":"a"}}]}'), 'a', 'the streaming shape');
  eq(readDelta('{"choices":[{"message":{"content":"b"}}]}'), 'b', 'the whole-response shape');
  eq(readDelta('{"choices":[{"text":"c"}]}'), 'c', 'and the older text shape');

  // None of these may throw: one unrecognised keep-alive must not end a reply.
  eq(readDelta('[DONE]'), '', 'the end marker carries no text');
  eq(readDelta('{"choices":[]}'), '', 'an empty choice list is not an error');
  eq(readDelta('{"choices":[{"delta":{}}]}'), '', 'nor is a delta with no content');
  eq(readDelta('garbage'), '', 'nor is a line we cannot read at all');
  eq(readDelta(''), '', 'nor is nothing');
  eq(readDelta('{"choices":[{"delta":{"content":42}}]}'), '',
    'and a non-string content is not text');
}

/* ── Splitting the stream ────────────────────────────────────────────────── */
{
  const { events, rest } = takeEvents('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c"');
  eq(events, ['{"a":1}', '{"b":2}'], 'complete events are taken');
  // The half-event is the whole point: a socket chunk ends mid-event all the
  // time, and a parser that dropped the remainder would lose a token every few
  // hundred — corruption nobody notices until it is in a saved story.
  eq(rest, 'data: {"c"', 'and the half-finished one is kept for the next chunk');

  eq(takeEvents('data: {"a":1}\r\n\r\n').events, ['{"a":1}'], 'CRLF servers are read too');
  eq(takeEvents(': keep-alive\n\ndata: {"a":1}\n\n').events, ['{"a":1}'],
    'comment lines are not events');
  eq(takeEvents('data: [DONE]\n\n').events, ['[DONE]'], 'the end marker is passed through');
  eq(takeEvents('').events, [], 'nothing in, nothing out');
  eq(takeEvents('data: no terminator yet').events, [], 'and an unfinished event waits');

  // A payload split across `data:` lines, which the SSE spec allows.
  eq(takeEvents('data: {"a":\ndata: 1}\n\n').events, ['{"a":1}'], 'multi-line payloads rejoin');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
