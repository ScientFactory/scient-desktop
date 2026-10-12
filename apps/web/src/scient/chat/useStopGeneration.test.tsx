// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
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
import { useStopGeneration } from "./useStopGeneration";

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

let root: Root;
let container: HTMLDivElement;
let input: Parameters<typeof useStopGeneration>[0];
let controller: ReturnType<typeof useStopGeneration>;
function Probe() {
  controller = useStopGeneration(input);
  return (
    <button onClick={() => void controller.onInterrupt()}>
      {controller.isStopping ? "Stopping…" : "Stop"}
    </button>
  );
}
function render() {
  act(() => root.render(<Probe />));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  input = {
    threadKey: "local:thread-a",
    runId: RunId.make("stop-run"),
    canInterrupt: true,
    projection: projection(),
    operation: vi.fn(async () => true),
  };
  render();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("acknowledges immediately, deduplicates in-flight clicks, and waits for server settlement", async () => {
  const response = pendingResponse();
  input = { ...input, operation: vi.fn(() => response.promise) };
  render();
  let completion!: Promise<void>;
  act(() => {
    completion = controller.onInterrupt();
  });
  expect(container.textContent).toBe("Stopping…");
  await act(() => controller.onInterrupt());
  expect(input.operation).toHaveBeenCalledTimes(1);
  await act(async () => {
    response.resolve(true);
    await completion;
  });
  expect(controller.isStopping).toBe(true);
  input = { ...input, canInterrupt: false };
  render();
  expect(controller.isStopping).toBe(false);
  input = { ...input, canInterrupt: true };
  render();
  expect(controller.isStopping).toBe(false);
});

it("clears a rejected command and keeps Stop available for retry", async () => {
  input = { ...input, operation: vi.fn(async () => false) };
  render();
  await act(() => controller.onInterrupt());
  expect(controller.isStopping).toBe(false);
  await act(() => controller.onInterrupt());
  expect(input.operation).toHaveBeenCalledTimes(2);
});

it("allows another Stop after acknowledgement when native cancellation still needs a retry", async () => {
  await act(() => controller.onInterrupt());
  expect(controller.isStopping).toBe(true);
  await act(() => controller.onInterrupt());
  expect(input.operation).toHaveBeenCalledTimes(2);
});

it("a late failed response cannot clear a different conversation's acknowledgement", async () => {
  const first = pendingResponse();
  const second = pendingResponse();
  input = { ...input, operation: vi.fn(() => first.promise) };
  render();
  let a!: Promise<void>;
  act(() => {
    a = controller.onInterrupt();
  });
  input = { ...input, threadKey: "remote:thread-b", operation: vi.fn(() => second.promise) };
  render();
  expect(controller.isStopping).toBe(false);
  let b!: Promise<void>;
  act(() => {
    b = controller.onInterrupt();
  });
  await act(async () => {
    first.resolve(false);
    await a;
  });
  expect(controller.isStopping).toBe(true);
  await act(async () => {
    second.resolve(true);
    await b;
  });
  expect(controller.isStopping).toBe(true);
});

it("does not carry acknowledgement to a replacement attempt in the same run", async () => {
  await act(() => controller.onInterrupt());
  const current = projection();
  input = {
    ...input,
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
  render();
  expect(controller.isStopping).toBe(false);
});

it("does not revive Stopping when the run finishes before the command responds", async () => {
  const response = pendingResponse();
  input = { ...input, operation: () => response.promise };
  render();
  let completion!: Promise<void>;
  act(() => {
    completion = controller.onInterrupt();
  });
  input = { ...input, canInterrupt: false };
  render();
  await act(async () => {
    response.resolve(true);
    await completion;
  });
  expect(controller.isStopping).toBe(false);
});

it("reads a durable Stop after remount and clears it once its result is recorded", () => {
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
  input = { ...input, projection: { ...base, turnItems: [request] } };
  render();
  expect(controller.isStopping).toBe(true);
  const result: OrchestrationV2TurnItem = {
    ...request,
    id: TurnItemId.make("stop-result"),
    ordinal: 2,
    type: "run_interrupt_result",
    parentItemId: request.id,
    status: "interrupted",
    title: "Interrupted",
  };
  input = { ...input, projection: { ...base, turnItems: [request, result] } };
  render();
  expect(controller.isStopping).toBe(false);
  input = {
    ...input,
    projection: { ...base, turnItems: [{ ...request, nodeId: NodeId.make("old-root") }] },
  };
  render();
  expect(controller.isStopping).toBe(false);
});

it("clears acknowledgement and preserves an unexpected command rejection", async () => {
  const response = pendingResponse();
  input = { ...input, operation: () => response.promise };
  render();
  let completion!: Promise<void>;
  act(() => {
    completion = controller.onInterrupt();
  });
  const failure = expect(completion).rejects.toThrow("Connection closed");
  await act(async () => {
    response.reject(new Error("Connection closed"));
    await failure;
  });
  expect(controller.isStopping).toBe(false);
});
