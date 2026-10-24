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

function consumer() {
  const requests = Atom.make<AsyncResult.AsyncResult<EditorFlushStreamEvent, never>>(
    AsyncResult.initial(),
  );
  const responses: EditorFlushResponse[] = [];
  const leave = vi.fn(async () => ({ accepted: true }));
  const answered = Promise.withResolvers<void>();
  const atom = createEditorFlushConsumerAtom({
    requestsAtom: requests,
    clientId: "window-a",
    environmentId,
    flush: async () => ({ saved: ["paper/main.tex"], failures: [] }),
    respond: async (response) => {
      responses.push(response);
      answered.resolve();
    },
    leave,
  });
  const registry = AtomRegistry.make();
  const unmount = registry.mount(atom);
  const deliver = (connectionId: string) =>
    registry.set(
      requests,
      AsyncResult.success({ type: "request" as const, connectionId, request }),
    );
  return { responses, leave, answered: answered.promise, unmount, deliver };
}

describe("createEditorFlushConsumerAtom", () => {
  it("answers a request once per connection", async () => {
    const window = consumer();
    window.deliver("connection-1");
    window.deliver("connection-1");
    await window.answered;
    expect(window.responses).toEqual([
      { clientId: "window-a", requestId: "request-1", saved: ["paper/main.tex"], failures: [] },
    ]);
    window.unmount();
  });

  it("says goodbye once when the window closes", () => {
    const window = consumer();
    expect(window.leave).not.toHaveBeenCalled();
    globalThis.dispatchEvent(new Event("pagehide"));
    expect(window.leave).toHaveBeenCalledOnce();
    window.unmount();
    expect(window.leave).toHaveBeenCalledOnce();
  });

  it("says goodbye when it stops answering for the environment", async () => {
    const window = consumer();
    window.unmount();
    // The atom is disposed once the registry lets it go idle.
    await expect.poll(() => window.leave.mock.calls.length).toBe(1);
    // A closed window no longer reacts to page events.
    globalThis.dispatchEvent(new Event("pagehide"));
    expect(window.leave).toHaveBeenCalledOnce();
  });
});
