#!/usr/bin/env python3
"""
Minimal OpenAI-compatible server that ACTUALLY loads a LoRA adapter.

  python3 serve_local.py --adapter adapters --port 8080
  python3 serve_local.py --adapter adapters-archive/<snapshot> --port 8080
  python3 serve_local.py --base-only --port 8080          # untuned, for A/B

Why this exists instead of mlx_lm.server: when a request carries a `model` field,
mlx_lm.server loads that repo id fresh and SILENTLY IGNORES --adapter-path, so you
serve the base model while believing you serve your fine-tune. That produced four
rounds of invalid scorecards on 2026-08-23. This server loads weights + adapter
once at startup and ignores the request's `model` field entirely, so there is
nothing to get wrong.

Serves POST /v1/chat/completions with the subset chittu-v3's provider router uses
(messages, max_tokens, temperature). Single-threaded on purpose: MLX generation is
not reentrant and one browser tab is the only client.
"""
import argparse, json, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE = {"model": None, "tok": None, "name": "", "lock": threading.Lock()}


def generate_reply(messages, max_tokens, temperature):
    from mlx_lm import generate
    from mlx_lm.sample_utils import make_sampler
    tok = STATE["tok"]
    prompt = tok.apply_chat_template(messages, add_generation_prompt=True)
    with STATE["lock"]:                      # MLX generation is not reentrant
        out = generate(STATE["model"], tok, prompt=prompt, max_tokens=max_tokens,
                       sampler=make_sampler(temp=temperature), verbose=False) or ""
    return out


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # the prototype is loaded over file://, so its requests are cross-origin
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):                    # CORS preflight from the browser
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            self._send(200, {"object": "list",
                             "data": [{"id": STATE["name"], "object": "model"}]})
        else:
            self._send(200, {"status": "ok", "model": STATE["name"]})

    def do_POST(self):
        if "chat/completions" not in self.path:
            return self._send(404, {"error": "only /v1/chat/completions"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
            msgs = [{"role": m.get("role", "user"), "content": m.get("content", "")}
                    for m in req.get("messages", [])]
            text = generate_reply(msgs,
                                  int(req.get("max_tokens", 400)),
                                  float(req.get("temperature", 0.7)))
            self._send(200, {
                "id": "chatcmpl-local", "object": "chat.completion",
                "model": STATE["name"],
                "choices": [{"index": 0, "finish_reason": "stop",
                             "message": {"role": "assistant", "content": text}}],
            })
        except Exception as e:                # never take the server down on one bad turn
            self._send(500, {"error": str(e)})

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter", default="adapters")
    ap.add_argument("--base-only", action="store_true")
    ap.add_argument("--base", default="mlx-community/Qwen3-4B-Instruct-2507-4bit")
    ap.add_argument("--port", type=int, default=8080)
    a = ap.parse_args()

    from mlx_lm import load
    adapter = None if a.base_only else a.adapter
    print(f"loading {a.base}  adapter={adapter!r}", file=sys.stderr)
    STATE["model"], STATE["tok"] = load(a.base, adapter_path=adapter)
    STATE["name"] = a.base + ("" if adapter is None else f"+{adapter}")
    print(f"READY on http://localhost:{a.port}/v1  ({STATE['name']})", file=sys.stderr)
    ThreadingHTTPServer(("127.0.0.1", a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
