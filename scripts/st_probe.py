#!/usr/bin/env python3
"""Talk to Aeia's endpoint the way SillyTavern does, and check what comes back.

Aeia can stand in for your model: SillyTavern's Custom endpoint points at Aeia,
Aeia works on the prompt, calls the real backend, works on the reply, and sends
back both versions so the original is a swipe. This is the other end of that —
it sends what SillyTavern sends and checks the answer against what SillyTavern
requires, so the feature can be exercised without SillyTavern in the room.

    # Aeia running, endpoint switched on, API key copied from its panel:
    python3 scripts/st_probe.py --token <key>
    python3 scripts/st_probe.py --token <key> --no-stream
    python3 scripts/st_probe.py --token <key> --n 1     # no swipe should come back

It finds the port itself, the way the extension does — Aeia moves between a
fixed handful of them and /aeia/ping is the one route that needs no key.

── What it checks, and why each one matters ─────────────────────────────────

* **Choice 0 arrives in pieces.** A proxy that collects the whole reply and
  then sends it is indistinguishable from a working one until you watch it:
  the reader would get a long pause and then a finished paragraph. More than
  one delta on choice 0 is the proof it is being forwarded, not buffered.
* **Choice 1 only when n > 1.** SillyTavern turns a second choice into a swipe
  ONLY if it asked for two. At n=1 it appends it to the message instead — so a
  second choice sent unasked would staple the unprocessed draft onto the end of
  every reply.
* **The two differ.** If they are identical the pipeline did nothing, and the
  swipe is a duplicate wasting a slot.
* **`[DONE]` last.** Without it SillyTavern's stream never closes.
"""

import argparse
import json
import socket
import sys
import time
import urllib.error
import urllib.request

PORTS = [8770, 8771, 8772, 8773, 8774, 8775]

PROMPT = [
    {"role": "system", "content": "You are Elara. Write her next reply in the third person."},
    {"role": "user", "content": "I set my hand flat on the table and waited."},
]


def find_port(explicit: int | None) -> int:
    """Ask each candidate port who it is, and stop at the one that says Aeia."""
    for port in ([explicit] if explicit else PORTS):
        try:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{port}/aeia/ping", timeout=1.5,
            ) as r:
                who = json.loads(r.read())
            if who.get("app") == "aeia":
                print(f"· found Aeia on port {port} (v{who.get('version')})")
                return port
        except (urllib.error.URLError, socket.timeout, json.JSONDecodeError, OSError):
            continue
    raise SystemExit(
        "no Aeia listening on " + ", ".join(map(str, [explicit] if explicit else PORTS))
        + "\n  Is the desktop app running with its endpoint switched on?"
    )


def post(port: int, token: str, body: dict, timeout: float):
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    return urllib.request.urlopen(req, timeout=timeout)


