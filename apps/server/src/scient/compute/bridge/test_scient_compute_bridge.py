#!/usr/bin/env python3
"""Unit tests for the Scient compute bridge.

These tests use only the standard library and fake the kernel manager and
channels.  They must not require ZeroMQ or a real kernel, so they exercise the
bridge's own logic -- framing, correlation, outcome, interrupt and the fd-1
protection -- rather than Jupyter's.
"""

import asyncio
import contextlib
import hashlib
import io
import importlib.metadata
import json
import linecache
import os
import pathlib
import queue
import re
import signal
import struct
import subprocess
import sys
import tempfile
import traceback
import types
import unittest
from unittest.mock import patch

# Add the bridge directory to the path so we can import the module.
sys.path.insert(0, os.path.dirname(__file__))

import scient_compute_bridge as bridge


def make_bridge(initialized=True):
    output = io.BytesIO()
    instance = bridge.ScientBridge(io.BytesIO(), output)
    if initialized:
        instance._session_id = "test-session"
        instance._handshake_complete = True
    return instance, output


def decode_frames(data):
    """Split a written byte stream back into protocol messages."""
    messages = []
    offset = 0
    while offset < len(data):
        (length,) = struct.unpack(">I", data[offset : offset + 4])
        offset += 4
        messages.append(json.loads(data[offset : offset + length].decode("utf-8")))
        offset += length
    return messages


def queued(instance):
    return [json.loads(f[4:].decode("utf-8")) for f in instance._outbound.drain()]


class FakeKernelClient:
    """A kernel client that replays scripted channel messages."""

    def __init__(self, iopub=None, shell=None):
        self.iopub = list(iopub or [])
        self.shell = list(shell or [])
        self.executed = []
        self.execute_requests = []
        self.execute_error = None
        self.channels_stopped = False
        self.source_messages = []
        self.session = FakeKernelSession(self)
        self.shell_channel = FakeShellChannel(self)

    def execute(
        self,
        code,
        silent=False,
        store_history=True,
        user_expressions=None,
        allow_stdin=False,
    ):
        if self.execute_error is not None:
            raise self.execute_error
        self.executed.append(code)
        self.execute_requests.append(
            {
                "code": code,
                "silent": silent,
                "store_history": store_history,
                "user_expressions": user_expressions,
                "allow_stdin": allow_stdin,
            }
        )
        return "msg-%d" % len(self.executed)

    async def get_iopub_msg(self, timeout=None):
        if not self.iopub:
            raise queue.Empty
        return self.iopub.pop(0)

    async def get_shell_msg(self, timeout=None):
        if not self.shell:
            raise queue.Empty
        return self.shell.pop(0)

    def stop_channels(self):
        self.channels_stopped = True


class FakeKernelSession:
    def __init__(self, client):
        self.client = client
        self.counter = 0

    def msg(self, msg_type, content, metadata=None):
        self.counter += 1
        message = {
            "header": {"msg_id": "source-msg-%d" % self.counter, "msg_type": msg_type},
            "content": content,
            "metadata": metadata or {},
        }
        self.client.source_messages.append(message)
        return message


class FakeShellChannel:
    def __init__(self, client):
        self.client = client

    def send(self, message):
        self.client.source_messages[-1]["sent"] = message


class FakeKernelManager:
    """A kernel manager that answers liveness and records signals."""

    def __init__(self, alive=True):
        self.alive = alive
        self.has_kernel = True
        self.interrupts = 0
        self.interrupt_error = None
        self.shutdowns = []

    async def is_alive(self):
        return self.alive

    async def interrupt_kernel(self):
        if self.interrupt_error is not None:
            raise self.interrupt_error
        self.interrupts += 1

    async def shutdown_kernel(self, now=False):
        self.shutdowns.append(now)
        self.has_kernel = False


def iopub(msg_type, content, parent="msg-1"):
    return {
        "msg_type": msg_type,
        "content": content,
        "parent_header": {"msg_id": parent},
    }


def shell_reply(content, parent="msg-1"):
    return {"content": content, "parent_header": {"msg_id": parent}}


class TestFraming(unittest.TestCase):
    """Tests for frame encoding and decoding."""

    def test_encode_frame_produces_length_prefix_and_payload(self):
        msg = {"type": "hello", "payload": {"token": "abc"}}
        frame = bridge.encode_frame(msg)
        (length,) = struct.unpack(">I", frame[:4])
        self.assertEqual(length, len(frame) - 4)
        self.assertEqual(json.loads(frame[4:].decode("utf-8")), msg)

    def test_read_frame_round_trips(self):
        msg = {"type": "execute", "payload": {"code": "print(1)"}}
        result = bridge.read_frame(io.BytesIO(bridge.encode_frame(msg)))
        self.assertEqual(result, msg)

    def test_read_frame_raises_on_clean_eof(self):
        with self.assertRaises(EOFError):
            bridge.read_frame(io.BytesIO(b""))

    def test_read_frame_rejects_oversized_declared_length(self):
        header = struct.pack(">I", bridge.MAX_FRAME + 1)
        with self.assertRaises(ValueError):
            bridge.read_frame(io.BytesIO(header + b"{}"))

    def test_encode_frame_rejects_oversized_payload(self):
        msg = {"type": "stream", "payload": {"text": "x" * (bridge.MAX_FRAME + 1)}}
        with self.assertRaises(ValueError):
            bridge.encode_frame(msg)


class TestDetachProtocolStream(unittest.TestCase):
    """The protocol must be unreachable from file descriptor 1."""

    def test_stray_writes_to_fd_one_never_reach_the_protocol(self):
        sys.stdout.flush()
        saved = os.dup(1)
        try:
            with tempfile.TemporaryFile() as transport:
                # Stand in for the pipe the transport reads.
                os.dup2(transport.fileno(), 1)
                stream = bridge.detach_protocol_stream()
                try:
                    # What a child process or a C extension would do.
                    os.write(1, b"stray")
                    stream.write(b"frame")
                    stream.flush()
                finally:
                    stream.close()
                transport.seek(0)
                self.assertEqual(transport.read(), b"frame")
        finally:
            os.dup2(saved, 1)
            os.close(saved)

    def test_returned_descriptor_is_not_inherited_by_children(self):
        sys.stdout.flush()
        saved = os.dup(1)
        try:
            with tempfile.TemporaryFile() as transport:
                os.dup2(transport.fileno(), 1)
                stream = bridge.detach_protocol_stream()
                try:
                    self.assertFalse(os.get_inheritable(stream.fileno()))
                finally:
                    stream.close()
        finally:
            os.dup2(saved, 1)
            os.close(saved)


class TestOutboundQueue(unittest.TestCase):
    """The queue reports pressure instead of refusing a user's output."""

    def test_accepts_beyond_the_high_water_mark(self):
        q = bridge.OutboundQueue(high_water_frames=2, high_water_bytes=1024)
        q.put(b"one")
        q.put(b"two")
        q.put(b"three")
        self.assertEqual(len(q.drain()), 3)

    def test_reports_pressure_on_frame_count(self):
        q = bridge.OutboundQueue(high_water_frames=2, high_water_bytes=1024)
        q.put(b"one")
        self.assertFalse(q.pressured())
        q.put(b"two")
        self.assertTrue(q.pressured())

    def test_reports_pressure_on_byte_total(self):
        q = bridge.OutboundQueue(high_water_frames=100, high_water_bytes=10)
        q.put(b"fivebytes")
        self.assertFalse(q.pressured())
        q.put(b"x")
        self.assertTrue(q.pressured())

    def test_drain_clears_pressure(self):
        q = bridge.OutboundQueue(high_water_frames=1, high_water_bytes=1024)
        q.put(b"one")
        self.assertTrue(q.pressured())
        q.drain()
        self.assertFalse(q.pressured())
        self.assertEqual(q.pending_bytes(), 0)

    def test_rejects_after_close(self):
        q = bridge.OutboundQueue()
        q.close()
        with self.assertRaises(RuntimeError):
            q.put(b"data")


class TestExecuteMapping(unittest.TestCase):
    """Correlation state, and the outcome the kernel's reply implies."""

    def test_is_complete_needs_reply_and_idle_but_not_busy(self):
        m = bridge.ExecuteMapping()
        self.assertFalse(m.is_complete())
        m.shell_reply = {"status": "ok"}
        self.assertFalse(m.is_complete())
        # A busy status that never arrived must not hang the execution.
        m.iopub_idle = True
        self.assertTrue(m.is_complete())

    def test_outcome_succeeded(self):
        m = bridge.ExecuteMapping()
        m.shell_reply = {"status": "ok"}
        self.assertEqual(m.outcome(), "succeeded")

    def test_outcome_failed_on_error_reply(self):
        m = bridge.ExecuteMapping()
        m.shell_reply = {"status": "error", "ename": "ValueError"}
        self.assertEqual(m.outcome(), "failed")

    def test_outcome_succeeded_when_interrupt_lost_the_race(self):
        # The interrupt arrived, but the cell had already finished cleanly.
        # Reporting a cancellation here would be a lie about the user's result.
        m = bridge.ExecuteMapping()
        m.shell_reply = {"status": "ok"}
        m.interrupt_requested = True
        self.assertEqual(m.outcome(), "succeeded")

    def test_outcome_cancelled_when_interrupt_produced_keyboard_interrupt(self):
        m = bridge.ExecuteMapping()
        m.shell_reply = {"status": "error", "ename": "KeyboardInterrupt"}
        m.interrupt_requested = True
        self.assertEqual(m.outcome(), "cancelled")

    def test_outcome_cancelled_when_a_wrapped_interrupt_leads_the_error_value(self):
        m = bridge.ExecuteMapping()
        m.shell_reply = {"status": "error", "ename": "LoadError", "evalue": "InterruptException:"}
        m.interrupt_requested = True
        self.assertEqual(m.outcome(), "cancelled")

    def test_outcome_failed_when_interrupt_coincided_with_a_real_error(self):
        m = bridge.ExecuteMapping()
        m.shell_reply = {"status": "error", "ename": "ZeroDivisionError"}
        m.interrupt_requested = True
        self.assertEqual(m.outcome(), "failed")

    def test_outcome_cancelled_on_abort_reply(self):
        m = bridge.ExecuteMapping()
        m.shell_reply = {"status": "abort"}
        self.assertEqual(m.outcome(), "cancelled")

    def test_outcome_without_a_reply_depends_on_the_interrupt(self):
        m = bridge.ExecuteMapping()
        self.assertEqual(m.outcome(), "failed")
        m.interrupt_requested = True
        self.assertEqual(m.outcome(), "cancelled")

    def test_reset_clears_all_state(self):
        m = bridge.ExecuteMapping()
        m.active_request_id = "req-1"
        m.active_msg_id = "msg-1"
        m.shell_reply = {"status": "ok"}
        m.iopub_busy = True
        m.iopub_idle = True
        m.interrupt_requested = True
        m.reset()
        self.assertIsNone(m.active_request_id)
        self.assertIsNone(m.active_msg_id)
        self.assertIsNone(m.shell_reply)
        self.assertFalse(m.iopub_busy)
        self.assertFalse(m.iopub_idle)
        self.assertFalse(m.interrupt_requested)


