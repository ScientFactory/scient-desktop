import {
  EnvironmentId,
  ThreadId,
  type ScientDocumentHostRequest,
  type ScientDocumentHostResponse,
  type ScientDocumentHostStreamEvent,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createScientDocumentHostRequestConsumerAtom,
  ScientDocumentHostExecutionError,
  serializeScientDocumentHostError,
  type ScientDocumentRequestHandler,
} from "./documentHostRequestConsumer";

const environmentId = EnvironmentId.make("documents-host");
const threadId = ThreadId.make("background-build");
const request = (requestId: string): ScientDocumentHostRequest => ({
  requestId,
  threadId,
  operation: "documentLatexPresent",
  input: { rootSourcePath: "papers/main.tex" },
  timeoutMs: 15_000,
});
const event = (
  requestId: string,
  connectionId = "connection-1",
): ScientDocumentHostStreamEvent => ({
  type: "request",
  connectionId,
  request: request(requestId),
});
const registries: AtomRegistry.AtomRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
});

function mount(
  handle: ScientDocumentRequestHandler["handle"],
  initial: AsyncResult.AsyncResult<ScientDocumentHostStreamEvent, Error> = AsyncResult.initial(
    false,
  ),
) {
  const requestsAtom = Atom.make(initial);
  const requestHandlerAtom = Atom.make<ScientDocumentRequestHandler>({ handle });
  const respond = vi.fn(async (_response: ScientDocumentHostResponse) => undefined);
  const registry = AtomRegistry.make();
  registries.push(registry);
  registry.mount(
    createScientDocumentHostRequestConsumerAtom({
      requestsAtom,
      clientId: "client-1",
      environmentId,
      requestHandlerAtom,
      respond,
    }),
  );
  return {
    registry,
    requestsAtom,
    requestHandlerAtom,
    respond,
    emit: (value: ScientDocumentHostStreamEvent) =>
      registry.set(requestsAtom, AsyncResult.success(value)),
  };
}

describe("controlled document request consumption", () => {
  it("consumes every request in a synchronous burst with the original response identity", async () => {
    const handle = vi.fn(async (value: ScientDocumentHostRequest) => ({
      requestId: value.requestId,
    }));
    const host = mount(handle);
    host.emit(event("request-1"));
    host.emit(event("request-2"));
    await vi.waitFor(() => expect(host.respond).toHaveBeenCalledTimes(2));
    expect(handle.mock.calls.map(([value]) => value.requestId)).toEqual(["request-1", "request-2"]);
    expect(host.respond.mock.calls.map(([value]) => value)).toEqual([
      {
        clientId: "client-1",
        connectionId: "connection-1",
        requestId: "request-1",
        ok: true,
        result: { requestId: "request-1" },
      },
      {
        clientId: "client-1",
        connectionId: "connection-1",
        requestId: "request-2",
        ok: true,
        result: { requestId: "request-2" },
      },
    ]);
  });

  it("consumes a cached request on mount once and uses the latest handler without reconnecting", async () => {
    const first = vi.fn(async () => "first");
    const second = vi.fn(async () => "second");
    const host = mount(first, AsyncResult.success(event("cached")));
    await vi.waitFor(() => expect(host.respond).toHaveBeenCalledTimes(1));
    host.registry.set(host.requestHandlerAtom, { handle: second });
    host.emit(event("cached"));
    host.emit(event("next"));
    await vi.waitFor(() => expect(host.respond).toHaveBeenCalledTimes(2));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(host.respond.mock.calls.map(([value]) => value.result)).toEqual(["first", "second"]);
  });

  it("retires in-flight work and drops old-stream requests after a replacement connection", async () => {
    let finish: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    const handle = vi.fn(async (value: ScientDocumentHostRequest, abortSignal: AbortSignal) => {
      if (value.requestId === "old") {
        signal = abortSignal;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      }
      return value.requestId;
    });
    const host = mount(
      handle,
      AsyncResult.success({ type: "connected", connectionId: "connection-1" }),
    );
    host.emit(event("old"));
    await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(1));
    host.emit({ type: "connected", connectionId: "connection-2" });
    host.emit(event("late-old"));
    host.emit(event("new", "connection-2"));
    expect(signal?.aborted).toBe(true);
    finish!();
    await vi.waitFor(() => expect(host.respond).toHaveBeenCalledTimes(1));
    expect(handle.mock.calls.map(([value]) => value.requestId)).toEqual(["old", "new"]);
    expect(host.respond).toHaveBeenCalledExactlyOnceWith({
      clientId: "client-1",
      connectionId: "connection-2",
      requestId: "new",
      ok: true,
      result: "new",
    });
  });

  it("aborts work on a disconnected stream and suppresses its late response", async () => {
    let finish: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    const host = mount(
      vi.fn(async (value: ScientDocumentHostRequest, abortSignal: AbortSignal) => {
        if (value.requestId !== "old") return;
        signal = abortSignal;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      }),
    );
    host.emit(event("old"));
    await vi.waitFor(() => expect(signal).toBeDefined());
    host.registry.set(host.requestsAtom, AsyncResult.initial(false));
    expect(signal?.aborted).toBe(true);
    finish!();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(host.respond).not.toHaveBeenCalled();
    // An explicit reconnect announcement is authoritative even if its ID is reused.
    host.emit({ type: "connected", connectionId: "connection-1" });
    host.emit(event("reconnected"));
    await vi.waitFor(() => expect(host.respond).toHaveBeenCalledTimes(1));
    expect(host.respond.mock.calls[0]?.[0].requestId).toBe("reconnected");
  });

  it("aborts work on disposal and never returns a receipt from the disposed host", async () => {
    let finish: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    const host = mount(
      vi.fn(async (_value: ScientDocumentHostRequest, abortSignal: AbortSignal) => {
        signal = abortSignal;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      }),
    );
    host.emit(event("old"));
    await vi.waitFor(() => expect(signal).toBeDefined());
    host.registry.dispose();
    expect(signal?.aborted).toBe(true);
    finish!();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(host.respond).not.toHaveBeenCalled();
  });

  it("returns typed public failures while keeping arbitrary renderer causes private", async () => {
    const host = mount(async () => {
      throw new ScientDocumentHostExecutionError("The desktop document renderer is unavailable.");
    });
    host.emit(event("failed"));
    await vi.waitFor(() => expect(host.respond).toHaveBeenCalledTimes(1));
    expect(host.respond.mock.calls[0]?.[0]).toMatchObject({
      ok: false,
      requestId: "failed",
      error: {
        _tag: "ScientDocumentHostExecutionError",
        message: "The desktop document renderer is unavailable.",
        detail: { environmentId, threadId, requestId: "failed", operation: "documentLatexPresent" },
      },
    });
    const serialized = serializeScientDocumentHostError(
      new Error("https://private.test/signed-secret"),
      environmentId,
      request("private"),
    );
    expect(serialized.message).toBe("The controlled document operation failed.");
    expect(JSON.stringify(serialized)).not.toContain("signed-secret");
  });
});
