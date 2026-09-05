#!/usr/bin/env python3
"""Real Pi -> real Mantice -> mock providers; all state and credentials disposable."""
import hashlib
import http.server
import json
import os
from pathlib import Path
import queue
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
import urllib.request

REPO = Path(__file__).resolve().parents[1]
TOKEN = "pi-recovery-fixture-token"
IMAGE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
MESSAGE = "synthetic full triggering message"
CALLS = []


class Upstream(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        CALLS.append(body)
        if body["model"] == "reject-image":
            data = json.dumps({"error": {"code": "modality_not_supported",
                                       "message": "This model does not support image input."}}).encode()
            self.send_response(400)
            self.send_header("content-type", "application/json")
        else:
            events = [
                {"id": "fixture", "object": "chat.completion.chunk", "model": body["model"],
                 "choices": [{"index": 0, "delta": {"role": "assistant", "content": "fixture OK"},
                              "finish_reason": None}]},
                {"id": "fixture", "object": "chat.completion.chunk", "model": body["model"],
                 "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
            ]
            data = ("".join(f"data: {json.dumps(event)}\n\n" for event in events)
                    + "data: [DONE]\n\n").encode()
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


def seed(path, port):
    with sqlite3.connect(path) as db:
        db.executescript("""
          CREATE TABLE routing_provider_accounts(id TEXT PRIMARY KEY,json TEXT NOT NULL);
          CREATE TABLE routing_deployments(id TEXT PRIMARY KEY,json TEXT NOT NULL);
          CREATE TABLE routing_model_groups(name TEXT PRIMARY KEY,json TEXT NOT NULL);
          CREATE TABLE routing_aliases(alias TEXT PRIMARY KEY,target TEXT NOT NULL);
          CREATE TABLE routing_fallbacks(source TEXT NOT NULL,position INTEGER NOT NULL,target TEXT NOT NULL,PRIMARY KEY(source,position));
        """)
        provider = {"id": "fixture", "name": "Fixture", "kind": "openai", "protocol": "openai",
                    "base_url": f"http://127.0.0.1:{port}/v1", "auth_kind": "none",
                    "credential": {}, "timeout_ms": 3000, "enabled": True, "adapters": {}}
        db.execute("INSERT INTO routing_provider_accounts VALUES(?,?)", ("fixture", json.dumps(provider)))
        db.execute("INSERT INTO routing_aliases VALUES('fornace-flash','fornace-fast')")
        card = {"limits": {"max_input_tokens": 1100000, "max_output_tokens": 16384},
                "capabilities": {"vision": True, "streaming": True, "tools": True}}
        for name in ["fornace-fast", "fornace-max"]:
            group = {"name": name, "mode": "chat", "enabled": True, "public": True, "auto_optimize": False}
            db.execute("INSERT INTO routing_model_groups VALUES(?,?)", (name, json.dumps(group)))
            for priority, upstream in enumerate(["reject-image", "accept-image"]):
                deployment = {"id": f"{name}-{priority}", "provider_id": "fixture", "model_group": name,
                              "upstream_model": upstream, "priority": priority, "weight": 1, "enabled": True,
                              "input_cost_per_token": 0, "output_cost_per_token": 0,
                              "params": {"model_card": card}}
                db.execute("INSERT INTO routing_deployments VALUES(?,?)",
                           (deployment["id"], json.dumps(deployment)))


def stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def pi_turn(root, port, session_id, token=TOKEN, compact=False):
    if compact:
        config = root / "config"
        config.mkdir(exist_ok=True)
        (config / "settings.json").write_text(json.dumps({"compaction": {"keepRecentTokens": 1}}))
    command = [os.environ.get("PI_TEST_BIN", "pi"), "--offline", "--no-extensions", "--extension",
               os.environ.get("PI_TEST_EXTENSION", str(REPO / "extensions/mantice-models.ts")), "--no-skills", "--no-themes",
               "--no-prompt-templates", "--no-context-files", "--no-tools", "--provider", "mantice",
               "--model", "fornace-fast", "--thinking", "off", "--session-dir", str(root / "sessions"),
               "--session-id", session_id, "--system-prompt", "Local synthetic fixture.", "--mode", "rpc"]
    env = {"PATH": os.environ["PATH"], "HOME": os.environ["HOME"],
           "PI_CODING_AGENT_DIR": str(root / "config"), "PI_OFFLINE": "1", "PI_TELEMETRY": "0",
           "MANTICE_BASE_URL": f"http://127.0.0.1:{port}/v1", "MANTICE_API_KEY": token,
           "FORNACE_LLM_API_KEY": token, "NO_COLOR": "1"}
    with (root / "pi.log").open("a") as log:
        process = subprocess.Popen(command, cwd=root, env=env, stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=log, text=True)
        events = queue.Queue()
        def collect():
            for line in process.stdout:
                try:
                    events.put(json.loads(line))
                except json.JSONDecodeError:
                    pass
            events.put(None)
        threading.Thread(target=collect, daemon=True).start()
        try:
            prompt = {"type": "prompt", "message": MESSAGE,
                      "images": [{"type": "image", "data": IMAGE, "mimeType": "image/png"}]}
            process.stdin.write(json.dumps(prompt) + "\n")
            process.stdin.flush()
            deadline = time.monotonic() + 30
            final = None
            while time.monotonic() < deadline:
                event = events.get(timeout=max(0.01, deadline - time.monotonic()))
                assert event is not None, "Pi exited before agent_end; see fixture pi.log"
                if event.get("type") == "message_end" and event.get("message", {}).get("role") == "assistant":
                    final = event["message"]
                if event.get("type") == "agent_end":
                    break
            assert final and final.get("stopReason") == "stop", final
            assert any(part.get("text") == "fixture OK" for part in final["content"]), final
            if compact:
                for command in [{"type": "compact", "id": "fixture-compact"}, prompt] * 2:
                    process.stdin.write(json.dumps(command) + "\n")
                    process.stdin.flush()
                    deadline = time.monotonic() + 30
                    completed = False
                    diagnostics = []
                    while time.monotonic() < deadline:
                        event = events.get(timeout=max(0.01, deadline - time.monotonic()))
                        assert event is not None, "Pi exited during compaction lifecycle"
                        if event.get("type") in ["extension_error", "extension_ui_request"]:
                            diagnostics.append(event)
                        if command["type"] == "compact" and event.get("id") == "fixture-compact":
                            assert event.get("success"), event
                            assert event.get("data", {}).get("summary") == "fixture OK", (event, diagnostics)
                            completed = True
                            break
                        if command["type"] == "prompt" and event.get("type") == "message_end":
                            if event.get("message", {}).get("role") == "assistant":
                                assert event["message"].get("stopReason") == "stop", event
                        if command["type"] == "prompt" and event.get("type") == "agent_end":
                            completed = True
                            break
                    assert completed, "compaction lifecycle timed out"
        finally:
            stop(process)


def run(root):
    upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    database = root / "gateway.db"
    seed(database, upstream.server_port)
    env = {"PATH": os.environ["PATH"], "DATABASE_PATH": str(database),
           "BIND_ADDR": f"127.0.0.1:{port}", "ADMIN_TOKEN": "local-fixture-admin",
           "ALLOW_ANONYMOUS": "false", "WORKERS": "4"}
    with (root / "gateway.log").open("w") as log:
        gateway = subprocess.Popen([os.environ["MANTICE_BIN"]], env=env, stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 10
            while True:
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/readyz", timeout=1):
                        break
                except OSError:
                    assert gateway.poll() is None and time.monotonic() < deadline, "fixture gateway not ready"
                    time.sleep(0.05)
            with sqlite3.connect(database) as db:
                db.execute("INSERT INTO users(id,name,plan,created_at) VALUES('fixture','Fixture','test',?)",
                           (int(time.time()),))
                for token in [TOKEN, TOKEN + "-other"]:
                    db.execute("INSERT INTO tokens(token_hash,user_id,label,request_limit,token_limit,requests_used,"
                               "tokens_used,window_start,window_seconds,expires_at,enabled) "
                               "VALUES(?,'fixture','Fixture',0,0,0,0,?,3600,0,1)",
                               (hashlib.sha256(token.encode()).hexdigest(), int(time.time())))
            a = "11111111-1111-4111-8111-111111111111"
            b = "22222222-2222-4222-8222-222222222222"
            for session_id, token, expected in [
                (a, TOKEN, ["reject-image", "accept-image"]),
                (a, TOKEN, ["accept-image"]),
                (b, TOKEN, ["reject-image", "accept-image"]),
                (a, TOKEN + "-other", ["reject-image", "accept-image"]),
            ]:
                start = len(CALLS)
                pi_turn(root, port, session_id, token)
                attempts = CALLS[start:]
                assert [body["model"] for body in attempts] == expected, attempts
                if len(attempts) == 2:
                    assert attempts[0]["messages"] == attempts[1]["messages"], "triggering input changed during failover"
                content = attempts[-1]["messages"][-1]["content"]
                assert any(part.get("text") == MESSAGE for part in content), content
                assert any(part.get("image_url", {}).get("url") == "data:image/png;base64," + IMAGE
                           for part in content), "triggering image changed or dropped"
            with sqlite3.connect(database) as db:
                assert db.execute("SELECT COUNT(*) FROM session_route_preferences").fetchone()[0] == 3
            start = len(CALLS)
            pi_turn(root, port, a, compact=True)
            lifecycle = CALLS[start:]
            assert [body["model"] for body in lifecycle] == [
                "accept-image", "reject-image", "accept-image", "accept-image", "accept-image", "accept-image"
            ], [body["model"] for body in lifecycle]
            assert lifecycle[1]["messages"] == lifecycle[2]["messages"], "compaction input changed on failover"
            assert "Summarize this coding-agent conversation" in json.dumps(lifecycle[1]), lifecycle[1]
            assert MESSAGE in json.dumps(lifecycle[-1]), lifecycle[-1]
            print("session-compaction-lifecycle: PASS; real Pi RPC prompt/compact/prompt retains session preference")
            print("session-recovery-chain: PASS; real Pi + Mantice, full text/image failover, resumed preference, other-session and credential isolation")
        finally:
            stop(gateway)
            upstream.shutdown()
            upstream.server_close()


if __name__ == "__main__":
    assert Path(os.environ["MANTICE_BIN"]).is_file(), "MANTICE_BIN must name a built gateway"
    with tempfile.TemporaryDirectory(prefix="pi-mantice-recovery-") as directory:
        run(Path(directory))