class TestBridgeHandshake(unittest.TestCase):
    """Tests for the bridge handshake protocol."""

    @staticmethod
    def _hello(capabilities):
        return {
            "protocolVersion": 1,
            "type": "hello",
            "sessionId": "test-session",
            "generation": 1,
            "requestId": None,
            "sequence": 0,
            "payload": {
                "ownerToken": "token-123",
                "frameLimit": bridge.MAX_FRAME,
                "requiredCapabilities": capabilities,
            },
        }

    def test_hello_sets_session_and_sends_hello_ack(self):
        b, _ = make_bridge(initialized=False)
        message = self._hello(["execute", "interrupt", "restart", "shutdown"])
        b._validate_message(message)
        b._handle_hello(message)
        msgs = queued(b)
        self.assertEqual(len(msgs), 1)
        self.assertEqual(msgs[0]["type"], "hello-ack")
        self.assertEqual(msgs[0]["sessionId"], "test-session")
        self.assertEqual(msgs[0]["payload"]["ownerToken"], "token-123")
        self.assertEqual(msgs[0]["payload"]["pid"], os.getpid())
        self.assertIn("execute", msgs[0]["payload"]["capabilities"])

    def test_hello_rejects_missing_capabilities(self):
        b, _ = make_bridge(initialized=False)
        message = self._hello(["execute", "interrupt", "restart", "shutdown", "stdin"])
        b._validate_message(message)
        b._handle_hello(message)
        msgs = queued(b)
        self.assertEqual(msgs[0]["type"], "fatal")
        self.assertIn("stdin", msgs[0]["payload"]["reason"])
        self.assertFalse(b._running)
        self.assertTrue(b._stop.is_set())

    def test_rejects_sequence_gap_and_session_change(self):
        b, _ = make_bridge(initialized=False)
        hello = self._hello([])
        b._validate_message(hello)
        b._handle_hello(hello)
        with self.assertRaises(bridge.ProtocolViolation):
            b._validate_message(
                {
                    "protocolVersion": 1,
                    "type": "shutdown",
                    "sessionId": "other-session",
                    "generation": 1,
                    "requestId": None,
                    "sequence": 2,
                    "payload": {},
                }
            )


class TestOutboundSequencing(unittest.TestCase):
    """The bridge sequence must describe frames that actually exist."""

    def test_sequence_increments_once_per_queued_frame(self):
        b, _ = make_bridge()
        b._send("accepted", {}, "req-1")
        b._send("accepted", {}, "req-2")
        self.assertEqual([m["sequence"] for m in queued(b)], [0, 1])

    def test_failed_encode_leaves_no_gap_in_the_sequence(self):
        b, _ = make_bridge()
        b._send("accepted", {}, "req-1")
        with self.assertRaises(ValueError):
            b._send("stream", {"stream": "stdout", "text": "x" * (bridge.MAX_FRAME + 1)}, "req-1")
        b._send("accepted", {}, "req-2")
        self.assertEqual([m["sequence"] for m in queued(b)], [0, 1])

    def test_fatal_before_a_session_falls_back_to_diagnostics(self):
        stderr = io.StringIO()
        b = bridge.ScientBridge(io.BytesIO(), io.BytesIO(), stderr)
        b._send_fatal("nothing to send on")
        self.assertEqual(queued(b), [])
        self.assertIn("nothing to send on", stderr.getvalue())


