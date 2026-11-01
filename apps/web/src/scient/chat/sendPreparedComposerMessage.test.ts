import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore } from "~/composerDraftStore";

import { sendPreparedComposerMessage } from "./sendPreparedComposerMessage";

const threadRef = {
  environmentId: EnvironmentId.make("prepared-message"),
  threadId: ThreadId.make("asking-thread"),
};

function setup() {
  const stack = new DisposableStack();
  const before = useComposerDraftStore.getState();
  stack.defer(() => useComposerDraftStore.setState(before, true));
  useComposerDraftStore.getState().setPrompt(threadRef, "");
  const insert = vi.fn((message: string) => {
    useComposerDraftStore.getState().setPrompt(threadRef, message);
    return true;
  });
  const submit = vi.fn();
  const input = {
    threadRef,
    composerTarget: threadRef,
    ready: true,
    prompt: "",
    message: "Merge the conflict marks in paper/main.tex",
    insert,
    submit,
  };
  return { input, [Symbol.dispose]: () => stack.dispose() };
}

describe("prepared composer requests", () => {
  it.each([
    "thread",
    "environment",
    "unavailable",
    "live text",
    "stored text",
    "attachment",
  ] as const)("preserves the draft and does not send when blocked by %s", (block) => {
    using fixture = setup();
    const { input } = fixture;
    if (block === "thread")
      input.composerTarget = { ...threadRef, threadId: ThreadId.make("another-thread") };
    if (block === "environment")
      input.composerTarget = { ...threadRef, environmentId: EnvironmentId.make("another-server") };
    if (block === "unavailable") input.ready = false;
    if (block === "live text") input.prompt = "An edit not yet persisted";
    if (block === "stored text") useComposerDraftStore.getState().setPrompt(threadRef, "My draft");
    if (block === "attachment") {
      useComposerDraftStore.getState().addFiles(threadRef, [
        {
          type: "file",
          id: "private",
          name: "private.pdf",
          mimeType: "application/pdf",
          sizeBytes: 3,
          file: new File(["pdf"], "private.pdf", { type: "application/pdf" }),
        },
      ]);
    }
    const before = useComposerDraftStore.getState().getComposerDraft(threadRef);
    expect(sendPreparedComposerMessage(input)).toBe(false);
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)).toBe(before);
    expect(input.insert).not.toHaveBeenCalled();
    expect(input.submit).not.toHaveBeenCalled();
  });

  it("retains the staged request if the normal send path cannot finish", () => {
    using fixture = setup();
    expect(sendPreparedComposerMessage(fixture.input)).toBe(true);
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt).toBe(
      fixture.input.message,
    );
    expect(fixture.input.submit).toHaveBeenCalledOnce();
  });

  it("does not send when the composer refuses insertion", () => {
    using fixture = setup();
    const before = useComposerDraftStore.getState().getComposerDraft(threadRef);
    fixture.input.insert.mockReturnValue(false);
    expect(sendPreparedComposerMessage(fixture.input)).toBe(false);
    expect(fixture.input.submit).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)).toBe(before);
  });
});
