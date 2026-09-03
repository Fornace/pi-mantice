#!/usr/bin/env python3
"""End-to-end proof for pi-mantice compaction.

Throwaway local gateway + in-repo mock OpenAI provider + real Pi RPC session:
1. seed routing (mock-max/fast/flash classes with aliases) via the admin API
2. issue a user token through the new Users CRUD API
3. start pi --mode rpc with pi-mantice installed by path
4. prompt (must hit mock-max), send /compact (must hit mock-flash), assert
   compaction_end summary text and recorded usage, and that the session model
   is never used for summarization.

Usage: MANTICE_BIN=.../target/debug/mantice MANTICE_SEED_DB=.../gateway.db \
       python3 tools/e2e-compact.py
Prints PASS/RESULT JSON and exits 0 on success.
"""
import http.server
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import uuid

GW_PORT = 18090
MOCK_PORT = 18091
GW = f"http://127.0.0.1:{GW_PORT}"
ADMIN = "e2e-admin-token"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CALLS = []
FAILURES = []


class MockHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, payload):
        data = payload.encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        model = body.get("model")
        CALLS.append({"phase": "any", "model": model})
        if body.get("stream"):
            self._send_sse(model)
        else:
            self._send(json.dumps({
                "id": "c1", "object": "chat.completion", "created": 1, "model": model,
                "choices": [{"index": 0, "message": {"role": "assistant",
                             "content": f"[mock] summary from {model}"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 40, "completion_tokens": 8, "total_tokens": 48},
            }))

    def _send_sse(self, model):
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        chunks = [
            {"id": "c1", "object": "chat.completion.chunk", "created": 1, "model": model,
             "choices": [{"index": 0, "delta": {"role": "assistant", "content": f"[mock] summary from {model}"}}]},
            {"id": "c1", "object": "chat.completion.chunk", "created": 1, "model": model,
             "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
             "usage": {"prompt_tokens": 40, "completion_tokens": 8, "total_tokens": 48}},
        ]
        for chunk in chunks:
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")

    def do_GET(self):
        if self.path.endswith("/models"):
            self._send(200, json.dumps({"object": "list", "data": [
                {"id": f"mock-{x}", "object": "model", "created": 0} for x in ("max", "fast", "flash")]}))
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *args):
        pass


def api(path, payload=None, method=None, headers=None, token=None):
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(GW + path, data=data, method=method or ("POST" if data else "GET"))
    request.add_header("authorization", f"Bearer {token or ADMIN}")
    request.add_header("content-type", "application/json")
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read() or b"null")