class TestBridgeIOPubMapping(unittest.TestCase):
    """Tests for IOPub message to protocol event mapping."""

    def setUp(self):
        self.b, self.stdout = make_bridge()

    def test_stream_maps_to_stream_event(self):
        self.b._handle_iopub("stream", {"name": "stdout", "text": "hello\n"}, "req-1")
        msgs = queued(self.b)
        self.assertEqual(msgs[0]["type"], "stream")
        self.assertEqual(msgs[0]["payload"]["stream"], "stdout")
        self.assertEqual(msgs[0]["payload"]["text"], "hello\n")
        self.assertEqual(msgs[0]["requestId"], "req-1")

    def test_unknown_stream_name_falls_back_to_stdout(self):
        self.b._handle_iopub("stream", {"name": "weird", "text": "x"}, "req-1")
        self.assertEqual(queued(self.b)[0]["payload"]["stream"], "stdout")

    def test_display_png_maps_to_display_event(self):
        self.b._handle_iopub("display_data", {"data": {"image/png": "iVBORw0KGgo="}}, "req-1")
        msgs = queued(self.b)
        self.assertEqual(msgs[0]["type"], "display")
        self.assertEqual(msgs[0]["payload"]["kind"], "display-data")
        self.assertEqual(
            msgs[0]["payload"]["bundle"]["representations"][0],
            {"mediaType": "image/png", "encoding": "base64", "data": "iVBORw0KGgo="},
        )

    def test_display_text_fallback(self):
        self.b._handle_iopub("execute_result", {"data": {"text/plain": "42"}}, "req-1")
        msgs = queued(self.b)
        self.assertEqual(msgs[0]["type"], "display")
        self.assertEqual(msgs[0]["payload"]["kind"], "execute-result")
        self.assertEqual(
            msgs[0]["payload"]["bundle"]["representations"][0],
            {"mediaType": "text/plain", "encoding": "text", "data": "42"},
        )

    def test_display_svg_maps_to_display_event(self):
        source = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="2"/></svg>'
        self.b._handle_iopub(
            "display_data", {"data": {"image/svg+xml": source}}, "req-1"
        )
        msgs = queued(self.b)
        self.assertEqual(msgs[0]["type"], "display")
        self.assertEqual(msgs[0]["payload"]["kind"], "display-data")
        self.assertEqual(
            msgs[0]["payload"]["bundle"]["representations"][0],
            {"mediaType": "image/svg+xml", "encoding": "text", "data": source},
        )

    def test_complete_bundle_metadata_identity_and_json_are_retained(self):
        self.b._handle_iopub(
            "display_data",
            {
                "data": {
                    "text/plain": "fallback",
                    "application/vnd.plotly.v1+json": {"data": [{"x": [1, 2]}]},
                    "image/png": "iVBORw0KGgo=",
                },
                "metadata": {"image/png": {"width": 640}},
                "transient": {"display_id": "figure-1"},
            },
            "req-1",
        )
        payload = queued(self.b)[0]["payload"]
        self.assertEqual(payload["kind"], "display-data")
        self.assertEqual(payload["displayId"], "figure-1")
        self.assertEqual(
            [item["mediaType"] for item in payload["bundle"]["representations"]],
            ["text/plain", "application/vnd.plotly.v1+json", "image/png"],
        )
        self.assertEqual(
            payload["bundle"]["representations"][1]["encoding"], "json"
        )
        self.assertEqual(
            json.loads(payload["bundle"]["metadataJson"])["image/png"]["width"], 640
        )

    def test_invalid_json_and_metadata_do_not_discard_valid_fallback(self):
        self.b._handle_iopub(
            "display_data",
            {
                "data": {"text/plain": "fallback", "application/json": float("nan")},
                "metadata": {"application/json": {"value": float("nan")}},
            },
            "req-1",
        )
        msgs = queued(self.b)
        payload = msgs[0]["payload"]
        self.assertEqual(
            payload["bundle"],
            {
                "representations": [
                    {"mediaType": "text/plain", "encoding": "text", "data": "fallback"}
                ],
                "metadataJson": None,
            },
        )
        self.assertEqual(msgs[1]["type"], "warning")
        self.assertEqual(msgs[1]["payload"]["code"], "output-truncated")

    def test_oversized_png_warns_instead_of_sending(self):
        oversized = "A" * ((bridge.MAX_REPRESENTATION_BUNDLE * 4) // 3 + 4)
        self.b._handle_iopub("display_data", {"data": {"image/png": oversized}}, "req-1")
        msgs = queued(self.b)
        self.assertEqual(len(msgs), 1)
        self.assertEqual(msgs[0]["type"], "warning")
        self.assertEqual(msgs[0]["payload"]["code"], "output-truncated")

    def test_oversized_non_ascii_png_warns_instead_of_sending(self):
        # What a ``_repr_png_`` returning prose looks like: it is not base64 at
        # all, and half as many characters as the limit allows still encodes to
        # more bytes than the limit -- which an ASCII-only count would miss.
        oversized = "\u00e9" * (bridge.MAX_REPRESENTATION_BUNDLE + 1)
        self.b._handle_iopub("display_data", {"data": {"image/png": oversized}}, "req-1")
        msgs = queued(self.b)
        self.assertEqual(len(msgs), 1)
        self.assertEqual(msgs[0]["type"], "warning")
        self.assertEqual(msgs[0]["payload"]["code"], "output-truncated")

    def test_oversized_svg_warns_instead_of_sending(self):
        oversized = "é" * (bridge.MAX_REPRESENTATION_BUNDLE // 2 + 1)
        self.b._handle_iopub(
            "display_data", {"data": {"image/svg+xml": oversized}}, "req-1"
        )
        msgs = queued(self.b)
        self.assertEqual(len(msgs), 1)
        self.assertEqual(msgs[0]["type"], "warning")
        self.assertEqual(msgs[0]["payload"]["code"], "output-truncated")

    def test_svg_that_expands_past_frame_limit_warns_instead_of_failing(self):
        self.b._peer_frame_limit = 1024
        source = "<svg>" + ("x" * 2000) + "</svg>"
        self.b._handle_iopub(
            "display_data", {"data": {"image/svg+xml": source}}, "req-1"
        )
        msgs = queued(self.b)
        self.assertEqual(len(msgs), 1)
        self.assertEqual(msgs[0]["type"], "warning")
        self.assertEqual(msgs[0]["payload"]["code"], "output-truncated")

    def test_error_maps_to_error_event(self):
        self.b._handle_iopub(
            "error",
            {"ename": "ValueError", "evalue": "bad", "traceback": ["line 1", "line 2"]},
            "req-1",
        )
        msgs = queued(self.b)
        self.assertEqual(msgs[0]["type"], "error")
        self.assertEqual(msgs[0]["payload"]["name"], "ValueError")
        self.assertEqual(msgs[0]["payload"]["value"], "bad")
        self.assertEqual(msgs[0]["payload"]["traceback"], ["line 1", "line 2"])

    def test_error_does_not_decide_the_outcome(self):
        # An exception the user caught and re-raised inside the cell still shows
        # up here; only the shell reply says whether the cell as a whole failed.
        self.b._mapping.shell_reply = {"status": "ok"}
        self.b._handle_iopub("error", {"ename": "ValueError", "evalue": "x"}, "req-1")
        self.assertEqual(self.b._mapping.outcome(), "succeeded")

    def test_status_busy_sets_mapping(self):
        self.b._mapping.active_request_id = "req-1"
        self.b._handle_iopub("status", {"execution_state": "busy"}, "req-1")
        self.assertTrue(self.b._mapping.iopub_busy)

    def test_status_idle_sets_mapping(self):
        self.b._mapping.active_request_id = "req-1"
        self.b._handle_iopub("status", {"execution_state": "idle"}, "req-1")
        self.assertTrue(self.b._mapping.iopub_idle)

    def test_clear_output_retains_each_ordered_fact(self):
        for _ in range(5):
            self.b._handle_iopub("clear_output", {"wait": True}, "req-1")
        msgs = queued(self.b)
        self.assertEqual(len(msgs), 5)
        self.assertTrue(
            all(
                msg["payload"] == {"kind": "clear-output", "wait": True}
                for msg in msgs
            )
        )

    def test_update_display_and_clear_output_are_distinct_facts(self):
        self.b._handle_iopub(
            "update_display_data",
            {
                "data": {"text/plain": "revised"},
                "transient": {"display_id": "display-1"},
            },
            "req-1",
        )
        self.b._handle_iopub("clear_output", {}, "req-1")
        msgs = queued(self.b)
        self.assertEqual(msgs[0]["payload"]["kind"], "display-update")
        self.assertEqual(msgs[0]["payload"]["displayId"], "display-1")
        self.assertEqual(msgs[1]["payload"], {"kind": "clear-output", "wait": False})

    def test_blocked_stdin_reports_the_cause_the_user_can_act_on(self):
        self.b._handle_iopub(
            "error",
            {"ename": "StdinNotImplementedError", "evalue": "input not supported"},
            "req-1",
        )
        msgs = queued(self.b)
        self.assertEqual(msgs[0]["type"], "error")
        self.assertEqual(msgs[1]["type"], "warning")
        self.assertEqual(msgs[1]["payload"]["code"], "input-unsupported")

    def test_oversized_stream_truncates_with_warning(self):
        self.b._handle_iopub(
            "stream",
            {"name": "stdout", "text": "x" * (bridge.MAX_STREAM_TEXT + 100)},
            "req-1",
        )
        msgs = queued(self.b)
        self.assertEqual(msgs[0]["type"], "stream")
        self.assertLessEqual(
            len(msgs[0]["payload"]["text"].encode("utf-8")), bridge.MAX_STREAM_TEXT
        )
        self.assertEqual(msgs[1]["type"], "warning")
        self.assertEqual(msgs[1]["payload"]["code"], "output-truncated")

    def test_html_is_retained_for_a_future_reviewed_renderer(self):
        self.b._handle_iopub(
            "display_data",
            {"data": {"text/html": "<b>bold</b>"}},
            "req-1",
        )
        msgs = queued(self.b)
        self.assertEqual(len(msgs), 1)
        representation = msgs[0]["payload"]["bundle"]["representations"][0]
        self.assertEqual(representation["mediaType"], "text/html")
        self.assertEqual(representation["encoding"], "text")


class TestDiagnosticCorrelation(unittest.TestCase):
    def test_julia_stack_lines_keep_the_jupyter_input_identity(self):
        instance, _ = make_bridge()
        instance._julia = True
        instance._julia_document_request = "file"
        instance._handle_iopub("execute_input", {"execution_count": 2}, "file")
        instance._handle_iopub("execute_input", {"execution_count": 3}, "console")
        instance._handle_iopub(
            "error",
            {"ename": "ErrorException", "evalue": "boom", "traceback": [" \x1b[90m@\x1b[39m \x1b[4mIn[2]:3\x1b[24m", " @ Main ./In[2]:1", " @ In[3]:1"]},
            "file",
        )
        error = queued(instance)[0]
        self.assertEqual(
            error["payload"]["traceback"],
            [" @ <scient-compute-source:66696c65:1>:3", " @ Main <scient-compute-source:66696c65:1>:1", " @ In[3]:1"],
        )

    def test_only_an_acknowledged_user_interrupt_skips_its_diagnostic(self):
        instance, _ = make_bridge()
        instance._mapping.active_request_id = "run"
        interrupted = {"ename": "KeyboardInterrupt"}
        instance._handle_iopub("error", interrupted, "run")
        self.assertEqual(queued(instance)[0]["payload"]["name"], "KeyboardInterrupt")
        instance._mapping.interrupt_requested = True
        instance._handle_iopub("error", interrupted, "run")
        self.assertEqual(queued(instance), [])
        instance._handle_iopub("error", {"ename": "ValueError", "evalue": "bad input"}, "run")
        self.assertEqual(queued(instance)[0]["payload"]["name"], "ValueError")


class TestSourceCache(unittest.TestCase):
    def setUp(self):
        self.shell = types.SimpleNamespace(
            compile=types.SimpleNamespace(cache=lambda *args: "<fallback>"),
            events=types.SimpleNamespace(register=lambda *args: None),
            user_ns={},
            config=types.SimpleNamespace(InlineBackend=types.SimpleNamespace()),
        )
        self.context = {
            "get_ipython": lambda: self.shell,
            "os": os,
            "sys": sys,
            "linecache": linecache,
        }
        # Execute the actual source-metadata hook without needing IPython.
        hook = bridge.PYTHON_RICH_DISPLAY_SETUP.split("# Jupyter carries", 1)[1]
        exec("# Jupyter carries" + hook, self.context)

    def tearDown(self):
        self.context["_scient_restore_source_context"]()
        for filename in self.context["_scient_source_cache"]:
            linecache.cache.pop(filename, None)

    def compile_source(self, source, request="a"):
        self.context["_scient_filename"] = "<scient-compute-source:" + request.encode().hex() + ">"
        filename = self.shell.compile.cache(source)
        return compile(source, filename, "exec"), filename

    def test_retained_function_keeps_its_excerpt_across_submissions(self):
        namespace = {}
        first, filename = self.compile_source(
            "def retained():\n    raise ValueError('original A')\n"
        )
        exec(first, namespace)
        second, second_filename = self.compile_source("marker = 'B'\nretained()\n", "b")
        try:
            exec(second, namespace)
        except ValueError as error:
            frames = traceback.extract_tb(error.__traceback__)
        else:
            self.fail("The retained function did not fail")
        self.assertEqual(frames[-1].filename, filename)
        self.assertEqual(frames[-1].line, "raise ValueError('original A')")
        self.assertEqual(frames[-2].filename, second_filename)
        self.assertEqual(frames[-2].line, "retained()")
        _, repeated_filename = self.compile_source("different = 1\n")
        self.assertNotEqual(filename, repeated_filename)
        self.assertIn("original A", linecache.getline(filename, 2))

    def test_cache_is_bounded_by_entries_and_bytes_without_reusing_evicted_names(self):
        _, oldest = self.compile_source("old = 1\n")
        for _ in range(300):
            self.compile_source("new = 2\n")
        self.assertEqual(len(self.context["_scient_source_cache"]), 256)
        self.assertEqual(linecache.getline(oldest, 1), "")
        for _ in range(12):
            self.shell.compile.cache("#" + "x" * (1024 * 1024))
        self.assertLessEqual(self.context["_scient_source_cache_bytes"], 8 * 1024 * 1024)
        self.assertLess(len(self.context["_scient_source_cache"]), 10)

    def test_saved_file_uses_real_file_context_but_immutable_compilation_identity(self):
        metadata = {"scient": {
            "filePath": "/project/main.py",
            "kind": "file",
            "saved": True,
            "tracebackFilename": "<scient-compute-source:61>",
        }}
        for info in (
            types.SimpleNamespace(cell_meta=metadata),
            types.SimpleNamespace(),  # IPython 8 fallback through parent_header
        ):
            self.shell.parent_header = {"metadata": metadata}
            self.context["_scient_pre_run"](info)
            self.assertEqual(self.shell.user_ns["__file__"], "/project/main.py")
            self.assertIn("/project", sys.path)
            filename = self.shell.compile.cache("x = 1\n")
            self.assertTrue(filename.startswith("<scient-compute-source:61:"))
            self.context["_scient_restore_source_context"]()
            self.assertNotIn("__file__", self.shell.user_ns)
            self.assertNotIn("/project", sys.path)


class TestWriteRecorder(unittest.TestCase):
    """The in-kernel record of the figure and table files a cell writes."""

    @staticmethod
    def install_recorder(project, staging, python):
        events = {}
        shell = types.SimpleNamespace(
            events=types.SimpleNamespace(
                register=lambda name, callback: events.setdefault(name, []).append(callback)
            )
        )
        # Audit hooks cannot be removed; each stays inert outside its cells.
        recorder = bridge.PYTHON_RICH_DISPLAY_SETUP.split("# Note which figure and table", 1)[1]
        previous = os.getcwd()
        os.chdir(project)
        try:
            with patch.dict(os.environ, {"SCIENT_RESULTS_DIR": staging}):
                exec(
                    "# Note which figure and table" + recorder,
                    {"_scient_shell": shell, "os": os, "sys": python, "json": json},
                )
        finally:
            os.chdir(previous)
        return events, python.modules["_scient_compute_writes"].take

    @classmethod
    def setUpClass(cls):
        cls.project = tempfile.TemporaryDirectory()
        cls.staging = tempfile.TemporaryDirectory()
        cls.events, take = cls.install_recorder(cls.project.name, cls.staging.name, sys)
        cls.take = staticmethod(take)

    @classmethod
    def tearDownClass(cls):
        cls.project.cleanup()
        cls.staging.cleanup()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=self.project.name)
        self.root = os.path.realpath(self.directory.name)
        self.addCleanup(self.directory.cleanup)

    def pre(self, code):
        info = types.SimpleNamespace(raw_cell=code)
        for callback in self.events["pre_run_cell"]:
            callback(info)
        return info

    def post(self, info):
        for callback in self.events["post_run_cell"]:
            callback(types.SimpleNamespace(info=info))

    def run_cell(self, code, body):
        # IPython's order: no pre_run_cell for a blank cell, post_run_cell always.
        info = types.SimpleNamespace(raw_cell=code) if not code.strip() else self.pre(code)
        try:
            body()
        finally:
            self.post(info)

    def cell(self, body):
        self.run_cell("the cell", body)
        return json.loads(self.take())

    def path(self, *parts):
        return os.path.join(self.root, *parts)

    def test_records_figures_and_tables_however_and_wherever_they_are_written(self):
        import pathlib
        import shutil

        deep = self.path(*["nested"] * 12)
        os.makedirs(deep)

        def body():
            with open(os.path.join(deep, "a.png"), "wb") as file:
                file.write(b"png")
            pathlib.Path(self.path("b.svg")).write_text("<svg/>")
            os.close(os.open(self.path("c.csv").encode(), os.O_WRONLY | os.O_CREAT))
            with open(self.path("staging.tmp"), "w") as file:
                file.write("x")
            os.replace(self.path("staging.tmp"), self.path("d.png"))
            shutil.copyfile(self.path("d.png"), self.path("e.png"))
            with open(self.path("d.png"), "rb") as file:
                file.read()
            with open(self.path("notes.txt"), "w") as file:
                file.write("not an output")

        record = self.cell(body)
        self.assertEqual(
            sorted(record["paths"]),
            sorted([
                os.path.join(deep, "a.png"),
                self.path("b.svg"),
                self.path("c.csv"),
                self.path("d.png"),
                self.path("e.png"),
            ]),
        )

    def test_records_read_state_and_excludes_writes_and_outside_paths(self):
        with open(self.path("cohort.csv"), "w") as file:
            file.write("id\n1\n")
        opened = os.stat(self.path("cohort.csv"))
        with open(self.path("generated.txt"), "w") as file:
            file.write("before")
        with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False) as outside:
            outside.write("not in the project")
        self.addCleanup(os.remove, outside.name)
        staged = os.path.join(self.staging.name, "output.csv")
        with open(staged, "w") as file:
            file.write("output")

        def body():
            with open(staged) as file:
                file.read()
            for _ in range(2):
                with open(self.path("cohort.csv")) as file:
                    file.read()
            with open(outside.name) as file:
                file.read()
            with open(self.path("generated.txt")) as file:
                file.read()
            with open(self.path("generated.txt"), "a") as file:
                file.write("after")
            with open(self.path("generated.txt")) as file:
                file.read()

        record = self.cell(body)
        self.assertEqual(
            record["reads"],
            [[self.path("cohort.csv"), opened.st_size, str(opened.st_mtime_ns), str(opened.st_ctime_ns)]],
        )
        self.assertFalse(record["readsTruncated"])
        self.assertEqual(record["readsOutsideProject"], 0)
        self.assertEqual(record["outsideDataPaths"], [])
        self.assertNotIn(outside.name, json.dumps(record))

    def test_names_outside_data_but_skips_configuration_fonts_and_caches(self):
        home = pathlib.Path(self.root)
        project = home / "project"
        project.mkdir()
        data = ("Data/cohort.csv",)
        noise = (".cache/cache.json", ".config/fontconfig/settings.json",
                 "Library/Caches/fontlist.json", "Library/Fonts/face.ttf",
                 "scratch/cached.csv", "Data/tool.conf")
        for name in data + noise:
            target = home / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("fixture")
        with (patch("os.path.expanduser", return_value=str(home)),
              patch("tempfile.gettempdir", return_value=str(home / "scratch")),
              patch.dict(os.environ, {"TMPDIR": str(home / "scratch")})):
            events, take = self.install_recorder(str(project), self.staging.name, sys)
        info = types.SimpleNamespace(raw_cell="read files")
        for callback in events["pre_run_cell"]:
            callback(info)
        for name in data + noise:
            (home / name).read_text()
        for callback in events["post_run_cell"]:
            callback(types.SimpleNamespace(info=info))
        record = json.loads(take())
        self.assertEqual(record["outsideDataPaths"], ["~/Data/cohort.csv"])
        self.assertEqual(record["readsOutsideProject"], 1)
        self.assertFalse(record["readsTruncated"])

    def test_pipe_descriptors_do_not_mark_file_coverage_incomplete(self):
        def body():
            subprocess.check_output([sys.executable, "-c", "print(42)"], stderr=subprocess.PIPE)

        self.assertFalse(self.cell(body)["readsTruncated"])

        path = self.path("cohort.csv")
        pathlib.Path(path).write_text("id\n1\n")
        fd = os.open(path, os.O_RDONLY)
        self.addCleanup(os.close, fd)
        def read_unidentified_file():
            with open(fd, closefd=False) as stream:
                stream.read()
        self.assertTrue(self.cell(read_unidentified_file)["readsTruncated"])

    def test_output_overflow_keeps_reads_and_evicts_files_written_after_reading(self):
        import pathlib

        early, late, generated = map(lambda name: pathlib.Path(self.path(name)), (
            "early.csv", "late.csv", "edited.txt",
        ))
        for path in (early, late, generated):
            path.write_text("id\n1\n")

        def body():
            early.read_bytes()
            generated.read_bytes()
            for idx in range(4098):
                output = pathlib.Path(self.path(str(idx) + ".txt"))
                output.write_text("generated")
                if idx < 4096:
                    output.read_bytes()
            generated.write_text("replacement")
            late.read_bytes()

        result = self.cell(body)
        self.assertTrue(result["readsTruncated"])
        self.assertEqual([row[0] for row in result["reads"]], [str(early), str(late)])

    def test_records_linked_dataset_by_the_path_the_script_read(self):
        with tempfile.TemporaryDirectory() as external:
            with open(os.path.join(external, "cohort.csv"), "w") as file:
                file.write("id\n1\n")
            linked = self.path("linked")
            os.symlink(external, linked, target_is_directory=True)
            path = os.path.join(linked, "cohort.csv")

            def body():
                os.listdir(linked)
                with open(path) as file:
                    file.read()

            record = self.cell(body)
        self.assertEqual([row[0] for row in record["reads"]], [path])
        self.assertEqual([row[0] for row in record["directoryReads"]], [linked])
        self.assertEqual(record["readsOutsideProject"], 0)

    def test_environment_reads_do_not_fill_input_evidence(self):
        import pathlib

        data = [pathlib.Path(self.path(name)) for name in (".venv/real.csv", "predictions.csv")]
        environment = [
            pathlib.Path(self.path(name))
            for name in (
                "env-one/lib/font.txt", "vendor/site-packages/table.csv",
                "vendor/dist-packages/table.csv", "__pycache__/module.pyc",
            )
        ]
        for file in data + environment:
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("contents")
        pathlib.Path(self.path("env-one/pyvenv.cfg")).write_text("home = test")
        # The base interpreter is normally outside the project, where these reads
        # would otherwise inflate the count of external files.
        interpreter_file = pathlib.Path(os.__file__).resolve()
        interpreter_file.relative_to(pathlib.Path(sys.base_prefix).resolve())

        def body():
            for file in data + environment + [interpreter_file]:
                file.read_bytes()
            for file in environment:
                os.listdir(file.parent)
            os.listdir(data[0].parent)

        record = self.cell(body)
        self.assertEqual([row[0] for row in record["reads"]], list(map(str, data)))
        self.assertEqual([row[0] for row in record["directoryReads"]], [str(data[0].parent)])
        self.assertEqual(record["readsOutsideProject"], 0)
        self.assertFalse(record["readsTruncated"])

    def test_interpreter_prefix_can_cover_the_project_without_hiding_data(self):
        import pathlib

        data = pathlib.Path(self.path("predictions.csv"))
        data.write_text("id\n1\n")
        pathlib.Path(self.path("pyvenv.cfg")).write_text("home = test")
        package = pathlib.Path(self.path("lib/site-packages/package.txt"))
        package.parent.mkdir(parents=True)
        package.write_text("package")

        for prefix in (self.root, self.project.name):
            with self.subTest(prefix=prefix):
                python = types.SimpleNamespace(
                    prefix=prefix, base_prefix=prefix, exec_prefix=prefix, base_exec_prefix=prefix,
                    version_info=sys.version_info, modules={}, _getframe=sys._getframe,
                    addaudithook=sys.addaudithook,
                )
                events, take = self.install_recorder(self.root, self.staging.name, python)
                with patch.object(self, "events", events), patch.object(self, "take", take):
                    record = self.cell(lambda: (data.read_bytes(), package.read_bytes()))
                self.assertEqual([row[0] for row in record["reads"]], [str(data)])

    def test_ignores_import_lookup_but_keeps_an_explicit_listing_of_the_same_folder(self):
        import importlib
        import pathlib
        import py_compile

        module_name = "_scient_recorder_test_module"
        library = self.path("library")
        os.mkdir(library)
        source = pathlib.Path(library, module_name + ".py")
        source.write_text("value = 42\n")
        py_compile.compile(str(source), doraise=True)
        self.addCleanup(sys.modules.pop, module_name, None)
        self.addCleanup(sys.path_importer_cache.pop, library, None)
        with patch.object(sys, "path", [library, *sys.path]):
            imported = self.cell(lambda: importlib.import_module(module_name))
            listed = self.cell(lambda: os.listdir(library))
        self.assertEqual(imported["directoryReads"], [])
        self.assertEqual([row[0] for row in imported["reads"]], [str(source)])
        self.assertEqual([row[0] for row in listed["directoryReads"]], [library])

    def test_project_listing_excludes_scient_placements_and_literal_globs(self):
        from glob import glob

        root = os.path.realpath(self.project.name)
        for name in ("assets", "results", ".scient", "data"):
            directory = os.path.join(root, name)
            os.mkdir(directory)
            self.addCleanup(os.rmdir, directory)
        literal = self.cell(lambda: glob(os.path.join(root, "missing.csv")))
        self.assertEqual(literal["directoryReads"], [])
        finder = importlib.metadata.MetadataPathFinder
        context = finder.Context(path=[root])
        discovery = self.cell(lambda: list(finder.find_distributions(context)))
        self.assertEqual(discovery["directoryReads"], [])
        tooling = self.cell(lambda: os.listdir(root))
        self.assertEqual(tooling["directoryReads"], [])
        names = json.dumps(sorted(["data", os.path.basename(self.root)]), separators=(",", ":"))
        digest = hashlib.sha256(names.encode()).hexdigest()
        for expression in ("os.listdir(root)", 'glob("*", root_dir=root)', "list(Path(root).iterdir())"):
            code = compile(expression, self.path("script.py"), "exec")
            listed = self.cell(lambda: exec(code, {"os": os, "glob": glob, "Path": pathlib.Path, "root": root}))
            self.assertEqual(listed["directoryReads"], [[root, digest]], expression)

    def test_records_sorted_directory_snapshots_from_listdir_scandir_and_glob(self):
        from glob import glob

        for names in ("direct", "scan", "glob"):
            os.mkdir(self.path(names))
        with open(self.path("direct", "é.csv"), "w") as file:
            file.write("x")
        with open(self.path("direct", "A.csv"), "w") as file:
            file.write("x")

        def body():
            os.listdir(self.path("direct"))
            with os.scandir(self.path("scan")) as entries:
                list(entries)
            glob("missing*.csv", root_dir=self.path("glob"))

        record = self.cell(body)
        direct = hashlib.sha256('["A.csv","é.csv"]'.encode()).hexdigest()
        empty = hashlib.sha256(b"[]").hexdigest()
        self.assertEqual(record["directoryReads"], [
            [self.path("direct"), direct], [self.path("scan"), empty], [self.path("glob"), empty],
        ])
        self.assertEqual(record["reads"], [])
        self.assertFalse(record["readsTruncated"])

    def test_a_cell_that_raises_after_saving_still_reports_the_save(self):
        def body():
            with open(self.path("saved.png"), "wb") as file:
                file.write(b"png")
            raise ValueError("after the save")

        with self.assertRaises(ValueError):
            self.cell(body)
        # The bridge reads the record after the reply, whatever the cell's outcome.
        self.assertEqual(json.loads(self.take())["paths"], [self.path("saved.png")])

    def test_records_only_inside_a_cell_and_hands_each_record_out_once(self):
        with open(self.path("outside.png"), "wb") as file:
            file.write(b"png")
        self.run_cell("  ", lambda: None)
        self.assertEqual(json.loads(self.take())["paths"], [])
        record = self.cell(lambda: open(self.path("inside.svg"), "w").close())
        self.assertEqual(record["paths"], [self.path("inside.svg")])
        self.assertEqual(json.loads(self.take())["paths"], [])

    def test_a_nested_blank_cell_does_not_end_the_cell_that_ran_it(self):
        def body():
            self.run_cell("", lambda: None)
            open(self.path("after-nested.svg"), "w").close()

        self.assertEqual(self.cell(body)["paths"], [self.path("after-nested.svg")])

    def test_a_lost_cell_lifecycle_gives_no_record(self):
        def body():
            self.pre("nested, never finished")
            open(self.path("lost.svg"), "w").close()

        self.assertIsNone(self.cell(body))
        # An interrupted async cell ends with a result of None.
        self.pre("interrupted")
        for callback in self.events["post_run_cell"]:
            callback(None)
        self.assertIsNone(json.loads(self.take()))
        self.assertEqual(
            self.cell(lambda: open(self.path("next.svg"), "w").close())["paths"],
            [self.path("next.svg")],
        )

    def test_the_line_that_installed_the_recorder_does_not_spoil_the_next_record(self):
        self.post(types.SimpleNamespace(raw_cell="exec(setup)"))
        self.assertEqual(
            self.cell(lambda: open(self.path("first.svg"), "w").close())["paths"],
            [self.path("first.svg")],
        )

    def test_keeps_a_bounded_record(self):
        def body():
            for index in range(300):
                open(self.path("figure-%d.png" % index), "wb").close()

        self.assertEqual(len(self.cell(body)["paths"]), 256)


