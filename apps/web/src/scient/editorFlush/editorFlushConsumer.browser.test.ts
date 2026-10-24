import {
  EnvironmentId,
  type EditorFlushResponse,
  type EditorFlushStreamEvent,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { createEditorFlushConsumerAtom } from "./editorFlushConsumer";

const environmentId = EnvironmentId.make("environment-flush-consumer");
const request = { requestId: "request-1", checkoutRoot: "/work/thesis", folder: "paper" };
const pageEvent = (type: "pagehide" | "pageshow", persisted: boolean) =>
  globalThis.dispatchEvent(new PageTransitionEvent(type, { persisted }));

function consumer() {
  const requests = Atom.make<AsyncResult.AsyncResult<EditorFlushStreamEvent, never>>(
    AsyncResult.initial(),
  );
  const responses: EditorFlushResponse[] = [];
  const leave = vi.fn(async (_connectionId: string) => ({ accepted: true }));
  const reconnect = vi.fn();
  /** Each flush waits until the test lets it finish. */
  const flushes: Array<() => void> = [];
  const answers: Array<PromiseWithResolvers<void>> = [];
  const atom = createEditorFlushConsumerAtom({
    requestsAtom: requests,
    clientId: "window-a",
    environmentId,
    flush: async () => {
      const done = Promise.withResolvers<void>();
      flushes.push(done.resolve);
      await done.promise;
      return { saved: ["paper/main.tex"], failures: [] };
    },
    respond: async (response) => {
      responses.push(response);
      answers.shift()?.resolve();
    },
    leave,
    reconnect,
  });
  const registry = AtomRegistry.make();
  const unmount = registry.mount(atom);
  const emit = (event: EditorFlushStreamEvent) =>
    registry.set(requests, AsyncResult.success(event));
  return {
    responses,
    leave,
    reconnect,
    flushes,
    unmount,
    connected: (connectionId: string) => emit({ type: "connected", connectionId }),
    deliver: (connectionId: string) => emit({ type: "request", connectionId, request }),
    /** Resolves when the next answer is sent. */
    nextAnswer: () => {
      const answer = Promise.withResolvers<void>();
      answers.push(answer);
      return answer.promise;
    },
  };
}

describe("createEditorFlushConsumerAtom", () => {
  it("answers a request once, naming the connection it arrived on", async () => {
    const window = consumer();
    window.connected("connection-1");
    window.deliver("connection-1");
    window.deliver("connection-1");
    expect(window.flushes).toHaveLength(1);
    const answered = window.nextAnswer();
    window.flushes[0]!();
    await answered;
    expect(window.responses).toEqual([
      {
        clientId: "window-a",
        connectionId: "connection-1",
        requestId: "request-1",
        saved: ["paper/main.tex"],
        failures: [],
      },
    ]);
    window.unmount();
  });

  it("drops a replaced connection's answer and answers the redelivery", async () => {
    const window = consumer();
    window.connected("connection-1");
    window.deliver("connection-1");
    window.connected("connection-2");
    window.deliver("connection-2");
    expect(window.flushes).toHaveLength(2);
    const answered = window.nextAnswer();
    // The first flush finishes after its connection was replaced: no answer.
    window.flushes[0]!();
    window.flushes[1]!();
    await answered;
    expect(window.responses.map((response) => response.connectionId)).toEqual(["connection-2"]);
    window.unmount();
  });

  it("says goodbye once per connection when the window closes", async () => {
    const window = consumer();
    window.connected("connection-1");
    pageEvent("pagehide", false);
    pageEvent("pagehide", false);
    expect(window.leave.mock.calls).toEqual([["connection-1"]]);
    // Registered again later: a later close says goodbye again.
    window.connected("connection-2");
    pageEvent("pagehide", false);
    expect(window.leave.mock.calls).toEqual([["connection-1"], ["connection-2"]]);
    window.unmount();
    await expect.poll(() => window.leave.mock.calls.length).toBe(2);
  });

  it("keeps a cached page counted and registers it again when restored", () => {
    const window = consumer();
    window.connected("connection-1");
    pageEvent("pagehide", true);
    expect(window.leave).not.toHaveBeenCalled();
    pageEvent("pageshow", true);
    expect(window.reconnect).toHaveBeenCalledOnce();
    window.connected("connection-2");
    pageEvent("pagehide", false);
    expect(window.leave.mock.calls).toEqual([["connection-2"]]);
    window.unmount();
  });

  it("says goodbye when it stops answering for the environment", async () => {
    const window = consumer();
    window.connected("connection-1");
    window.unmount();
    // The atom is disposed once the registry lets it go idle.
    await expect.poll(() => window.leave.mock.calls.length).toBe(1);
    // A closed window no longer reacts to page events.
    pageEvent("pagehide", false);
    pageEvent("pageshow", true);
    expect(window.leave).toHaveBeenCalledOnce();
    expect(window.reconnect).not.toHaveBeenCalled();
  });
});
