#!/usr/bin/env python3
"""Standard-library tests for the MATLAB Engine protocol adapter."""

import asyncio
import io
import json
import os
import shutil
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock

sys.path.insert(0, os.path.dirname(__file__))

import scient_matlab_engine_bridge as matlab_bridge


def decode_frames(data):
    messages = []
    offset = 0
    while offset < len(data):
        (length,) = struct.unpack(">I", data[offset : offset + 4])
        offset += 4
        messages.append(json.loads(data[offset : offset + length].decode("utf-8")))
        offset += length
    return messages


class FakeFuture:
    def __init__(self, result, stdout=None):
        self.value = result
        self.stdout = stdout
        self.cancelled = False

    def result(self):
        if self.stdout is not None:
            self.stdout.write("MATLAB output\n")
        return self.value

    def cancel(self):
        self.cancelled = True
        return True


class FakeEngine:
    def __init__(self, receipt=None, figure=True):
        self.receipt = receipt or {"ok": True, "identifier": "", "message": "", "stack": []}
        self.figure = figure
        self.helper_directory = None
        self.which_override = None

    def bind_helpers(self, directory):
        self.helper_directory = directory

    def builtin(self, operation, name, **_kwargs):
        if operation != "which":
            raise AssertionError(f"Unexpected built-in operation: {operation}")
        if self.which_override is not None:
            return self.which_override
        return str(Path(self.helper_directory, f"{name}.m"))

    def __getattr__(self, name):
        if name.startswith("scient_compute_eval_"):
            return self._evaluate
        if name.startswith("scient_compute_figures_"):
            return self._figures
        if name.startswith("scient_compute_variables_"):
            return self._variables
        raise AttributeError(name)

    def _evaluate(self, _code, *, stdout, **_kwargs):
        return FakeFuture(json.dumps(self.receipt), stdout)

    def _figures(self, directory, _maximum, **_kwargs):
        if not self.figure:
            return json.dumps({"figures": [], "truncated": False})
        path = Path(directory, "figure-001.png")
        path.write_bytes(matlab_bridge.PNG_SIGNATURE + b"test-pixels")
        # MATLAB jsonencode represents a one-element struct array as an object.
        return json.dumps(
            {"figures": {"key": "1", "path": str(path), "warning": ""}, "truncated": False}
        )

    def _variables(self, _maximum, **_kwargs):
        return json.dumps(
            {
                "variables": {
                    "name": "answer",
                    "typeName": "double",
                    "shape": "1 x 1",
                    "size": 1,
                    "preview": "41",
                },
                "truncated": False,
            }
        )

    def quit(self):
        return None


class FailingQuitEngine(FakeEngine):
    def quit(self):
        raise RuntimeError("still running")


def make_bridge(test_case, engine):
    output = io.BytesIO()
    instance = matlab_bridge.MatlabEngineBridge(
        io.BytesIO(), output, "/matlab/engine", "/matlab"
    )
    instance._session_id = "matlab-test"
    instance._handshake_complete = True
    instance._loop = asyncio.get_running_loop()
    instance._engine = engine
    helper_directory = instance._write_helpers()
    engine.bind_helpers(helper_directory)
    test_case.addCleanup(shutil.rmtree, helper_directory, ignore_errors=True)
    return instance, output