class TestBridgeExecute(unittest.IsolatedAsyncioTestCase):
    """Submitting work, and what happens when submitting fails."""

    def setUp(self):
        self.b, self.stdout = make_bridge()
        self.client = FakeKernelClient()
        self.manager = FakeKernelManager()
        self.b._kernel_client = self.client
        self.b._kernel_manager = self.manager

    async def asyncTearDown(self):
        task = self.b._execution_task
        if task is not None:
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

    async def test_accepts_and_starts_correlating(self):
        await self.b._handle_execute({"code": "1+1", "silent": False, "storeHistory": True}, "req-1")
        self.assertEqual(self.client.executed, ["1+1"])
        self.assertEqual(self.b._mapping.active_request_id, "req-1")
        msgs = decode_frames(self.stdout.getvalue())
        self.assertEqual(msgs[0]["type"], "accepted")
        self.assertEqual(msgs[0]["requestId"], "req-1")

    async def test_saved_file_metadata_uses_native_execute_request_header(self):
        code = "from .sibling import answer\nanswer\n"
        with tempfile.TemporaryDirectory() as directory:
            source = os.path.join(directory, "main.py")
            with open(source, "wb") as stream:
                stream.write(code.encode("utf-8"))
            self.b._working_directory = os.path.realpath(directory)
            await self.b._handle_execute(
                {
                    "code": code,
                    "sourceContext": {
                        "kind": "file",
                        "filePath": "main.py",
                        "sourceBytesHash": hashlib.sha256(code.encode("utf-8")).hexdigest(),
                        "saved": True,
                        "startLine": 0,
                    },
                },
                "saved-1",
            )
            self.assertEqual(self.client.executed, [])
            self.assertEqual(len(self.client.source_messages), 1)
            message = self.client.source_messages[0]
            self.assertEqual(
                message["metadata"]["scient"]["filePath"], os.path.realpath(source)
            )
            self.assertTrue(message["metadata"]["scient"]["saved"])
            self.assertTrue(message["metadata"]["scient"]["tracebackFilename"].startswith("<scient-compute-source:"))
            self.assertEqual(message["content"]["code"], code)

    async def test_dirty_selection_hash_is_provenance_only(self):
        code = "print('selection')\n"
        await self.b._handle_execute(
            {
                "code": code,
                "sourceContext": {
                    "kind": "selection",
                    "sourceBytesHash": hashlib.sha256(code.encode("utf-8")).hexdigest(),
                    "saved": False,
                    "startLine": 4,
                    "endLine": 5,
                },
            },
            "selection-1",
        )
        self.assertEqual(self.client.executed, [])
        self.assertEqual(self.client.source_messages[0]["metadata"]["scient"]["kind"], "selection")
        self.assertEqual(
            self.client.source_messages[0]["metadata"]["scient"]["tracebackFilename"],
            "<scient-compute-source:" + "selection-1".encode().hex() + ">",
        )

    async def test_saved_selection_stays_submitted_bytes_not_native_file(self):
        code = "print('selected')\n"
        with tempfile.TemporaryDirectory() as directory:
            source = os.path.join(directory, "analysis.py")
            with open(source, "w", encoding="utf-8") as stream:
                stream.write("print('whole file')\n")
            self.b._working_directory = os.path.realpath(directory)
            await self.b._handle_execute(
                {
                    "code": code,
                    "sourceContext": {
                        "kind": "selection",
                        "filePath": "analysis.py",
                        "sourceBytesHash": hashlib.sha256(code.encode("utf-8")).hexdigest(),
                        "saved": True,
                    },
                },
                "saved-selection-1",
            )
            self.assertEqual(self.client.executed, [])
            self.assertEqual(self.client.source_messages[0]["metadata"]["scient"]["kind"], "selection")

    async def test_real_kernel_preserves_cell_line_and_canonical_saved_filename_after_chdir(self):
        """Exercise IPython compilation, traceback emission, and cwd stability."""
        try:
            import jupyter_client  # noqa: F401
        except ImportError:
            self.skipTest("jupyter_client is unavailable")

        with tempfile.TemporaryDirectory() as directory:
            source_directory = os.path.join(directory, "src")
            os.makedirs(source_directory)
            saved_path = os.path.join(source_directory, "saved.py")
            saved_code = "raise RuntimeError('saved source')\n"
            with open(saved_path, "wb") as stream:
                stream.write(saved_code.encode("utf-8"))

            self.b._stderr = io.StringIO()
            try:
                # The fixture installs a fake manager for ordinary unit tests;
                # this case deliberately replaces it with a real local kernel.
                self.b._kernel_manager = None
                await self.b._start_kernel(
                    {"workingDirectory": directory, "kernel": None}
                )
                cell_code = "import os\nos.chdir('/')\nraise RuntimeError('cell source')\n"
                await self.b._handle_execute(
                    {
                        "code": cell_code,
                        "sourceContext": {
                            "kind": "selection",
                            "filePath": "src/cell.py",
                            "sourceBytesHash": hashlib.sha256(
                                cell_code.encode("utf-8")
                            ).hexdigest(),
                            "saved": False,
                            "startLine": 5,
                        },
                    },
                    "real-cell-source",
                )
                await self.b._execution_task
                first_error = next(
                    message
                    for message in decode_frames(self.stdout.getvalue())
                    if message["type"] == "error"
                    and message["requestId"] == "real-cell-source"
                )
                first_traceback = first_error["payload"]["traceback"]
                self.assertTrue(
                    any(
                        (
                            "<scient-compute-source:" in line and ">:3" in line
                        )
                        for line in first_traceback
                    ),
                    first_traceback,
                )
                self.assertFalse(
                    any(
                        ">:8" in line or 'line 8' in line
                        for line in first_traceback
                    )
                )
                clean_traceback = [
                    re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", line)
                    for line in first_traceback
                ]
                self.assertTrue(
                    any("raise RuntimeError('cell source')" in line for line in clean_traceback),
                    clean_traceback,
                )

                await self.b._handle_execute(
                    {
                        "code": saved_code,
                        "sourceContext": {
                            "kind": "file",
                            "filePath": "src/saved.py",
                            "sourceBytesHash": hashlib.sha256(
                                saved_code.encode("utf-8")
                            ).hexdigest(),
                            "saved": True,
                        },
                    },
                    "real-saved-source",
                )
                await self.b._execution_task
                second_error = next(
                    message
                    for message in decode_frames(self.stdout.getvalue())
                    if message["type"] == "error"
                    and message["requestId"] == "real-saved-source"
                )
                second_traceback = second_error["payload"]["traceback"]
                self.assertTrue(
                    any(
                        "<scient-compute-source:" in line and ">:1" in line
                        for line in second_traceback
                    ),
                    second_traceback,
                )
            finally:
                monitor = self.b._kernel_monitor_task
                if monitor is not None:
                    monitor.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await monitor
                if self.b._kernel_client is not None:
                    with contextlib.suppress(Exception):
                        self.b._kernel_client.stop_channels()
                if self.b._kernel_manager is not None:
                    with contextlib.suppress(Exception):
                        await self.b._stop_kernel_process()

    async def test_saved_source_conflict_fails_without_submitting_code(self):
        with tempfile.TemporaryDirectory() as directory:
            source = os.path.join(directory, "main.py")
            with open(source, "w", encoding="utf-8") as stream:
                stream.write("print('disk')\n")
            self.b._working_directory = os.path.realpath(directory)
            await self.b._handle_execute(
                {
                    "code": "print('submitted')\n",
                    "sourceContext": {
                        "kind": "file",
                        "filePath": "main.py",
                        "sourceBytesHash": hashlib.sha256(b"print('submitted')\n").hexdigest(),
                        "saved": True,
                    },
                },
                "conflict-1",
            )
            messages = decode_frames(self.stdout.getvalue())
            self.assertEqual(self.client.executed, [])
            self.assertEqual(self.client.source_messages, [])
            self.assertEqual(messages[0]["type"], "accepted")
            self.assertEqual(messages[1]["payload"]["name"], "Scient:SourceConflict")
            self.assertEqual(messages[-1]["payload"]["outcome"], "failed")

    async def test_oversized_saved_source_is_rejected_with_bounded_read(self):
        with tempfile.TemporaryDirectory() as directory:
            source = os.path.join(directory, "oversized.py")
            with open(source, "wb") as stream:
                stream.write(b"x" * (bridge.MAX_CODE + 1))
            self.b._working_directory = os.path.realpath(directory)
            await self.b._handle_execute(
                {
                    "code": "x\n",
                    "sourceContext": {
                        "kind": "file",
                        "filePath": "oversized.py",
                        "sourceBytesHash": hashlib.sha256(b"x\n").hexdigest(),
                        "saved": True,
                    },
                },
                "oversized-source",
            )
            messages = decode_frames(self.stdout.getvalue())
            self.assertEqual(self.client.source_messages, [])
            self.assertIn("exceeds the bridge code limit", messages[1]["payload"]["value"])
            self.assertEqual(messages[-1]["payload"]["outcome"], "failed")

    async def test_a_refused_submit_leaves_the_session_usable(self):
        self.client.execute_error = RuntimeError("shell channel is dead")
        with self.assertRaises(RuntimeError):
            await self.b._handle_execute({"code": "1+1"}, "req-1")
        # The slot is still free, so the next cell can run.
        self.assertIsNone(self.b._mapping.active_request_id)
        self.assertIsNone(self.b._execution_task)

    async def test_rejects_oversized_code(self):
        with self.assertRaises(bridge.ProtocolViolation):
            await self.b._handle_execute({"code": "x" * (bridge.MAX_CODE + 1)}, "req-1")
        self.assertEqual(self.client.executed, [])

    async def test_rejects_a_second_concurrent_execution(self):
        self.b._mapping.active_request_id = "req-1"
        with self.assertRaises(bridge.ProtocolViolation):
            await self.b._handle_execute({"code": "1"}, "req-2")


