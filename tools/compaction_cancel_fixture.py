"""Synchronization and real RPC assertions for a disposable cancellation test."""
import json
import threading
import time

ARMED = threading.Event()
STARTED = threading.Event()
RELEASE = threading.Event()


def hold_summary(body):
    if ARMED.is_set() and "Summarize this coding-agent conversation" in json.dumps(body):
        ARMED.clear()
        STARTED.set()
        assert RELEASE.wait(15), "cancellation fixture was not released"


def verify(process, events, prompt):
    def send(command):
        process.stdin.write(json.dumps(command) + "\n")
        process.stdin.flush()

    def response(identifier):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            event = events.get(timeout=max(0.01, deadline - time.monotonic()))
            assert event is not None, "Pi exited during cancellation"
            if event.get("id") == identifier:
                return event
        raise AssertionError("RPC cancellation response timed out")

    def entries(identifier):
        send({"type": "get_entries", "id": identifier})
        result = response(identifier)
        assert result.get("success"), result
        return result["data"]["entries"]

    before = entries("entries-before-abort")
    STARTED.clear()
    RELEASE.clear()
    ARMED.set()
    send({"type": "compact", "id": "cancelled-compact"})
    try:
        assert STARTED.wait(10), "custom compaction request never reached fixture"
        send({"type": "abort", "id": "abort-compaction"})
        # Responses may arrive in either order: collect both without dropping one.
        received = {}
        deadline = time.monotonic() + 15
        while len(received) < 2:
            event = events.get(timeout=max(0.01, deadline - time.monotonic()))
            assert event is not None, "Pi exited while aborting compaction"
            if event.get("id") in ("cancelled-compact", "abort-compaction"):
                received[event["id"]] = event
            assert time.monotonic() < deadline, "abort did not settle"
        assert received["abort-compaction"].get("success"), received
        assert not received["cancelled-compact"].get("success"), received
    finally:
        ARMED.clear()
        RELEASE.set()
    after = entries("entries-after-abort")
    assert [e for e in before if e.get("type") == "compaction"] == [
        e for e in after if e.get("type") == "compaction"
    ], "cancelled summary replaced session context"
    send(prompt)
    deadline = time.monotonic() + 15
    final = None
    while time.monotonic() < deadline:
        event = events.get(timeout=max(0.01, deadline - time.monotonic()))
        assert event is not None, "Pi exited after compaction cancellation"
        if event.get("type") == "message_end" and event.get("message", {}).get("role") == "assistant":
            final = event["message"]
        if event.get("type") == "agent_end":
            assert final and final.get("stopReason") == "stop", final
            print("compaction-cancellation: PASS; real RPC abort, no saved summary, session continues")
            return
    raise AssertionError("session did not continue after cancellation")
