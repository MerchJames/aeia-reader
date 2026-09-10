#!/usr/bin/env python3
"""A stand-in for the writing model, so Aeia's endpoint can be driven offline.

Aeia's proxy sits between SillyTavern and a real backend: it takes the prompt
SillyTavern assembled, works on it, calls the model, works on the reply, and
answers with both versions. Testing that needs a model — but not a good one.
What it needs is one that is *there*, answers deterministically, and says out
loud what it was asked.

So this prints every prompt it receives. That is the point of it: the request
pipeline is the half of the feature nothing else can show you, and this is where
you can read what Aeia actually forwarded — which blocks it wove in, where it
put them, what it dropped.

    python3 scripts/mock_model.py --port 8000

Then set Aeia's writing backend to http://127.0.0.1:8000/v1 on its endpoint
screen. OpenAI-compatible: /v1/models and /v1/chat/completions, streaming or not.

The reply is deliberately slightly broken — an unclosed quotation mark — because
Aeia only sends a second swipe when its pipeline CHANGED something. A clean
reply proves the path works; a repairable one proves both halves of it do.
"""

import argparse
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPLY = (
    'She set the lamp down between them and did not let go of it. "You came back,'
    " she said, and the words went nowhere. Outside, the rain kept on at the "
    "shutters, patient as arithmetic."
)


def show_prompt(body: dict) -> None:
    """Print what Aeia forwarded, in the shape a person can read."""
    msgs = body.get("messages") or []
    print(f"\n{'=' * 72}\n[{time.strftime('%H:%M:%S')}] {len(msgs)} messages"
          f" · model={body.get('model')!r} · stream={bool(body.get('stream'))}"
          f" · n={body.get('n', 1)}")
    for i, m in enumerate(msgs):
        content = m.get("content")
        if isinstance(content, list):  # multimodal parts
            content = " ".join(p.get("text", "") for p in content if isinstance(p, dict))
        content = str(content or "")
        head = content if len(content) <= 300 else content[:300] + f"… (+{len(content) - 300})"
        print(f"  [{i}] {m.get('role', '?'):<9} {len(content):>6} chars  "
              f"{head.replace(chr(10), ' ⏎ ')}")
    sys.stdout.flush()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):  # the prompt dump is the log
        pass

    def _cors(self) -> None:
        """Aeia calls this from a web view, so the browser rules apply.

        The desktop app's page is served from `tauri://localhost`; a call to
        127.0.0.1 is cross-origin, and `Content-Type: application/json` plus an
        `Authorization` header makes it a preflighted one. Without these headers
        the fetch never leaves the browser and the app reports `Load failed` —
        which reads like the model is down when it was never asked.
        """
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _json(self, status: int, payload: dict) -> None:
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            self._json(200, {"object": "list", "data": [
                {"id": "mock-writer", "object": "model", "owned_by": "aeia-test"},
            ]})
        else:
            self._json(404, {"error": "no such route"})

    def do_POST(self):
        if not self.path.rstrip("/").endswith("/chat/completions"):
            self._json(404, {"error": "no such route"})
            return

        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        show_prompt(body)

        reply = self.server.reply_text
        if not body.get("stream"):
            self._json(200, {
                "id": "mock-1", "object": "chat.completion", "model": "mock-writer",
                "choices": [{
                    "index": 0, "finish_reason": "stop",
                    "message": {"role": "assistant", "content": reply},
                }],
            })
            return

        # Streamed a few words at a time, with a real pause between them — a
        # proxy that buffers instead of forwarding looks identical to one that
        # does not until the model is slow enough to tell them apart.
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        words = reply.split(" ")
        for i in range(0, len(words), 3):
            piece = " ".join(words[i:i + 3])
            if i:
                piece = " " + piece
            frame = {"id": "mock-1", "object": "chat.completion.chunk", "model": "mock-writer",
                     "choices": [{"index": 0, "delta": {"content": piece}}]}
            self.wfile.write(f"data: {json.dumps(frame)}\n\n".encode())
            self.wfile.flush()
            time.sleep(self.server.delay)

        done = {"id": "mock-1", "object": "chat.completion.chunk", "model": "mock-writer",
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
        self.wfile.write(f"data: {json.dumps(done)}\n\ndata: [DONE]\n\n".encode())
        self.wfile.flush()
        self.close_connection = True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--delay", type=float, default=0.05,
                    help="seconds between streamed chunks (default 0.05)")
    ap.add_argument("--reply", default=REPLY, help="what the model should say")
    args = ap.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.reply_text = args.reply
    server.delay = args.delay
    print(f"mock model on http://127.0.0.1:{args.port}/v1  (Ctrl-C to stop)")
    print("point Aeia's writing backend at that address\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