class TestBridgeVariables(unittest.IsolatedAsyncioTestCase):
    """Variable inspection is bounded, correlated and never enters history."""

    def setUp(self):
        self.b, self.stdout = make_bridge()
        self.manager = FakeKernelManager()
        self.b._kernel_manager = self.manager

    async def test_reports_the_kernel_package_inventory_without_entering_history(self):
        distributions = [
            types.SimpleNamespace(metadata={"Name": f"package-{i:04d}", "Version": "2.1"})
            for i in range(4002)
        ]
        with patch.object(importlib.metadata, "distributions", return_value=iter(distributions)):
            encoded = eval(bridge.PACKAGE_EVIDENCE_EXPRESSION)
        self.b._kernel_client = FakeKernelClient(shell=[shell_reply({
            "status": "ok",
            "user_expressions": {"packages": {"status": "ok", "data": {"text/plain": repr(encoded)}}},
        })])
        evidence = await self.b._python_package_evidence()
        self.assertEqual(len(evidence["packages"]), 4000)
        self.assertEqual(evidence["packages"][0], {"name": "package-0000", "version": "2.1"})
        self.assertTrue(evidence["packagesTruncated"])
        self.assertFalse(self.b._kernel_client.execute_requests[0]["store_history"])

    async def test_returns_a_bounded_snapshot_from_a_hidden_expression(self):
        encoded = json.dumps(
            {
                "variables": [
                    {
                        "name": "answer",
                        "typeName": "int",
                        "shape": None,
                        "size": None,
                        "preview": "42",
                    }
                ],
                "truncated": False,
            },
            separators=(",", ":"),
        )
        self.b._kernel_client = FakeKernelClient(
            shell=[
                shell_reply(
                    {
                        "status": "ok",
                        "user_expressions": {
                            "scient_variables": {
                                "status": "ok",
                                "data": {"text/plain": repr(encoded)},
                            }
                        },
                    }
                )
            ]
        )

        await self.b._handle_inspect_variables("variables-1")

        request = self.b._kernel_client.execute_requests[0]
        self.assertEqual(request["code"], "")
        self.assertTrue(request["silent"])
        self.assertFalse(request["store_history"])
        self.assertFalse(request["allow_stdin"])
        self.assertIn("scient_variables", request["user_expressions"])
        messages = queued(self.b)
        self.assertEqual(messages[0]["type"], "variables")
        self.assertEqual(messages[0]["requestId"], "variables-1")
        self.assertEqual(messages[0]["payload"]["variables"][0]["preview"], "42")
        self.assertIsNone(messages[0]["payload"]["error"])

    async def test_inspection_failure_is_nonfatal_and_bounded(self):
        self.b._kernel_client = FakeKernelClient(
            shell=[shell_reply({"status": "error", "ename": "RuntimeError"})]
        )
        await self.b._handle_inspect_variables("variables-1")
        message = queued(self.b)[0]
        self.assertEqual(message["type"], "variables")
        self.assertEqual(message["payload"]["variables"], [])
        self.assertIn("could not inspect", message["payload"]["error"])
        self.assertTrue(self.b._running)

    async def test_refuses_to_race_an_execution(self):
        self.b._kernel_client = FakeKernelClient()
        self.b._mapping.active_request_id = "run-1"
        with self.assertRaisesRegex(bridge.ProtocolViolation, "already active"):
            await self.b._handle_inspect_variables("variables-1")
        self.assertEqual(self.b._kernel_client.execute_requests, [])

    def test_summary_expression_never_calls_a_user_defined_repr(self):
        class Hostile:
            called = False

            def __repr__(self):
                Hostile.called = True
                raise RuntimeError("must not run")

        class ndarray:
            __module__ = "numpy"
            shape_called = False

            @property
            def shape(self):
                ndarray.shape_called = True
                raise RuntimeError("must not run")

            @property
            def size(self):
                ndarray.shape_called = True
                raise RuntimeError("must not run")

        namespace = {
            "answer": 42,
            "large_text": "x" * 10_000,
            "items": [1, 2, 3],
            "hostile": Hostile(),
            "spoofed_array": ndarray(),
        }
        decoded = json.loads(eval(bridge.VARIABLE_INSPECTION_EXPRESSION, namespace))
        by_name = {item["name"]: item for item in decoded["variables"]}
        self.assertFalse(Hostile.called)
        self.assertFalse(ndarray.shape_called)
        self.assertEqual(by_name["answer"]["preview"], "42")
        self.assertEqual(by_name["items"]["size"], 3)
        self.assertIsNone(by_name["hostile"]["preview"])
        self.assertIsNone(by_name["spoofed_array"]["shape"])
        self.assertIsNone(by_name["spoofed_array"]["size"])
        self.assertLessEqual(len(by_name["large_text"]["preview"]), 4096)