class TestMatlabBridge(unittest.IsolatedAsyncioTestCase):
    async def test_parent_disconnect_and_stop_cancel_pending_startup(self):
        for reason in ("eof", "signal"):
            with self.subTest(reason=reason):
                read_fd, write_fd = os.pipe()
                reader = os.fdopen(read_fd, "rb", buffering=0)
                writer = os.fdopen(write_fd, "wb", buffering=0)
                instance = matlab_bridge.MatlabEngineBridge(
                    reader, io.BytesIO(), "/matlab/engine", "/matlab"
                )
                instance._install_signal_handlers = Mock()
                entered = asyncio.Event()
                cancelled = asyncio.Event()

                async def pending_start(_message):
                    entered.set()
                    try:
                        await asyncio.Future()
                    finally:
                        cancelled.set()

                instance._dispatch = pending_start
                run = asyncio.create_task(instance.run())
                try:
                    payload = json.dumps({"type": "start-kernel"}).encode()
                    writer.write(struct.pack(">I", len(payload)) + payload)
                    await asyncio.wait_for(entered.wait(), timeout=2)
                    if reason == "eof":
                        writer.close()
                    else:
                        instance._request_stop()
                    await asyncio.wait_for(run, timeout=2)
                    self.assertTrue(cancelled.is_set())
                finally:
                    writer.close()
                    reader.close()
                    if not run.done():
                        run.cancel()

    async def test_failed_start_cancels_the_engine_future(self):
        instance = matlab_bridge.MatlabEngineBridge(io.BytesIO(), io.BytesIO(), "/matlab/engine", "/matlab")
        future = Mock()
        future.result.side_effect = TimeoutError("Engine startup timed out")
        module = Mock()
        module.start_matlab.return_value = future
        instance._engine_module = module
        with self.assertRaises(TimeoutError):
            await instance._start_engine("/project")
        future.result.assert_called_once_with(timeout=matlab_bridge.STARTUP_TIMEOUT)
        future.cancel.assert_called_once()
        self.assertIsNone(instance._engine)

    async def test_stream_flood_is_flushed_with_backpressure_before_worker_returns(self):
        instance, output = make_bridge(self, FakeEngine(figure=False))
        text = "אβ output\n" * 100000
        await asyncio.to_thread(instance.forward_stream_from_thread, "stdout", text, "flood")
        messages = decode_frames(output.getvalue())
        self.assertEqual("".join(message["payload"]["text"] for message in messages), text)
        self.assertTrue(all(len(message["payload"]["text"].encode()) <= matlab_bridge.MAX_STREAM_TEXT for message in messages))

    async def test_execution_forwards_text_single_figure_and_completion(self):
        instance, output = make_bridge(self, FakeEngine())
        await instance._handle_execute({"code": "answer = 41"}, "request-1")
        await instance._execution_task
        messages = decode_frames(output.getvalue())
        self.assertIn("accepted", [message["type"] for message in messages])
        self.assertTrue(
            any(
                message["type"] == "stream"
                and "MATLAB output" in message["payload"]["text"]
                for message in messages
            )
        )
        self.assertTrue(any(message["type"] == "display" for message in messages))
        self.assertEqual(messages[-1]["type"], "execution-complete")
        self.assertEqual(messages[-1]["payload"]["outcome"], "succeeded")

    async def test_error_receipt_is_not_transport_loss(self):
        engine = FakeEngine(
            receipt={
                "ok": False,
                "identifier": "Scient:Expected",
                "message": "expected failure",
                "stack": [{"file": "/project/model.m", "line": 7, "name": "model"}],
            },
            figure=False,
        )
        instance, output = make_bridge(self, engine)
        await instance._handle_execute({"code": "error('expected')"}, "request-2")
        await instance._execution_task
        messages = decode_frames(output.getvalue())
        error = next(message for message in messages if message["type"] == "error")
        self.assertEqual(error["payload"]["name"], "Scient:Expected")
        self.assertEqual(messages[-1]["payload"]["outcome"], "failed")

    async def test_variables_accept_matlabs_single_struct_json_shape(self):
        instance, output = make_bridge(self, FakeEngine(figure=False))
        await instance._handle_variables("variables-1")
        await instance._flush()
        message = decode_frames(output.getvalue())[-1]
        self.assertEqual(message["type"], "variables")
        self.assertEqual(message["payload"]["variables"][0]["name"], "answer")
        self.assertEqual(message["payload"]["variables"][0]["preview"], "41")

    async def test_single_stack_frame_keeps_clickable_source_provenance(self):
        engine = FakeEngine(receipt={"ok": False, "identifier": "Test:Single",
                                    "message": "failure",
                                    "stack": {"file": "/project/test.m", "line": 2, "name": "test"}},
                            figure=False)
        instance, output = make_bridge(self, engine)
        await instance._handle_execute({"code": "error('failure')"}, "single-frame")
        await instance._execution_task
        error = next(message for message in decode_frames(output.getvalue()) if message["type"] == "error")
        self.assertEqual(error["payload"]["traceback"], ["/project/test.m:2:test"])

    async def test_restart_never_starts_a_replacement_after_uncertain_shutdown(self):
        instance, _ = make_bridge(self, FailingQuitEngine(figure=False))
        instance._start_engine = AsyncMock(return_value=("R2026a", "26.1"))

        with self.assertRaisesRegex(RuntimeError, "did not stop cleanly"):
            await instance._restart(2)

        instance._start_engine.assert_not_awaited()
        self.assertEqual(instance._generation, 1)
        self.assertFalse(instance._transitioning)

    async def test_helpers_are_unpredictable_and_resolution_is_identity_bound(self):
        first_engine = FakeEngine(figure=False)
        first, _ = make_bridge(self, first_engine)
        second, _ = make_bridge(self, FakeEngine(figure=False))

        self.assertEqual(set(first._helper_names), {"eval", "figures", "variables"})
        self.assertTrue(set(first._helper_names.values()).isdisjoint(second._helper_names.values()))
        self.assertFalse(
            {"scient_compute_eval.m", "scient_compute_figures.m", "scient_compute_variables.m"}
            & {path.name for path in Path(first._helper_directory).iterdir()}
        )
        for kind, name in first._helper_names.items():
            source = Path(first._helper_directory, f"{name}.m").read_text(encoding="utf-8")
            self.assertIn(f"function scientJson = {name}(", source, kind)

        first_engine.which_override = "/project/shadowed_helper.m"
        with self.assertRaisesRegex(RuntimeError, "Scient-owned code"):
            await first._trusted_helper("eval")

    def test_captured_png_must_be_contained_regular_bounded_png(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as other:
            valid = Path(directory, "figure.png")
            valid.write_bytes(matlab_bridge.PNG_SIGNATURE + b"pixels")
            self.assertEqual(
                matlab_bridge.read_captured_png(directory, str(valid)), valid.read_bytes()
            )

            outside = Path(other, "outside.png")
            outside.write_bytes(matlab_bridge.PNG_SIGNATURE + b"outside")
            with self.assertRaisesRegex(ValueError, "outside the capture directory"):
                matlab_bridge.read_captured_png(directory, str(outside))

            link = Path(directory, "linked.png")
            link.symlink_to(outside)
            with self.assertRaisesRegex(ValueError, "outside the capture directory"):
                matlab_bridge.read_captured_png(directory, str(link))

            invalid = Path(directory, "invalid.png")
            invalid.write_bytes(b"not-a-png")
            with self.assertRaisesRegex(ValueError, "not a PNG"):
                matlab_bridge.read_captured_png(directory, str(invalid))

            oversized = Path(directory, "oversized.png")
            with oversized.open("wb") as stream:
                stream.write(matlab_bridge.PNG_SIGNATURE)
                stream.truncate(matlab_bridge.MAX_PNG_BYTES + 1)
            with self.assertRaisesRegex(ValueError, "exceeded"):
                matlab_bridge.read_captured_png(directory, str(oversized))

    def test_png_hash_ignores_ancillary_metadata_but_not_pixels(self):
        def chunk(kind, value):
            return struct.pack(">I", len(value)) + kind + value + b"\0\0\0\0"

        signature = b"\x89PNG\r\n\x1a\n"
        first = signature + chunk(b"IHDR", b"header") + chunk(b"tEXt", b"one") + chunk(
            b"IDAT", b"pixels"
        ) + chunk(b"IEND", b"")
        second = signature + chunk(b"IHDR", b"header") + chunk(b"tEXt", b"two") + chunk(
            b"IDAT", b"pixels"
        ) + chunk(b"IEND", b"")
        changed = signature + chunk(b"IHDR", b"header") + chunk(
            b"IDAT", b"different"
        ) + chunk(b"IEND", b"")
        self.assertEqual(
            matlab_bridge.png_content_hash(first), matlab_bridge.png_content_hash(second)
        )
        self.assertNotEqual(
            matlab_bridge.png_content_hash(first), matlab_bridge.png_content_hash(changed)
        )


if __name__ == "__main__":
    unittest.main()
