#!/usr/bin/env python3
"""Scient's framed bridge for one MATLAB Engine session.

The selected MATLAB installation and the Python process hosting its Engine API
are separate identities. The server chooses both before launching this file;
this bridge owns only one MATLAB process and translates its lifecycle, output,
figures, diagnostics, and bounded variable summaries into the shared compute
protocol.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import concurrent.futures
import hashlib
import io
import json
import math
import os
import secrets
import shutil
import signal
import stat
import struct
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, BinaryIO, Optional, TextIO

# Isolated mode intentionally omits the script directory from sys.path. The
# shared framed-protocol module is a staged sibling controlled by Scient.
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from scient_compute_bridge import (
    MAX_CODE,
    MAX_DETAIL,
    MAX_DIAGNOSTIC,
    MAX_FRAME,
    MAX_STREAM_TEXT,
    PROTOCOL_VERSION,
    InboundReader,
    OutboundQueue,
    ProtocolViolation,
    detach_protocol_stream,
    encode_frame,
    truncate_utf8,
)

STARTUP_TIMEOUT = 180
SHUTDOWN_TIMEOUT = 15
INTERRUPT_SETTLE_TIMEOUT = 10
LIVENESS_INTERVAL = 1.0
MAX_VARIABLES = 200
MAX_FIGURES = 50
MAX_SAFE_JSON_INTEGER = 9_007_199_254_740_991
# Matches the shared legacy PNG payload bound (base64 for an 8 MiB image).
MAX_PNG_BASE64 = 11 * 1024 * 1024
MAX_PNG_BYTES = (MAX_PNG_BASE64 // 4) * 3
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

SERVER_MESSAGE_TYPES = {
    "hello",
    "start-kernel",
    "execute",
    "interrupt",
    "inspect-variables",
    "restart",
    "shutdown",
}
REQUEST_ID_TYPES = {"execute", "interrupt", "inspect-variables"}


def png_content_hash(data: bytes) -> str:
    """Hashes pixels/palette while ignoring volatile ancillary metadata."""
    if not data.startswith(PNG_SIGNATURE):
        return hashlib.sha256(data).hexdigest()
    digest = hashlib.sha256()
    offset = 8
    while offset + 12 <= len(data):
        length = struct.unpack(">I", data[offset : offset + 4])[0]
        chunk_end = offset + 12 + length
        if chunk_end > len(data):
            return hashlib.sha256(data).hexdigest()
        chunk_type = data[offset + 4 : offset + 8]
        if chunk_type in {b"IHDR", b"PLTE", b"IDAT", b"IEND"}:
            digest.update(chunk_type)
            digest.update(data[offset + 8 : offset + 8 + length])
        offset = chunk_end
        if chunk_type == b"IEND":
            return digest.hexdigest()
    return hashlib.sha256(data).hexdigest()


def read_captured_png(directory: str, reported_path: str) -> bytes:
    """Reads one bounded regular PNG contained by a server-created directory."""
    if not os.path.isabs(reported_path):
        raise ValueError("MATLAB returned a relative figure path.")
    root = os.path.normcase(os.path.realpath(directory))
    resolved = os.path.normcase(os.path.realpath(reported_path))
    if os.path.dirname(resolved) != root:
        raise ValueError("MATLAB returned a figure outside the capture directory.")

    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(resolved, flags)
    with os.fdopen(descriptor, "rb") as stream:
        metadata = os.fstat(stream.fileno())
        if not stat.S_ISREG(metadata.st_mode):
            raise ValueError("MATLAB figure output is not a regular file.")
        if metadata.st_size > MAX_PNG_BYTES:
            raise ValueError("MATLAB PNG exceeded the retained-image limit.")
        data = stream.read(MAX_PNG_BYTES + 1)
    if len(data) > MAX_PNG_BYTES:
        raise ValueError("MATLAB PNG exceeded the retained-image limit.")
    if not data.startswith(PNG_SIGNATURE):
        raise ValueError("MATLAB figure output is not a PNG.")
    return data


EVAL_HELPER = r"""function scientJson = __SCIENT_FUNCTION__(scientSubmissionPath)
scientPayload = struct('ok', true, 'identifier', '', 'message', '', 'stack', []);
try
    [~, scientSubmissionName] = fileparts(scientSubmissionPath);
    scientResolvedPath = builtin('which', scientSubmissionName);
    if ispc
        scientMatches = strcmpi(scientResolvedPath, scientSubmissionPath);
    else
        scientMatches = strcmp(scientResolvedPath, scientSubmissionPath);
    end
    if ~scientMatches
        error('Scient:SubmissionIdentity', 'Submitted MATLAB source did not resolve to the Scient-owned file.');
    end
    evalin('base', [scientSubmissionName ';']);