class TestBridgeCorrelation(unittest.IsolatedAsyncioTestCase):
    """The correlation loop's completion, ordering and liveness behaviour."""

    def setUp(self):
        self.b, self.stdout = make_bridge()
        self.manager = FakeKernelManager()
        self.b._kernel_manager = self.manager

    def _messages(self):
        return decode_frames(self.stdout.getvalue())

    async def test_completes_when_reply_and_idle_have_arrived(self):
        self.b._kernel_client = FakeKernelClient(
            iopub=[
                iopub("status", {"execution_state": "busy"}),
                iopub("stream", {"name": "stdout", "text": "hi\n"}),
                iopub("status", {"execution_state": "idle"}),
            ],
            shell=[shell_reply({"status": "ok"})],
        )
        self.b._mapping.active_request_id = "req-1"
        self.b._mapping.active_msg_id = "msg-1"
        await self.b._correlate("req-1", "msg-1")
        types = [m["type"] for m in self._messages()]
        self.assertEqual(types, ["stream", "execution-complete"])
        self.assertEqual(self._messages()[-1]["payload"]["outcome"], "succeeded")
        self.assertIsNone(self.b._mapping.active_request_id)

    async def test_completion_carries_the_kernels_record_of_written_files(self):
        record = {"paths": ["/project/out/a.png"]}
        client = FakeKernelClient(
            iopub=[iopub("status", {"execution_state": "idle"})],
            shell=[
                shell_reply({"status": "ok"}),
                shell_reply(
                    {
                        "status": "ok",
                        "user_expressions": {
                            "writes": {
                                "status": "ok",
                                "data": {"text/plain": repr(json.dumps(record))},
                            }
                        },
                    },
                    parent="msg-2",
                ),
            ],
        )
        client.executed.append("the cell")
        self.b._kernel_client = client
        self.b._records_writes = True
        self.b._mapping.active_request_id = "req-1"
        await self.b._correlate("req-1", "msg-1")
        self.assertEqual(self._messages()[-1]["payload"]["writes"], record)
        query = client.execute_requests[-1]
        self.assertTrue(query["silent"])
        self.assertFalse(query["store_history"])
        self.assertEqual(query["user_expressions"], {"writes": bridge.WRITE_RECORD_EXPRESSION})

    async def test_success_carries_writes_without_a_second_kernel_request(self):
        record = {"paths": ["/project/out/a.png"]}
        client = FakeKernelClient(
            iopub=[iopub("status", {"execution_state": "idle"})],
            shell=[shell_reply({
                "status": "ok",
                "user_expressions": {
                    "writes": {"status": "ok", "data": {"text/plain": repr(json.dumps(record))}}
                },
            })],
        )
        self.b._kernel_client = client
        self.b._records_writes = True
        self.b._mapping.active_request_id = "req-1"
        self.b._execute_kernel("the cell", False, True, None)
        await self.b._correlate("req-1", "msg-1")
        self.assertEqual(self._messages()[-1]["payload"]["writes"], record)
        self.assertEqual(len(client.execute_requests), 1)
        self.assertEqual(client.execute_requests[0]["user_expressions"], {
            "writes": bridge.WRITE_RECORD_EXPRESSION,
        })

    async def test_completion_without_a_readable_record_leaves_it_out(self):
        client = FakeKernelClient(
            iopub=[iopub("status", {"execution_state": "idle"})],
            shell=[
                shell_reply({"status": "ok"}),
                shell_reply(
                    {"status": "ok", "user_expressions": {"writes": {"status": "error"}}},
                    parent="msg-2",
                ),
            ],
        )
        client.executed.append("the cell")
        self.b._kernel_client = client
        self.b._records_writes = True
        self.b._mapping.active_request_id = "req-1"
        await self.b._correlate("req-1", "msg-1")
        payload = self._messages()[-1]["payload"]
        self.assertEqual(payload["outcome"], "succeeded")
        self.assertNotIn("writes", payload)

    async def test_ignores_output_belonging_to_another_execution(self):
        self.b._kernel_client = FakeKernelClient(
            iopub=[
                iopub("stream", {"name": "stdout", "text": "not mine\n"}, parent="msg-9"),
                iopub("status", {"execution_state": "idle"}),
            ],
            shell=[shell_reply({"status": "ok"})],
        )
        self.b._mapping.active_request_id = "req-1"
        await self.b._correlate("req-1", "msg-1")
        self.assertEqual([m["type"] for m in self._messages()], ["execution-complete"])

    async def test_routes_known_late_output_while_another_execution_is_active(self):
        self.b._kernel_client = FakeKernelClient(
            iopub=[
                iopub(
                    "stream",
                    {"name": "stdout", "text": "late\n"},
                    parent="msg-old",
                ),
                iopub("status", {"execution_state": "idle"}),
            ],
            shell=[shell_reply({"status": "ok"})],
        )
        self.b._recent_msg_ids["msg-old"] = "req-old"
        self.b._mapping.active_request_id = "req-1"
        await self.b._correlate("req-1", "msg-1")
        messages = self._messages()
        self.assertEqual([message["type"] for message in messages], ["stream", "execution-complete"])
        self.assertEqual(messages[0]["requestId"], "req-old")
        self.assertEqual(messages[1]["requestId"], "req-1")

    async def test_keeps_parentless_output_at_session_scope_while_execution_is_active(self):
        self.b._kernel_client = FakeKernelClient(
            iopub=[
                iopub("stream", {"name": "stderr", "text": "kernel notice\n"}, parent=None),
                iopub("status", {"execution_state": "idle"}),
            ],
            shell=[shell_reply({"status": "ok"})],
        )
        self.b._mapping.active_request_id = "req-1"
        await self.b._correlate("req-1", "msg-1")
        messages = self._messages()
        self.assertEqual(messages[0]["type"], "stream")
        self.assertIsNone(messages[0]["requestId"])
        self.assertEqual(messages[-1]["requestId"], "req-1")

    async def test_drains_late_output_after_an_execution_is_idle(self):
        self.b._kernel_client = FakeKernelClient(
            iopub=[
                iopub(
                    "stream",
                    {"name": "stdout", "text": "late\n"},
                    parent="msg-old",
                )
            ]
        )
        self.b._recent_msg_ids["msg-old"] = "req-old"
        self.assertTrue(await self.b._drain_idle_iopub())
        await self.b._flush()
        messages = self._messages()
        self.assertEqual([message["type"] for message in messages], ["stream"])
        self.assertEqual(messages[0]["requestId"], "req-old")

    async def test_reports_session_loss_when_an_idle_kernel_exits(self):
        original_liveness = bridge.LIVENESS_INTERVAL
        original_poll = bridge.IDLE_POLL_INTERVAL
        bridge.LIVENESS_INTERVAL = 0.0
        bridge.IDLE_POLL_INTERVAL = 0.0
        try:
            self.manager.alive = False
            self.b._kernel_client = FakeKernelClient()
            await asyncio.wait_for(self.b._monitor_kernel(), timeout=0.1)
        finally:
            bridge.LIVENESS_INTERVAL = original_liveness
            bridge.IDLE_POLL_INTERVAL = original_poll
        messages = self._messages()
        self.assertEqual([message["type"] for message in messages], ["fatal"])
        self.assertIn("idle", messages[0]["payload"]["reason"])

    async def test_consumes_a_stale_shell_reply_without_completing(self):
        self.b._kernel_client = FakeKernelClient(
            iopub=[iopub("status", {"execution_state": "idle"})],
            shell=[shell_reply({"status": "ok"}, parent="msg-old"), shell_reply({"status": "error", "ename": "ValueError"})],
        )
        self.b._mapping.active_request_id = "req-1"
        await self.b._correlate("req-1", "msg-1")
        self.assertEqual(self._messages()[-1]["payload"]["outcome"], "failed")

    async def test_reports_session_loss_when_the_kernel_exits(self):
        original = bridge.LIVENESS_INTERVAL
        bridge.LIVENESS_INTERVAL = 0.0
        try:
            self.manager.alive = False
            self.b._kernel_client = FakeKernelClient()
            self.b._mapping.active_request_id = "req-1"
            await self.b._correlate("req-1", "msg-1")
        finally:
            bridge.LIVENESS_INTERVAL = original
        msgs = self._messages()
        # Loss is reported about the session, so there is no execution outcome
        # to claim on the way out.
        self.assertEqual([m["type"] for m in msgs], ["fatal"])
        self.assertIn("exited", msgs[0]["payload"]["reason"])
        self.assertFalse(self.b._running)

    async def test_a_broken_channel_is_reported_as_session_loss(self):
        class ExplodingClient(FakeKernelClient):
            async def get_iopub_msg(self, timeout=None):
                raise OSError("zmq socket closed")

        self.b._kernel_client = ExplodingClient()
        self.b._mapping.active_request_id = "req-1"
        await self.b._correlate("req-1", "msg-1")
        msgs = self._messages()
        self.assertEqual(msgs[0]["type"], "fatal")
        self.assertIn("zmq socket closed", msgs[0]["payload"]["reason"])

    async def test_flushes_under_pressure_instead_of_dropping_output(self):
        chatty = [iopub("stream", {"name": "stdout", "text": "line %d\n" % i}) for i in range(40)]
        chatty.append(iopub("status", {"execution_state": "idle"}))
        self.b._outbound = bridge.OutboundQueue(high_water_frames=4, high_water_bytes=1 << 20)
        self.b._kernel_client = FakeKernelClient(chatty, [shell_reply({"status": "ok"})])
        self.b._mapping.active_request_id = "req-1"
        await self.b._correlate("req-1", "msg-1")
        msgs = self._messages()
        streams = [m for m in msgs if m["type"] == "stream"]
        self.assertEqual(len(streams), 1)
        self.assertEqual(
            streams[0]["payload"]["text"],
            "".join("line %d\n" % index for index in range(40)),
        )
        self.assertEqual([m["sequence"] for m in msgs], list(range(len(msgs))))