def main():
    gateway_bin = os.environ["MANTICE_BIN"]
    seed_db = os.environ["MANTICE_SEED_DB"]
    tmp = tempfile.mkdtemp(prefix="pi-mantice-e2e-")
    db = os.path.join(tmp, "e2e.db")
    shutil.copyfile(seed_db, db)

    mock = http.server.ThreadingHTTPServer(("127.0.0.1", MOCK_PORT), MockHandler)
    threading.Thread(target=mock.serve_forever, daemon=True).start()

    env = {**os.environ, "DATABASE_PATH": db, "BIND_ADDR": f"127.0.0.1:{GW_PORT}",
           "ADMIN_USERNAME": "admin", "ADMIN_TOKEN": ADMIN, "MOCK_KEY": "mock-secret",
           "ALLOW_ANONYMOUS": "false"}
    env.pop("MANTICE_API_KEY", None)
    env.pop("MANTICE_BASE_URL", None)
    log = open(os.path.join(tmp, "gw.log"), "w")
    gateway = subprocess.Popen([gateway_bin], env=env, stdout=log, stderr=subprocess.STDOUT)

    try:
        for _ in range(200):
            try:
                if urllib.request.urlopen(f"{GW}/healthz", timeout=2).status == 200:
                    break
            except Exception:
                time.sleep(0.05)
        else:
            raise RuntimeError("gateway never healthy")

        revision = api("/admin/routing")["revision"]
        card = {"model_card": {"limits": {"max_input_tokens": 1_000_000, "max_output_tokens": 131_072}}}

        def dep(i, group, model):
            return {"id": i, "provider_id": "mock", "model_group": group, "upstream_model": model,
                    "priority": 0, "weight": 1, "enabled": True, "input_cost_per_token": 0,
                    "output_cost_per_token": 0, "params": card}

        api("/admin/routing/reset", {
            "providers": [{"id": "mock", "name": "Mock upstream", "kind": "openai",
                           "protocol": "openai", "base_url": f"http://127.0.0.1:{MOCK_PORT}/v1",
                           "auth_kind": "bearer", "credential": {"api_key_env": "MOCK_KEY"},
                           "adapters": {}, "timeout_ms": 5000, "enabled": True}],
            "deployments": [dep("dep-e2e-max", "fornace-max", "mock-max"),
                            dep("dep-e2e-fast", "fornace-fast", "mock-fast"),
                            dep("dep-e2e-flash", "fornace-flash", "mock-flash")],
            "model_groups": [{"name": n, "mode": "chat", "enabled": True, "public": True,
                              "auto_optimize": False}
                             for n in ("fornace-max", "fornace-fast", "fornace-flash")],
            "aliases": {"max": "fornace-max", "fast": "fornace-fast", "flash": "fornace-flash"},
            "fallbacks": {"fornace-max": ["fornace-fast"], "fornace-fast": ["fornace-flash"],
                          "fornace-flash": []},
            "if_revision": revision,
        })
        api("/admin/users", {"id": "e2e-compact", "name": "E2E Compact"})
        token = api("/admin/tokens",
                    {"user_id": "e2e-compact", "label": "e2e",
                     "allowed_models": ["max", "fornace-max", "fast", "fornace-fast",
                                        "flash", "fornace-flash"]},
                    headers={"idempotency-key": f"e2e-{uuid.uuid4()}"})["token"]

        agent_dir = os.path.join(tmp, "pi-agent")
        os.makedirs(agent_dir)
        with open(os.path.join(agent_dir, "settings.json"), "w") as handle:
            json.dump({"packages": [REPO], "defaultProvider": "mantice", "defaultModel": "max",
                       "quietStartup": True,
                       "compaction": {"enabled": True, "reserveTokens": 1, "keepRecentTokens": 1}},
                      handle)

        events = []
        done = threading.Event()
        pi_env = {**os.environ, "PI_CODING_AGENT_DIR": agent_dir,
                  "MANTICE_BASE_URL": f"{GW}/v1", "MANTICE_API_KEY": token, "PI_OFFLINE": "1"}
        pi_env.pop("MANTICE_MODEL", None)
        pi_proc = subprocess.Popen(["pi", "--mode", "rpc", "--no-session"], env=pi_env,
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, bufsize=1)

        def reader():
            for line in pi_proc.stdout:
                line = line.strip()
                if not line:
                    continue
                events.append(json.loads(line))
            done.set()

        threading.Thread(target=reader, daemon=True).start()

        def wait_for(check, timeout, label):
            deadline = time.time() + timeout
            while time.time() < deadline:
                for event in events:
                    if check(event):
                        return event
                if pi_proc.poll() is not None:
                    raise RuntimeError(f"pi exited ({pi_proc.returncode}) before {label}; stderr: "
                                       + (pi_proc.stderr.read() or "")[-500:])
                time.sleep(0.1)
            raise RuntimeError(f"timeout waiting for {label}")

        def send(command):
            pi_proc.stdin.write(json.dumps(command) + "\n")
            pi_proc.stdin.flush()

        send({"type": "prompt", "message": "say hi"})
        wait_for(lambda e: e.get("type") == "agent_end", 60, "agent_end after prompt")
        prompt_models = [call["model"] for call in CALLS if call["model"] == "mock-max"]
        if not prompt_models:
            raise RuntimeError(f"prompt never reached mock-max: {CALLS}")

        CALLS.clear()
        send({"type": "compact"})
        end = wait_for(lambda e: e.get("type") == "compaction_end", 60, "compaction_end")
        compact_models = [call["model"] for call in CALLS]
        summary = (end.get("result") or {}).get("summary", "")
        usage = (end.get("result") or {}).get("usage") or {}
        if "mock-flash" not in compact_models:
            raise RuntimeError(f"compaction did not use flash class: {compact_models}")
        if "mock-max" in compact_models:
            raise RuntimeError(f"compaction spent the session model: {compact_models}")
        if "mock-flash" not in summary:
            raise RuntimeError(f"summary text missing flash marker: {summary[:120]}")
        if usage.get("output") != 8:
            raise RuntimeError(f"compaction usage not recorded: {usage}")
        print(json.dumps({"result": end["result"], "compactCalls": compact_models}, indent=2))
        print("PASS: manual compaction summarized via flash class with usage recorded")
    finally:
        for proc in (locals().get("pi_proc"), gateway):
            if proc and proc.poll() is None:
                proc.send_signal(signal.SIGKILL)
        mock.shutdown()
        with open(os.path.join(tmp, "gw.log")) as handle:
            if FAILURES or "-v" in sys.argv:
                print(handle.read()[-2000:], file=sys.stderr)
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001
        FAILURES.append(str(error))
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(1)