catch scientError
    scientPayload.ok = false;
    scientPayload.identifier = scientError.identifier;
    scientPayload.message = scientError.message(1:min(numel(scientError.message), 16384));
    scientPayload.stack = scientError.stack(1:min(numel(scientError.stack), 200));
end
scientJson = jsonencode(scientPayload);
end
"""

VARIABLES_HELPER = r"""function scientJson = __SCIENT_FUNCTION__(scientMaximum)
scientInfo = evalin('base', 'whos');
scientCount = min(numel(scientInfo), scientMaximum);
scientVariables = repmat(struct('name', '', 'typeName', '', 'shape', '', 'size', 0, 'preview', ''), 1, scientCount);
for scientIndex = 1:scientCount
    scientEntry = scientInfo(scientIndex);
    scientVariables(scientIndex).name = scientEntry.name;
    scientVariables(scientIndex).typeName = scientEntry.class;
    scientVariables(scientIndex).shape = strjoin(string(scientEntry.size), ' x ');
    scientVariables(scientIndex).size = prod(double(scientEntry.size));
    try
        scientValue = evalin('base', scientEntry.name);
        if (isnumeric(scientValue) || islogical(scientValue)) && isscalar(scientValue)
            scientVariables(scientIndex).preview = mat2str(scientValue);
        elseif ischar(scientValue)
            scientVariables(scientIndex).preview = scientValue(1:min(numel(scientValue), 160));
        elseif isstring(scientValue) && isscalar(scientValue)
            scientText = char(scientValue);
            scientVariables(scientIndex).preview = scientText(1:min(numel(scientText), 160));
        end
    catch
        % A preview is optional; metadata from whos remains authoritative.
    end
end
scientJson = jsonencode(struct('variables', scientVariables, 'truncated', numel(scientInfo) > scientCount));
end
"""

FIGURES_HELPER = r"""function scientJson = __SCIENT_FUNCTION__(scientDirectory, scientMaximum)
scientFiles = repmat(struct('key', '', 'path', '', 'warning', ''), 1, 0);
try
    drawnow;
    scientFigures = findall(groot, 'Type', 'figure');
    try
        [~, scientOrder] = sort(arrayfun(@(scientFigure) double(scientFigure.Number), scientFigures));
        scientFigures = scientFigures(scientOrder);
    catch
        % Preserve findall order when Number is unavailable.
    end
    scientCount = min(numel(scientFigures), scientMaximum);
    for scientIndex = 1:scientCount
        scientFinal = fullfile(scientDirectory, sprintf('figure-%03d.png', scientIndex));
        scientTemporary = fullfile(scientDirectory, sprintf('figure-%03d.partial.png', scientIndex));
        scientWarning = '';
        try
            try
                exportgraphics(scientFigures(scientIndex), scientTemporary, 'Resolution', 144);
            catch
                print(scientFigures(scientIndex), scientTemporary, '-dpng', '-r144');
            end
            movefile(scientTemporary, scientFinal, 'f');
        catch scientCaptureError
            if isfile(scientTemporary)
                delete(scientTemporary);
            end
            scientFinal = '';
            scientWarning = scientCaptureError.message(1:min(numel(scientCaptureError.message), 4096));
        end
        scientFiles(end + 1) = struct( ...
            'key', sprintf('%.17g', double(scientFigures(scientIndex))), ...
            'path', scientFinal, 'warning', scientWarning); %#ok<AGROW>
    end
    scientTruncated = numel(scientFigures) > scientCount;
catch scientCaptureError
    scientMessage = scientCaptureError.message(1:min(numel(scientCaptureError.message), 4096));
    scientFiles(end + 1) = struct('key', '', 'path', '', 'warning', scientMessage);
    scientTruncated = false;