class TestBridgeInterrupt(unittest.IsolatedAsyncioTestCase):
    """Interrupt answers whether the signal landed, not what the code did."""

    def setUp(self):
        self.b, self.stdout = make_bridge()
        self.manager = FakeKernelManager()
        self.b._kernel_manager = self.manager
        self.b._kernel_client = FakeKernelClient()
        self._saved = (bridge.INTERRUPT_BUSY_TIMEOUT, bridge.INTERRUPT_SETTLE_TIMEOUT)
        bridge.INTERRUPT_BUSY_TIMEOUT = 0.05
        bridge.INTERRUPT_SETTLE_TIMEOUT = 0.05

    def tearDown(self):
        bridge.INTERRUPT_BUSY_TIMEOUT, bridge.INTERRUPT_SETTLE_TIMEOUT = self._saved

    async def test_nothing_to_stop_is_terminal(self):
        await self.b._handle_interrupt("req-1")
        self.assertEqual(queued(self.b)[0]["payload"]["result"], "terminal")

    async def test_a_different_execution_is_rejected(self):
        self.b._mapping.active_request_id = "req-active"
        await self.b._handle_interrupt("req-other")
        self.assertEqual(queued(self.b)[0]["payload"]["result"], "rejected")
        self.assertEqual(self.manager.interrupts, 0)

    async def test_a_dead_kernel_is_terminal(self):
        self.manager.alive = False
        self.b._mapping.active_request_id = "req-1"
        self.b._mapping.iopub_busy = True
        await self.b._handle_interrupt("req-1")
        self.assertEqual(queued(self.b)[0]["payload"]["result"], "terminal")
        self.assertEqual(self.manager.interrupts, 0)

    async def test_an_undeliverable_signal_is_rejected(self):
        self.manager.interrupt_error = RuntimeError("no such process")
        self.b._mapping.active_request_id = "req-1"
        self.b._mapping.iopub_busy = True
        await self.b._handle_interrupt("req-1")
        self.assertEqual(queued(self.b)[0]["payload"]["result"], "rejected")
        self.assertFalse(self.b._mapping.interrupt_requested)

    async def test_a_signal_the_execution_answers_is_interrupted(self):
        self.b._mapping.active_request_id = "req-1"
        self.b._mapping.iopub_busy = True

        async def settle():
            await asyncio.sleep(0)
            self.b._mapping.reset()

        settling = asyncio.ensure_future(settle())
        await self.b._handle_interrupt("req-1")
        await settling
        self.assertEqual(queued(self.b)[0]["payload"]["result"], "interrupted")
        self.assertEqual(self.manager.interrupts, 1)

    async def test_a_signal_the_execution_ignores_is_a_timeout(self):
        self.b._mapping.active_request_id = "req-1"
        self.b._mapping.iopub_busy = True
        await self.b._handle_interrupt("req-1")
        self.assertEqual(queued(self.b)[0]["payload"]["result"], "timeout")
        self.assertEqual(self.manager.interrupts, 1)

    async def test_work_that_ends_while_waiting_for_busy_is_terminal(self):
        self.b._mapping.active_request_id = "req-1"

        async def finish():
            await asyncio.sleep(0)
            self.b._mapping.reset()

        finishing = asyncio.ensure_future(finish())
        await self.b._handle_interrupt("req-1")
        await finishing
        self.assertEqual(queued(self.b)[0]["payload"]["result"], "terminal")
        self.assertEqual(self.manager.interrupts, 0)

    async def test_a_missed_busy_status_still_signals(self):
        # Refusing here would strand a user whose runaway loop never published
        # a busy status; a missed status message is the likelier explanation.
        self.b._mapping.active_request_id = "req-1"
        await self.b._handle_interrupt("req-1")
        self.assertEqual(self.manager.interrupts, 1)


