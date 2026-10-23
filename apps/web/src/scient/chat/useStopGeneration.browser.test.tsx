import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { useLayoutEffect } from "react";

import { expect, it, vi } from "vite-plus/test";
import {
  MessageId,
  NodeId,
  RunAttemptId,
  RunId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { showStreamedAnswersNow } from "~/components/chat/useStreamingBlockEntrance";
import { useStopGeneration } from "./useStopGeneration";

vi.mock("~/components/chat/useStreamingBlockEntrance", () => ({
  showStreamedAnswersNow: vi.fn(),
}));

function pendingResponse() {
  let resolve!: (accepted: boolean) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<boolean>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const now = DateTime.makeUnsafe("2026-10-12T10:00:00Z");
function projection() {
  const base = makeThreadProjectionFixture();
  return {
    ...base,
    runs: [
      {
        id: RunId.make("stop-run"),
        threadId: base.thread.id,
        ordinal: 1,
        providerInstanceId: base.thread.providerInstanceId,
        modelSelection: base.thread.modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("question"),
        rootNodeId: NodeId.make("stop-root"),
        activeAttemptId: RunAttemptId.make("stop-attempt"),
        status: "running" as const,
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
  };
}

function Probe({ _fixture }: { _fixture: _Fixture }) {
  const current = useStopGeneration(_fixture.input);
  useLayoutEffect(() => {
    _fixture.publishController(current);
  });
  return (
    <button onClick={() => void current.onInterrupt()}>
      {current.isStopping ? "Stopping…" : "Stop"}
    </button>
  );
}
async function render(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.rerender(<Probe _fixture={_fixture} />));
}

async function _setupFixture0(_fixture: _Fixture) {
  _fixture.container = document.createElement("div");
  document.body.append(_fixture.container);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.container, router: false }),
  );
  _fixture.input = {
    threadKey: "local:thread-a",
    runId: RunId.make("stop-run"),
    canInterrupt: true,
    projection: projection(),
    operation: vi.fn(async () => true),
  };
  await render(_fixture);
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.unmount());
  _fixture.container.remove();
  vi.unstubAllGlobals();
}

it("acknowledges immediately, deduplicates in-flight clicks, and waits for server settlement", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const response = pendingResponse();
  _fixture.input = { ..._fixture.input, operation: vi.fn(() => response.promise) };
  await render(_fixture);
  let completion!: Promise<void>;
  await act(() => {
    completion = _fixture.controller.onInterrupt();
  });
  expect(_fixture.container.textContent).toBe("Stopping…");
  await act(() => _fixture.controller.onInterrupt());
  expect(_fixture.input.operation).toHaveBeenCalledTimes(1);
  await act(async () => {
    response.resolve(true);
    await completion;
  });
  expect(_fixture.controller.isStopping).toBe(true);
  _fixture.input = { ..._fixture.input, canInterrupt: false };
  await render(_fixture);
  expect(_fixture.controller.isStopping).toBe(false);
  _fixture.input = { ..._fixture.input, canInterrupt: true };
  await render(_fixture);
  expect(_fixture.controller.isStopping).toBe(false);
});

it("shows what has arrived at once when Stop is pressed", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  vi.mocked(showStreamedAnswersNow).mockClear();
  await act(() => _fixture.controller.onInterrupt());
  expect(showStreamedAnswersNow).toHaveBeenCalledTimes(1);
});

it("clears a rejected command and keeps Stop available for retry", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  _fixture.input = { ..._fixture.input, operation: vi.fn(async () => false) };
  await render(_fixture);
  await act(() => _fixture.controller.onInterrupt());
  expect(_fixture.controller.isStopping).toBe(false);
  await act(() => _fixture.controller.onInterrupt());
  expect(_fixture.input.operation).toHaveBeenCalledTimes(2);
});

it("allows another Stop after acknowledgement when native cancellation still needs a retry", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await act(() => _fixture.controller.onInterrupt());
  expect(_fixture.controller.isStopping).toBe(true);
  await act(() => _fixture.controller.onInterrupt());
  expect(_fixture.input.operation).toHaveBeenCalledTimes(2);
});

it("a late failed response cannot clear a different conversation's acknowledgement", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const first = pendingResponse();
  const second = pendingResponse();
  _fixture.input = { ..._fixture.input, operation: vi.fn(() => first.promise) };
  await render(_fixture);
  let a!: Promise<void>;
  await act(() => {
    a = _fixture.controller.onInterrupt();
  });
  _fixture.input = {
    ..._fixture.input,
    threadKey: "remote:thread-b",
    operation: vi.fn(() => second.promise),
  };
  await render(_fixture);
  expect(_fixture.controller.isStopping).toBe(false);
  let b!: Promise<void>;
  await act(() => {
    b = _fixture.controller.onInterrupt();
  });
  await act(async () => {
    first.resolve(false);
    await a;
  });
  expect(_fixture.controller.isStopping).toBe(true);
  await act(async () => {
    second.resolve(true);
    await b;
  });
  expect(_fixture.controller.isStopping).toBe(true);
});