def run_stream(port: int, token: str, n: int, timeout: float) -> int:
    started = time.time()
    body = {"model": "aeia", "messages": PROMPT, "stream": True, "n": n}
    print(f"→ POST /v1/chat/completions  stream=True n={n}")

    texts: dict[int, str] = {}
    deltas: dict[int, int] = {}
    order: list[int] = []
    finished: set[int] = set()
    saw_done = False
    first_byte = None

    with post(port, token, body, timeout) as r:
        ctype = r.headers.get("Content-Type", "")
        if "text/event-stream" not in ctype:
            print(f"✗ answered {ctype!r}, not an SSE stream")
            return 1
        for raw in r:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                saw_done = True
                continue
            if first_byte is None:
                first_byte = time.time() - started
            event = json.loads(payload)
            for choice in event.get("choices", []):
                i = choice.get("index", 0)
                if i not in order:
                    order.append(i)
                piece = (choice.get("delta") or {}).get("content") or ""
                if piece:
                    texts[i] = texts.get(i, "") + piece
                    deltas[i] = deltas.get(i, 0) + 1
                if choice.get("finish_reason"):
                    finished.add(i)

    elapsed = time.time() - started
    print(f"← {elapsed:.1f}s total, first token at {first_byte:.1f}s"
          if first_byte else f"← {elapsed:.1f}s, no tokens")
    for i in order:
        label = "reply" if i == 0 else f"swipe {i + 1}"
        print(f"\n  choice {i} ({label}) — {deltas.get(i, 0)} deltas, "
              f"{len(texts.get(i, ''))} chars, finish={'yes' if i in finished else 'NO'}")
        print("   " + (texts.get(i, "") or "<empty>").replace("\n", "\n   "))

    bad = []
    if 0 not in texts:
        bad.append("nothing came back on choice 0 — SillyTavern would show an empty message")
    if deltas.get(0, 0) < 2:
        bad.append(
            f"choice 0 arrived in {deltas.get(0, 0)} piece(s) — the reply is being buffered, "
            "not forwarded; the reader would watch a pause and then a finished paragraph"
        )
    if not saw_done:
        bad.append("no [DONE] — SillyTavern's stream never closes")
    if 0 not in finished:
        bad.append("choice 0 never got a finish_reason")
    if n == 1 and 1 in texts:
        bad.append(
            "a second choice came back at n=1 — SillyTavern does not make that a swipe, "
            "it appends it to the message"
        )
    if n > 1 and 1 in texts and texts[1] == texts.get(0):
        bad.append("both choices are identical — the swipe is a duplicate")
    if n > 1 and 1 not in texts:
        print("\n  note: no second choice. That is correct IF the reply pipeline changed "
              "nothing — Aeia only sends the original when it differs.")

    return report(bad)


def run_plain(port: int, token: str, n: int, timeout: float) -> int:
    started = time.time()
    body = {"model": "aeia", "messages": PROMPT, "stream": False, "n": n}
    print(f"→ POST /v1/chat/completions  stream=False n={n}")
    with post(port, token, body, timeout) as r:
        answer = json.loads(r.read())
    print(f"← {time.time() - started:.1f}s")

    choices = answer.get("choices") or []
    for c in choices:
        text = (c.get("message") or {}).get("content") or ""
        print(f"\n  choice {c.get('index')} — {len(text)} chars\n   "
              + text.replace("\n", "\n   "))

    bad = []
    if not choices:
        bad.append("no choices at all")
    elif not (choices[0].get("message") or {}).get("content"):
        bad.append("choice 0 has no content")
    if n == 1 and len(choices) > 1:
        bad.append("a second choice at n=1 — it would be appended to the message, not swiped")
    if len(choices) > 1 and (choices[0].get("message") or {}).get("content") == \
            (choices[1].get("message") or {}).get("content"):
        bad.append("both choices are identical")
    return report(bad)


def report(bad: list[str]) -> int:
    print()
    if bad:
        for b in bad:
            print(f"✗ {b}")
        return 1
    print("✓ the answer is the shape SillyTavern needs")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--token", required=True, help="the API key from Aeia's endpoint panel")
    ap.add_argument("--port", type=int, help="skip the port probe")
    ap.add_argument("--n", type=int, default=2, help="responses to ask for (2 = swipes)")
    ap.add_argument("--no-stream", action="store_true")
    ap.add_argument("--timeout", type=float, default=180.0)
    args = ap.parse_args()

    port = find_port(args.port)
    try:
        if args.no_stream:
            return run_plain(port, args.token, args.n, args.timeout)
        return run_stream(port, args.token, args.n, args.timeout)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:400]
        print(f"✗ HTTP {e.code}: {detail}")
        if e.code == 401:
            print("  The key is the one on Aeia's endpoint panel, not your model's key.")
        return 1
    except (urllib.error.URLError, socket.timeout) as e:
        print(f"✗ {e}")
        print("  Aeia answered the ping but not the completion — is a story open,")
        print("  and is the writing backend set on the endpoint screen?")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