class TestBridgeLifecycle(unittest.IsolatedAsyncioTestCase):
    """Restart and shutdown, and what they say about work in flight."""

    def setUp(self):
        self.b, self.stdout = make_bridge()
        self.manager = FakeKernelManager()
        self.client = FakeKernelClient()
        self.b._kernel_manager = self.manager
        self.b._kernel_client = self.client

    async def test_cancelling_in_flight_work_reports_the_given_outcome(self):
        async def forever():
            await asyncio.Event().wait()

        self.b._mapping.active_request_id = "req-1"
        self.b._execution_task = asyncio.ensure_future(forever())
        await asyncio.sleep(0)
        await self.b._cancel_execution_task(emit_completion=True, outcome="cancelled")
        msgs = queued(self.b)
        self.assertEqual(msgs[0]["type"], "execution-complete")
        self.assertEqual(msgs[0]["payload"]["outcome"], "cancelled")
        self.assertIsNone(self.b._execution_task)

    async def test_cancelling_can_stay_silent_when_the_session_is_lost(self):
        self.b._mapping.active_request_id = "req-1"
        await self.b._cancel_execution_task(emit_completion=False)
        self.assertEqual(queued(self.b), [])

    async def test_shutdown_stops_the_kernel_and_confirms(self):
        await self.b._shutdown_kernel()
        self.assertTrue(self.client.channels_stopped)
        self.assertEqual(self.manager.shutdowns, [False])
        self.assertEqual(queued(self.b)[-1]["type"], "shutdown-complete")

    async def test_shutdown_escalates_when_the_kernel_will_not_go(self):
        class StubbornManager(FakeKernelManager):
            async def shutdown_kernel(self, now=False):
                self.shutdowns.append(now)
                if not now:
                    raise RuntimeError("no reply")
                self.has_kernel = False

        self.b._kernel_manager = StubbornManager()
        await self.b._shutdown_kernel()
        self.assertEqual(self.b._kernel_manager.shutdowns, [False, True])
        self.assertEqual(queued(self.b)[-1]["type"], "shutdown-complete")

    async def test_shutdown_does_not_claim_success_when_forced_stop_fails(self):
        class UnstoppableManager(FakeKernelManager):
            async def shutdown_kernel(self, now=False):
                self.shutdowns.append(now)
                raise RuntimeError("still alive")

        self.b._kernel_manager = UnstoppableManager()
        self.b._mapping.active_request_id = "req-1"
        with self.assertRaisesRegex(RuntimeError, "did not stop"):
            await self.b._shutdown_kernel()
        self.assertEqual(queued(self.b), [])

    async def test_restart_does_not_claim_cancellation_when_replacement_fails(self):
        class BrokenRestartManager(FakeKernelManager):
            async def restart_kernel(self, now=False):
                raise RuntimeError("cannot restart")

        self.b._kernel_manager = BrokenRestartManager()
        self.b._mapping.active_request_id = "req-1"
        with self.assertRaisesRegex(RuntimeError, "cannot restart"):
            await self.b._restart_kernel(2)
        self.assertEqual(queued(self.b), [])
        self.assertEqual(self.b._generation, 1)

    async def test_restart_advances_the_generation_in_the_envelope_only(self):
        class RestartingManager(FakeKernelManager):
            def __init__(self):
                super().__init__()
                self.provisioner = type("P", (), {"pid": 4321})()

            async def restart_kernel(self, now=False):
                self.restarted = now

            def client(self):
                return RestartingClient()

        class RestartingClient(FakeKernelClient):
            def start_channels(self):
                pass

            async def wait_for_ready(self, timeout=None):
                pass

        self.b._kernel_manager = RestartingManager()
        self.b._mapping.active_request_id = "req-1"
        await self.b._restart_kernel(2)
        msgs = queued(self.b)
        self.assertEqual(msgs[0]["type"], "execution-complete")
        self.assertEqual(msgs[0]["payload"]["outcome"], "cancelled")
        self.assertEqual(msgs[1]["type"], "restarted")
        self.assertEqual(msgs[1]["generation"], 2)
        self.assertEqual(msgs[1]["payload"], {"kernelPid": 4321})


class TestKernelEndpointAssignment(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.b, _ = make_bridge()

    def test_assigns_host_reserved_ports_and_disables_jupyter_port_cache(self):
        try:
            import jupyter_client  # noqa: F401
        except ImportError:
            self.skipTest("jupyter_client is unavailable")

        ports = {
            "ip": "127.0.0.1",
            "shell": 41001,
            "iopub": 41002,
            "stdin": 41003,
            "heartbeat": 41004,
            "control": 41005,
        }
        manager = self.b._make_kernel_manager(None, ports)
        self.assertEqual(manager.ip, "127.0.0.1")
        self.assertEqual(manager.shell_port, 41001)
        self.assertEqual(manager.iopub_port, 41002)
        self.assertEqual(manager.stdin_port, 41003)
        self.assertEqual(manager.hb_port, 41004)
        self.assertEqual(manager.control_port, 41005)
        self.assertFalse(manager.cache_ports)

    async def test_rejects_duplicate_host_reserved_ports_before_starting(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(bridge.ProtocolViolation, "distinct"):
                await self.b._start_kernel(
                    {
                        "workingDirectory": directory,
                        "kernel": None,
                        "kernelPorts": {
                            "ip": "127.0.0.1",
                            "shell": 41001,
                            "iopub": 41001,
                            "stdin": 41003,
                            "heartbeat": 41004,
                            "control": 41005,
                        },
                    }
                )


class TestInboundReader(unittest.IsolatedAsyncioTestCase):
    """The reader hands frames over one at a time and reports how it ended."""

    async def test_delivers_frames_then_eof(self):
        data = bridge.encode_frame({"type": "hello"}) + bridge.encode_frame({"type": "shutdown"})
        reader = bridge.InboundReader(io.BytesIO(data), asyncio.get_running_loop())
        reader.start()
        self.assertEqual(await reader.next(), ("frame", {"type": "hello"}))
        self.assertEqual(await reader.next(), ("frame", {"type": "shutdown"}))
        self.assertEqual(await reader.next(), ("eof", None))

    async def test_reports_a_malformed_frame_as_an_error(self):
        data = struct.pack(">I", 4) + b"nope"
        reader = bridge.InboundReader(io.BytesIO(data), asyncio.get_running_loop())
        reader.start()
        kind, value = await reader.next()
        self.assertEqual(kind, "error")
        self.assertIsInstance(value, ValueError)

    async def test_does_not_read_ahead_of_the_loop(self):
        data = b"".join(bridge.encode_frame({"n": n}) for n in range(3))
        stream = io.BytesIO(data)
        reader = bridge.InboundReader(stream, asyncio.get_running_loop())
        reader.start()
        first = await reader.next()
        self.assertEqual(first, ("frame", {"n": 0}))
        # One frame is in flight at most, so the stream is not drained ahead.
        await asyncio.sleep(0.05)
        self.assertLess(stream.tell(), len(data))


class TestRunLoop(unittest.IsolatedAsyncioTestCase):
    """End-to-end command handling over the framed protocol."""

    def _script(self, *messages):
        return io.BytesIO(b"".join(bridge.encode_frame(m) for m in messages))

    async def test_handshake_then_shutdown_writes_a_clean_stream(self):
        stdin = self._script(
            {
                "protocolVersion": 1,
                "type": "hello",
                "sessionId": "s-1",
                "generation": 1,
                "requestId": None,
                "sequence": 0,
                "payload": {
                    "ownerToken": "tok",
                    "frameLimit": bridge.MAX_FRAME,
                    "requiredCapabilities": ["execute"],
                },
            },
            {
                "protocolVersion": 1,
                "type": "shutdown",
                "sessionId": "s-1",
                "generation": 1,
                "requestId": None,
                "sequence": 1,
                "payload": {},
            },
        )
        stdout = io.BytesIO()
        b = bridge.ScientBridge(stdin, stdout, io.StringIO())
        self.assertEqual(await b.run(), 0)
        msgs = decode_frames(stdout.getvalue())
        self.assertEqual([m["type"] for m in msgs], ["hello-ack", "shutdown-complete"])
        self.assertEqual([m["sequence"] for m in msgs], [0, 1])

    async def test_a_protocol_violation_ends_with_a_fatal(self):
        stdin = self._script(
            {
                "protocolVersion": 1,
                "type": "execute",
                "sessionId": "s-1",
                "generation": 1,
                "requestId": "req-1",
                "sequence": 0,
                "payload": {"code": "1"},
            }
        )
        stdout = io.BytesIO()
        b = bridge.ScientBridge(stdin, stdout, io.StringIO())
        b._session_id = "s-1"
        await b.run()
        msgs = decode_frames(stdout.getvalue())
        self.assertEqual(msgs[-1]["type"], "fatal")
        self.assertIn("hello must be the first command", msgs[-1]["payload"]["reason"])

    async def test_a_stop_request_ends_the_loop(self):
        # Nothing will ever arrive on this stream, so only the stop can end it.
        stdin = os.pipe()
        reader = os.fdopen(stdin[0], "rb")
        writer = os.fdopen(stdin[1], "wb")
        b = bridge.ScientBridge(reader, io.BytesIO(), io.StringIO())
        running = asyncio.ensure_future(b.run())
        await asyncio.sleep(0.05)
        b._request_stop()
        self.assertEqual(await asyncio.wait_for(running, timeout=5), 0)
        writer.close()


class TestProcessExit(unittest.TestCase):
    """Stopping the bridge must exit the process, not abort it.

    Only a real subprocess can show this.  The inbound reader is a daemon
    thread parked in a blocking read, so it holds ``sys.stdin``'s buffered
    reader lock, and what that costs only appears once the interpreter shuts
    down -- long after an in-process ``run`` has returned.
    """

    @unittest.skipIf(os.name == "nt", "SIGTERM is not a graceful stop on Windows.")
    def test_a_stopped_process_exits_cleanly_while_the_reader_is_parked(self):
        process = subprocess.Popen(
            [sys.executable, bridge.__file__],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            hello = {
                "protocolVersion": 1,
                "type": "hello",
                "sessionId": "exit-session",
                "generation": 1,
                "requestId": None,
                "sequence": 0,
                "payload": {
                    "ownerToken": "token-123",
                    "frameLimit": bridge.MAX_FRAME,
                    "requiredCapabilities": ["execute"],
                },
            }
            process.stdin.write(bridge.encode_frame(hello))
            process.stdin.flush()
            # The acknowledgement is the readiness signal: the loop cannot have
            # answered before it installed the signal handlers below.
            self.assertEqual(bridge.read_frame(process.stdout)["type"], "hello-ack")
            process.send_signal(signal.SIGTERM)
            # stdin stays open on purpose.  Closing it would end the parked read
            # and release the very lock this test exists to survive.
            self.assertEqual(process.wait(timeout=30), 0)
            self.assertNotIn("Fatal Python error", process.stderr.read().decode("utf-8"))
        finally:
            process.kill()
            process.stdin.close()
            process.stdout.close()
            process.stderr.close()
            process.wait(timeout=30)


if __name__ == "__main__":
    unittest.main()


class TestKernelSpecValidation(unittest.TestCase):
    def spec(self, **overrides):
        value = {
            "argv": ["evcxr_jupyter", "--control_file", "{connection_file}"],
            "language": "rust",
            "interruptMode": "message",
            "variablesExpression": None,
        }
        value.update(overrides)
        return value

    def test_accepts_connection_file_inside_an_argument(self):
        spec = self.spec(argv=["deno", "jupyter", "--kernel", "--conn={connection_file}"])
        self.assertIs(bridge.validate_kernel_spec(spec), spec)

    def test_rejects_a_command_without_the_connection_file(self):
        with self.assertRaises(bridge.ProtocolViolation):
            bridge.validate_kernel_spec(self.spec(argv=["evcxr_jupyter"]))

    def test_keeps_the_installed_spec_environment_and_resource_directory(self):
        spec = self.spec(
            env={"RUST_LOG": "warn", "SCIENT_RESULTS_DIR": "wrong", "scient_parameters": "wrong"},
            resourceDir="/k/rust",
        )
        self.assertEqual(bridge.validate_kernel_spec(spec)["env"], {"RUST_LOG": "warn"})
        with self.assertRaises(bridge.ProtocolViolation):
            bridge.validate_kernel_spec(self.spec(env={"N": 1}))
        with self.assertRaises(bridge.ProtocolViolation):
            bridge.validate_kernel_spec(self.spec(resourceDir=""))