end
scientJson = jsonencode(struct('figures', scientFiles, 'truncated', scientTruncated));
end
"""


class ProtocolStringIO(io.StringIO):
    """A StringIO accepted by MATLAB Engine that forwards text to the loop."""

    def __init__(self, bridge: "MatlabEngineBridge", stream: str, request_id: str) -> None:
        super().__init__()
        self._bridge = bridge
        self._stream = stream
        self._request_id = request_id

    def write(self, value: str) -> int:
        text = value if isinstance(value, str) else str(value)
        self._bridge.forward_stream_from_thread(self._stream, text, self._request_id)
        return len(text)

    def getvalue(self) -> str:
        return ""


class MatlabEngineBridge:
    def __init__(
        self,
        stdin_stream: BinaryIO,
        stdout_stream: BinaryIO,
        engine_directory: str,
        expected_matlab_root: str,
        stderr_stream: Optional[TextIO] = None,
    ) -> None:
        self._stdin = stdin_stream
        self._stdout = stdout_stream
        self._stderr = stderr_stream or sys.stderr
        self._engine_directory = engine_directory
        self._expected_matlab_root = os.path.realpath(expected_matlab_root)
        self._outbound = OutboundQueue()
        self._session_id: Optional[str] = None
        self._generation = 1
        self._peer_frame_limit = MAX_FRAME
        self._server_sequence = 0
        self._bridge_sequence = 0
        self._handshake_complete = False
        self._capabilities = ["execute", "interrupt", "restart", "shutdown", "variables"]
        self._running = True
        self._stop = asyncio.Event()
        self._write_lock = asyncio.Lock()
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._engine_module: Any = None
        self._engine: Any = None
        self._working_directory = os.getcwd()
        self._helper_directory: Optional[str] = None
        self._helper_names: dict[str, str] = {}
        self._active_request_id: Optional[str] = None
        self._active_future: Any = None
        self._execution_task: Optional[asyncio.Task[None]] = None
        self._dispatch_task: Optional[asyncio.Task[None]] = None
        self._monitor_task: Optional[asyncio.Task[None]] = None
        self._transitioning = False
        self._figure_hashes: dict[str, str] = {}

    def _diag(self, message: str) -> None:
        bounded, _ = truncate_utf8(message, MAX_DIAGNOSTIC)
        with contextlib.suppress(Exception):
            self._stderr.write(bounded + "\n")
            self._stderr.flush()

    def _send(
        self,
        msg_type: str,
        payload: dict[str, Any],
        request_id: Optional[str] = None,
    ) -> None:
        if self._session_id is None:
            raise ProtocolViolation("Cannot send a message before session identity is known.")
        frame = encode_frame(
            {
                "protocolVersion": PROTOCOL_VERSION,
                "type": msg_type,
                "sessionId": self._session_id,
                "generation": self._generation,
                "requestId": request_id,
                "sequence": self._bridge_sequence,
                "payload": payload,
            },
            self._peer_frame_limit,
        )
        self._outbound.put(frame)
        self._bridge_sequence += 1

    def _send_warning(
        self, code: str, detail: Optional[str], request_id: Optional[str] = None
    ) -> None:
        bounded = None if detail is None else truncate_utf8(detail, MAX_DETAIL)[0]
        self._send("warning", {"code": code, "detail": bounded}, request_id)

    def _send_fatal(self, reason: str) -> None:
        bounded, _ = truncate_utf8(reason, MAX_DETAIL)
        if self._session_id is None:
            self._diag(f"Fatal before session identity was known: {bounded}")
            return
        with contextlib.suppress(Exception):
            self._send("fatal", {"reason": bounded})

    async def _flush(self) -> None:
        async with self._write_lock:
            frames = self._outbound.drain()
            if not frames:
                return
            try:
                await asyncio.to_thread(self._write_frames, b"".join(frames))
            except OSError as error:
                self._diag(f"Outbound write failed: {error}")
                self._request_stop()

    def _write_frames(self, data: bytes) -> None:
        self._stdout.write(data)
        self._stdout.flush()

    def _request_stop(self) -> None:
        self._running = False
        self._stop.set()
        task = self._dispatch_task
        if task is not None and task is not asyncio.current_task():
            task.cancel()

    def forward_stream_from_thread(self, stream: str, value: str, request_id: str) -> None:
        loop = self._loop
        if loop is None or not self._running or value == "":
            return

        async def forward() -> None:
            remaining = value
            while remaining:
                chunk, truncated = truncate_utf8(remaining, MAX_STREAM_TEXT)
                if chunk == "":
                    break
                self._send("stream", {"stream": stream, "text": chunk}, request_id)
                if self._outbound.pressured():
                    await self._flush()
                remaining = remaining[len(chunk) :]
                if not truncated:
                    break
            await self._flush()

        # Engine invokes this from its execution worker. Back-pressure that
        # worker instead of accumulating unbounded event-loop callbacks.
        try:
            forwarded = asyncio.run_coroutine_threadsafe(forward(), loop)
            while self._running:
                try:
                    forwarded.result(timeout=1)
                    return
                except concurrent.futures.TimeoutError:
                    continue
            forwarded.cancel()
        except (RuntimeError, concurrent.futures.CancelledError):
            return

    def _validate_message(self, message: dict[str, Any]) -> None:
        if message.get("protocolVersion") != PROTOCOL_VERSION:
            raise ProtocolViolation("Unsupported protocol version.")
        msg_type = message.get("type")
        if msg_type not in SERVER_MESSAGE_TYPES:
            raise ProtocolViolation(f"Unknown command type: {msg_type}")
        if message.get("sequence") != self._server_sequence:
            raise ProtocolViolation(
                f"Expected server sequence {self._server_sequence}, received {message.get('sequence')}."
            )
        self._server_sequence += 1
        request_id = message.get("requestId")
        if msg_type in REQUEST_ID_TYPES:
            if not isinstance(request_id, str) or not request_id:
                raise ProtocolViolation(f"{msg_type} requires a requestId.")
        elif request_id is not None:
            raise ProtocolViolation(f"{msg_type} must not carry a requestId.")
        session_id = message.get("sessionId")
        generation = message.get("generation")
        if not isinstance(session_id, str) or not session_id:
            raise ProtocolViolation("sessionId must be a non-empty string.")
        if not isinstance(generation, int) or generation < 1:
            raise ProtocolViolation("generation must be a positive integer.")
        if msg_type == "hello":
            if self._handshake_complete:
                raise ProtocolViolation("hello was already received.")
            return
        if not self._handshake_complete or self._session_id is None:
            raise ProtocolViolation("hello must be the first command.")
        if session_id != self._session_id:
            raise ProtocolViolation("Session identity changed after handshake.")
        if generation != self._generation:
            raise ProtocolViolation(
                f"Expected generation {self._generation}, received {generation}."
            )
        payload = message.get("payload")
        if not isinstance(payload, dict):
            raise ProtocolViolation("payload must be an object.")
        if msg_type == "restart" and payload.get("nextGeneration") != self._generation + 1:
            raise ProtocolViolation(f"Restart must advance generation to {self._generation + 1}.")

    def _handle_hello(self, message: dict[str, Any]) -> None:
        payload = message.get("payload")
        if not isinstance(payload, dict):
            raise ProtocolViolation("hello payload must be an object.")
        owner_token = payload.get("ownerToken")
        frame_limit = payload.get("frameLimit")
        required = payload.get("requiredCapabilities")
        if not isinstance(owner_token, str) or not owner_token:
            raise ProtocolViolation("hello ownerToken must be a non-empty string.")
        if not isinstance(frame_limit, int) or frame_limit <= 0:
            raise ProtocolViolation("hello frameLimit must be positive.")
        if not isinstance(required, list) or not all(isinstance(item, str) for item in required):
            raise ProtocolViolation("hello requiredCapabilities must be a string array.")
        self._session_id = message["sessionId"]
        self._generation = message["generation"]
        self._peer_frame_limit = min(frame_limit, MAX_FRAME)
        self._handshake_complete = True
        missing = set(required) - set(self._capabilities)
        if missing:
            self._send_fatal(f"Missing capabilities: {','.join(sorted(missing))}")
            self._request_stop()
            return
        self._send(
            "hello-ack",
            {
                "ownerToken": owner_token,
                "pid": os.getpid(),
                "platform": sys.platform,
                "capabilities": self._capabilities,
            },
        )

    def _write_helpers(self) -> str:
        if self._helper_directory is not None:
            return self._helper_directory
        directory = tempfile.mkdtemp(prefix="scient-matlab-engine-")
        token = secrets.token_hex(16)
        helpers = {
            "eval": (f"scient_compute_eval_{token}", EVAL_HELPER),
            "variables": (f"scient_compute_variables_{token}", VARIABLES_HELPER),
            "figures": (f"scient_compute_figures_{token}", FIGURES_HELPER),
        }
        for kind, (name, source) in helpers.items():
            Path(directory, f"{name}.m").write_text(
                source.replace("__SCIENT_FUNCTION__", name), encoding="utf-8"
            )
            self._helper_names[kind] = name
        self._helper_directory = directory
        return directory

    async def _trusted_helper(self, kind: str) -> Any:
        directory = self._write_helpers()
        name = self._helper_names.get(kind)
        if name is None or self._engine is None:
            raise RuntimeError(f"MATLAB helper '{kind}' is unavailable.")
        resolved = str(
            await asyncio.to_thread(self._engine.builtin, "which", name, nargout=1)
        )
        expected = os.path.join(directory, f"{name}.m")
        if os.path.normcase(os.path.realpath(resolved)) != os.path.normcase(
            os.path.realpath(expected)
        ):
            raise RuntimeError(f"MATLAB helper '{kind}' did not resolve to Scient-owned code.")
        return getattr(self._engine, name)

    def _load_engine_module(self) -> Any:
        if self._engine_module is not None:
            return self._engine_module
        if self._engine_directory not in sys.path:
            sys.path.insert(0, self._engine_directory)
        import matlab.engine  # type: ignore[import-not-found]

        expected_engine_directory = os.path.join(
            self._expected_matlab_root, "extern", "engines", "python", "dist"
        )
        selected = os.path.normcase(os.path.realpath(self._engine_directory))
        module = os.path.normcase(os.path.realpath(matlab.engine.__file__))
        if os.path.commonpath([selected, module]) != selected:
            raise RuntimeError("The Engine host imported a different MATLAB package.")
        if selected != os.path.normcase(os.path.realpath(expected_engine_directory)):
            # A Scient-owned helper is built using the selected MATLAB release's
            # setup.py. Its vendor-generated metadata must still name that root.
            with open(os.path.join(os.path.dirname(module), "_arch.txt"), encoding="utf-8") as stream:
                arch = stream.read().splitlines()
            root = os.path.dirname(os.path.dirname(arch[1])) if len(arch) == 4 else ""
            if not root or os.path.normcase(os.path.realpath(root)) != os.path.normcase(os.path.realpath(self._expected_matlab_root)):
                raise RuntimeError("MATLAB Engine directory does not belong to the selected MATLAB installation.")
        self._engine_module = matlab.engine
        return matlab.engine

    async def _start_engine(self, working_directory: str) -> tuple[str, str]:
        if self._engine is not None:
            raise ProtocolViolation("A MATLAB runtime is already running.")
        if not os.path.isabs(working_directory):
            raise ProtocolViolation("start-kernel workingDirectory must be absolute.")
        module = self._load_engine_module()
        future = module.start_matlab("-nodesktop -nosplash -noFigureWindows", background=True)
        try:
            # Use the Engine's native timeout: cancelling an asyncio wrapper
            # alone leaves its worker waiting and may start an unowned MATLAB later.
            self._engine = await asyncio.to_thread(future.result, timeout=STARTUP_TIMEOUT)
        except BaseException:
            with contextlib.suppress(Exception):
                await asyncio.to_thread(future.cancel)
            raise
        actual_root = str(await asyncio.to_thread(self._engine.matlabroot, nargout=1))
        if os.path.normcase(os.path.realpath(actual_root)) != os.path.normcase(
            os.path.realpath(self._expected_matlab_root)
        ):
            raise RuntimeError("MATLAB Engine started a different installation than the selected runtime.")
        helper_directory = self._write_helpers()
        await asyncio.to_thread(self._engine.addpath, helper_directory, nargout=0)
        await asyncio.to_thread(self._engine.cd, working_directory, nargout=0)
        self._working_directory = working_directory
        release, version = await asyncio.gather(
            asyncio.to_thread(self._engine.version, "-release", nargout=1),
            asyncio.to_thread(self._engine.version, nargout=1),
        )
        return str(release), str(version)

    async def _handle_start(self, payload: dict[str, Any]) -> None:
        working_directory = payload.get("workingDirectory") or os.getcwd()
        if not isinstance(working_directory, str):
            raise ProtocolViolation("start-kernel workingDirectory must be a string.")
        release, version = await self._start_engine(working_directory)
        self._send(
            "kernel-ready",
            {
                "kernelPid": None,
                "languageId": "matlab",
                "languageVersion": release or version or "unknown",
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": self._capabilities,
            },
        )
        self._ensure_monitor()

    def _ensure_monitor(self) -> None:
        if self._monitor_task is None or self._monitor_task.done():
            self._monitor_task = asyncio.create_task(self._monitor_engine())

    async def _monitor_engine(self) -> None:
        try:
            while self._running:
                await asyncio.sleep(LIVENESS_INTERVAL)
                engine = self._engine
                # Engine liveness may cross a native IPC boundary. Keep it off
                # the protocol loop so a slow check cannot block output,
                # interruption, or parent-disconnect handling.
                if engine is not None and not await asyncio.to_thread(
                    engine._check_matlab
                ):
                    await self._fail_fatal("The MATLAB Engine process exited.")
                    return
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - liveness failure ends the session
            await self._fail_fatal(f"MATLAB Engine liveness check failed: {error}")

    async def _fail_fatal(self, reason: str) -> None:
        self._send_fatal(reason)
        await self._flush()
        self._request_stop()

    async def _handle_execute(self, payload: dict[str, Any], request_id: str) -> None:
        if self._transitioning:
            raise ProtocolViolation("MATLAB is changing generation.")
        if self._engine is None:
            raise ProtocolViolation("MATLAB is not running.")
        if self._active_request_id is not None:
            raise ProtocolViolation("An execution is already active.")
        code = payload.get("code")
        if not isinstance(code, str):
            raise ProtocolViolation("execute code must be a string.")
        if len(code.encode("utf-8")) > MAX_CODE:
            raise ProtocolViolation(f"execute code exceeds {MAX_CODE} bytes.")
        evaluate = await self._trusted_helper("eval")
        self._active_request_id = request_id
        self._send("accepted", {}, request_id)
        self._execution_task = asyncio.create_task(self._execute(code, request_id, evaluate))

    async def _execute(self, code: str, request_id: str, evaluate: Any) -> None:
        outcome = "succeeded"
        descriptor, submission_path = tempfile.mkstemp(
            prefix="scient_submission_", suffix=".m", dir=self._write_helpers()
        )
        os.close(descriptor)
        submission_path = os.path.realpath(submission_path)
        Path(submission_path).write_text(code, encoding="utf-8")
        try:
            stdout = ProtocolStringIO(self, "stdout", request_id)
            stderr = ProtocolStringIO(self, "stderr", request_id)
            future = evaluate(
                submission_path,
                nargout=1,
                stdout=stdout,
                stderr=stderr,
                background=True,
            )
            self._active_future = future
            raw = await asyncio.to_thread(future.result)
            payload = json.loads(str(raw))
            if not isinstance(payload, dict):
                raise RuntimeError("MATLAB returned an invalid execution receipt.")
            if not bool(payload.get("ok")):
                outcome = "failed"
                stack = payload.get("stack")
                if isinstance(stack, dict):
                    stack = [stack]
                traceback = []
                if isinstance(stack, list):
                    for frame in stack[:200]:
                        if not isinstance(frame, dict):
                            continue
                        file = str(frame.get("file", ""))
                        line = frame.get("line", 0)
                        name = str(frame.get("name", ""))
                        normalized_file = (
                            "<submitted>"
                            if os.path.realpath(file) == os.path.realpath(submission_path)
                            else file
                        )
                        traceback.append(f"{normalized_file}:{line}:{name}")
                self._send(
                    "error",
                    {
                        "name": truncate_utf8(
                            payload.get("identifier") or "MATLAB:ExecutionError", 256
                        )[0],
                        "value": truncate_utf8(payload.get("message", ""), 16 * 1024)[0],
                        "traceback": [truncate_utf8(line, 4096)[0] for line in traceback],
                    },
                    request_id,
                )
            await self._capture_figures(request_id)
        except asyncio.CancelledError:
            outcome = "cancelled"
        except Exception as error:  # noqa: BLE001 - classified below
            name = error.__class__.__name__
            if name in {"CancelledError", "InterruptedError"}:
                outcome = "cancelled"
            elif name == "RejectedExecutionError":
                await self._fail_fatal(f"MATLAB Engine was lost while running code: {error}")
                return
            else:
                outcome = "failed"
                self._send(
                    "error",
                    {
                        "name": truncate_utf8(name or "MATLAB:BridgeError", 256)[0],
                        "value": truncate_utf8(str(error), 16 * 1024)[0],
                        "traceback": [],
                    },
                    request_id,
                )
        finally:
            with contextlib.suppress(OSError):
                os.unlink(submission_path)
            self._active_future = None
            if self._active_request_id == request_id:
                self._active_request_id = None
                self._send("execution-complete", {"outcome": outcome}, request_id)
                await self._flush()
            self._execution_task = None

    async def _capture_figures(self, request_id: str) -> None:
        directory = tempfile.mkdtemp(prefix="scient-matlab-figures-")
        try:
            capture_figures = await self._trusted_helper("figures")
            raw = await asyncio.to_thread(
                capture_figures,
                directory,
                float(MAX_FIGURES),
                nargout=1,
            )
            payload = json.loads(str(raw))
            figures = payload.get("figures", []) if isinstance(payload, dict) else []
            if isinstance(figures, dict):
                figures = [figures]
            observed_keys: set[str] = set()
            for entry in figures[:MAX_FIGURES] if isinstance(figures, list) else []:
                if not isinstance(entry, dict):
                    continue
                warning = entry.get("warning")
                if isinstance(warning, str) and warning:
                    self._send_warning("runtime-warning", warning, request_id)
                path = entry.get("path")
                if not isinstance(path, str) or not path:
                    continue
                try:
                    data = read_captured_png(directory, path)
                except (OSError, ValueError) as error:
                    self._send_warning("runtime-warning", str(error), request_id)
                    continue
                key = str(entry.get("key", ""))
                if key:
                    observed_keys.add(key)
                    digest = png_content_hash(data)
                    if self._figure_hashes.get(key) == digest:
                        continue
                    self._figure_hashes[key] = digest
                encoded = base64.b64encode(data).decode("ascii")
                if len(encoded) > MAX_PNG_BASE64:
                    self._send_warning("output-truncated", "PNG exceeded limit.", request_id)
                    continue
                self._send("display", {"mediaType": "image/png", "data": encoded}, request_id)
            self._figure_hashes = {
                key: digest for key, digest in self._figure_hashes.items() if key in observed_keys
            }
            if isinstance(payload, dict) and bool(payload.get("truncated")):
                self._send_warning(
                    "output-truncated",
                    f"Only the first {MAX_FIGURES} MATLAB figures were retained.",
                    request_id,
                )
        except Exception as error:  # noqa: BLE001 - figure capture must not fail execution
            self._send_warning(
                "runtime-warning", f"MATLAB figure capture failed: {error}", request_id
            )
        finally:
            shutil.rmtree(directory, ignore_errors=True)

    async def _handle_interrupt(self, request_id: str) -> None:
        if self._active_request_id is None:
            result = "terminal"
        elif self._active_request_id != request_id or self._active_future is None:
            result = "rejected"
        else:
            try:
                delivered = bool(await asyncio.to_thread(self._active_future.cancel))
                if not delivered:
                    result = "terminal" if self._active_request_id is None else "rejected"
                else:
                    deadline = time.monotonic() + INTERRUPT_SETTLE_TIMEOUT
                    while self._active_request_id == request_id and time.monotonic() < deadline:
                        await asyncio.sleep(0.02)
                    result = "interrupted" if self._active_request_id is None else "timeout"
            except Exception as error:  # noqa: BLE001 - rejected signal is not session loss
                self._diag(f"MATLAB interrupt failed: {error}")
                result = "rejected"
        self._send("interrupt-result", {"result": result}, request_id)

    async def _handle_variables(self, request_id: str) -> None:
        if self._engine is None or self._active_request_id is not None or self._transitioning:
            self._send(
                "variables",
                {"variables": [], "truncated": False, "error": "MATLAB is busy."},
                request_id,
            )
            return
        try:
            inspect_variables = await self._trusted_helper("variables")
            raw = await asyncio.to_thread(
                inspect_variables, float(MAX_VARIABLES), nargout=1
            )
            payload = json.loads(str(raw))
            raw_variables = payload.get("variables", []) if isinstance(payload, dict) else []
            if isinstance(raw_variables, dict):
                raw_variables = [raw_variables]
            variables = []
            for item in raw_variables[:MAX_VARIABLES] if isinstance(raw_variables, list) else []:
                if not isinstance(item, dict):
                    continue
                raw_size = item.get("size")
                size = (
                    min(int(raw_size), MAX_SAFE_JSON_INTEGER)
                    if isinstance(raw_size, (int, float))
                    and math.isfinite(raw_size)
                    and raw_size >= 0
                    else None
                )
                variables.append(
                    {
                        "name": truncate_utf8(item.get("name", ""), 256)[0],
                        "typeName": truncate_utf8(item.get("typeName", ""), 256)[0],
                        "shape": truncate_utf8(item.get("shape", ""), 4096)[0] or None,
                        "size": size,
                        "preview": truncate_utf8(item.get("preview", ""), 4096)[0] or None,
                    }
                )
            self._send(
                "variables",
                {
                    "variables": variables,
                    "truncated": bool(payload.get("truncated"))
                    or len(raw_variables) > MAX_VARIABLES,
                    "error": None,
                },
                request_id,
            )
        except Exception as error:  # noqa: BLE001 - inspection is optional
            self._send(
                "variables",
                {
                    "variables": [],
                    "truncated": False,
                    "error": truncate_utf8(str(error), MAX_DETAIL)[0],
                },
                request_id,
            )

    async def _close_engine(self) -> None:
        engine = self._engine
        self._engine = None
        if engine is None:
            return
        try:
            await asyncio.wait_for(asyncio.to_thread(engine.quit), timeout=SHUTDOWN_TIMEOUT)
        except Exception as error:
            # A restart may never place a replacement beside an engine whose
            # exit is uncertain. Propagating ends the bridge; its supervised
            # process group then remains the final cleanup authority.
            raise RuntimeError("MATLAB Engine did not stop cleanly.") from error

    async def _cancel_active(self) -> None:
        future = self._active_future
        task = self._execution_task
        if future is not None:
            with contextlib.suppress(Exception):
                await asyncio.to_thread(future.cancel)
        if task is not None and task is not asyncio.current_task():
            try:
                await asyncio.wait_for(asyncio.shield(task), timeout=INTERRUPT_SETTLE_TIMEOUT)
            except asyncio.TimeoutError:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task

    async def _restart(self, next_generation: int) -> None:
        self._transitioning = True
        try:
            await self._cancel_active()
            await self._close_engine()
            self._figure_hashes.clear()
            await self._start_engine(self._working_directory)
            self._generation = next_generation
            self._send("restarted", {"kernelPid": None})
        finally:
            self._transitioning = False

    async def _shutdown(self) -> None:
        self._transitioning = True
        try:
            await self._cancel_active()
            await self._close_engine()
            self._send("shutdown-complete", {})
        finally:
            self._transitioning = False

    async def _dispatch(self, message: dict[str, Any]) -> None:
        self._validate_message(message)
        msg_type = message["type"]
        payload = message.get("payload", {})
        request_id = message.get("requestId")
        if msg_type == "hello":
            self._handle_hello(message)
        elif msg_type == "start-kernel":
            await self._handle_start(payload)
        elif msg_type == "execute":
            await self._handle_execute(payload, request_id)
        elif msg_type == "interrupt":
            await self._handle_interrupt(request_id)
        elif msg_type == "inspect-variables":
            await self._handle_variables(request_id)
        elif msg_type == "restart":
            await self._restart(payload["nextGeneration"])
        elif msg_type == "shutdown":
            await self._shutdown()
            self._request_stop()
        await self._flush()

    def _install_signal_handlers(self, loop: asyncio.AbstractEventLoop) -> None:
        for name in ("SIGTERM", "SIGINT", "SIGHUP"):
            handled = getattr(signal, name, None)
            if handled is None:
                continue
            with contextlib.suppress(NotImplementedError, RuntimeError, ValueError):
                loop.add_signal_handler(handled, self._request_stop)

    async def run(self) -> int:
        self._loop = asyncio.get_running_loop()
        self._install_signal_handlers(self._loop)
        reader = InboundReader(self._stdin, self._loop, self._request_stop)
        reader.start()
        stopped = asyncio.ensure_future(self._stop.wait())
        try:
            while self._running:
                pending = asyncio.ensure_future(reader.next())
                done, _ = await asyncio.wait(
                    {pending, stopped}, return_when=asyncio.FIRST_COMPLETED
                )
                if pending not in done:
                    pending.cancel()
                    break
                kind, value = pending.result()
                if kind == "eof":
                    self._diag("stdin EOF: parent disconnected.")
                    break
                if kind == "error":
                    self._send_fatal(f"Protocol error: {value}")
                    await self._flush()
                    break
                try:
                    self._dispatch_task = asyncio.create_task(self._dispatch(value))
                    await self._dispatch_task
                except asyncio.CancelledError:
                    if self._running:
                        raise
                    break
                except Exception as error:  # noqa: BLE001 - fatal protocol/runtime boundary
                    self._send_fatal(f"MATLAB bridge failed: {error}")
                    await self._flush()
                    break
                finally:
                    self._dispatch_task = None
        finally:
            stopped.cancel()
            if self._monitor_task is not None:
                self._monitor_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await self._monitor_task
            try:
                await self._cancel_active()
                await self._close_engine()
            finally:
                await self._flush()
                self._outbound.close()
                if self._helper_directory is not None:
                    shutil.rmtree(self._helper_directory, ignore_errors=True)
        return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--engine-directory", required=True)
    parser.add_argument("--matlab-root", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    outbound = detach_protocol_stream()
    bridge = MatlabEngineBridge(
        sys.stdin.buffer,
        outbound,
        args.engine_directory,
        args.matlab_root,
        sys.stderr,
    )
    return asyncio.run(bridge.run())


if __name__ == "__main__":
    try:
        exit_code = main()
    except BaseException:  # noqa: BLE001 - preserve a usable bridge exit code
        sys.excepthook(*sys.exc_info())
        exit_code = 1
    sys.stderr.flush()
    os._exit(exit_code)