it("a late failure cannot clear or unlock a newer request after returning to the same conversation", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const first = pendingResponse();
  const other = pendingResponse();
  const latest = pendingResponse();
  _fixture.input = { ..._fixture.input, operation: () => first.promise };
  await render(_fixture);
  let a!: Promise<void>;
  await act(() => {
    a = _fixture.controller.onInterrupt();
  });
  _fixture.input = {
    ..._fixture.input,
    threadKey: "remote:thread-b",
    operation: () => other.promise,
  };
  await render(_fixture);
  let b!: Promise<void>;
  await act(() => {
    b = _fixture.controller.onInterrupt();
  });
  const operation = vi.fn(() => latest.promise);
  _fixture.input = { ..._fixture.input, threadKey: "local:thread-a", operation };
  await render(_fixture);
  let returned!: Promise<void>;
  await act(() => {
    returned = _fixture.controller.onInterrupt();
  });
  await act(async () => {
    first.resolve(false);
    await a;
  });
  const acknowledged = _fixture.controller.isStopping;
  let repeated!: Promise<void>;
  await act(() => {
    repeated = _fixture.controller.onInterrupt();
  });
  const calls = operation.mock.calls.length;
  await act(async () => {
    other.resolve(true);
    latest.resolve(true);
    await Promise.all([b, returned, repeated]);
  });
  expect(acknowledged).toBe(true);
  expect(calls).toBe(1);
});

it("does not carry acknowledgement to a replacement attempt in the same run", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await act(() => _fixture.controller.onInterrupt());
  const current = projection();
  _fixture.input = {
    ..._fixture.input,
    projection: {
      ...current,
      runs: [
        {
          ...current.runs[0]!,
          activeAttemptId: RunAttemptId.make("replacement-attempt"),
          rootNodeId: NodeId.make("replacement-root"),
        },
      ],
    },
  };
  await render(_fixture);
  expect(_fixture.controller.isStopping).toBe(false);
});

it("does not revive Stopping when the run finishes before the command responds", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const response = pendingResponse();
  _fixture.input = { ..._fixture.input, operation: () => response.promise };
  await render(_fixture);
  let completion!: Promise<void>;
  await act(() => {
    completion = _fixture.controller.onInterrupt();
  });
  _fixture.input = { ..._fixture.input, canInterrupt: false };
  await render(_fixture);
  await act(async () => {
    response.resolve(true);
    await completion;
  });
  expect(_fixture.controller.isStopping).toBe(false);
});

it("reads a durable Stop after remount and clears it once its result is recorded", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const base = projection();
  const request: OrchestrationV2TurnItem = {
    id: TurnItemId.make("stop-request"),
    threadId: base.thread.id,
    runId: base.runs[0]!.id,
    nodeId: base.runs[0]!.rootNodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    type: "run_interrupt_request",
    status: "completed",
    title: "Interrupt requested",
    message: "Stop requested",
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  };
  _fixture.input = { ..._fixture.input, projection: { ...base, turnItems: [request] } };
  await render(_fixture);
  expect(_fixture.controller.isStopping).toBe(true);
  const result: OrchestrationV2TurnItem = {
    ...request,
    id: TurnItemId.make("stop-result"),
    ordinal: 2,
    type: "run_interrupt_result",
    parentItemId: request.id,
    status: "interrupted",
    title: "Interrupted",
  };
  _fixture.input = { ..._fixture.input, projection: { ...base, turnItems: [request, result] } };
  await render(_fixture);
  expect(_fixture.controller.isStopping).toBe(false);
  _fixture.input = {
    ..._fixture.input,
    projection: { ...base, turnItems: [{ ...request, nodeId: NodeId.make("old-root") }] },
  };
  await render(_fixture);
  expect(_fixture.controller.isStopping).toBe(false);
});

it("clears acknowledgement and preserves an unexpected command rejection", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const response = pendingResponse();
  _fixture.input = { ..._fixture.input, operation: () => response.promise };
  await render(_fixture);
  let completion!: Promise<void>;
  await act(() => {
    completion = _fixture.controller.onInterrupt();
  });
  const failure = expect(completion).rejects.toThrow("Connection closed");
  await act(async () => {
    response.reject(new Error("Connection closed"));
    await failure;
  });
  expect(_fixture.controller.isStopping).toBe(false);
});

function _createFixture() {
  let _published_controller = undefined! as ReturnType<typeof useStopGeneration>;

  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    input: undefined! as Parameters<typeof useStopGeneration>[0],
    get controller() {
      return _published_controller;
    },
    publishController(next: typeof _published_controller) {
      _published_controller = next;
    },

    container: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
