import { EnvironmentId } from "@t3tools/contracts";
import { createRef } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";
import { advanceTestClock } from "../../../test/testClock";
import { afterChatInputQuiet, chatInputQuietDelay } from "../../scient/writing/inputPriority";
import { AssistantCitationCommentEditor } from "./AssistantCitationCommentEditor";

vi.mock("~/scient/voice/ScientVoiceCommentControl", () => ({
  ScientVoiceCommentControl: () => null,
}));

async function fixture() {
  const cleanup = new AsyncDisposableStack();
  try {
    const inputRef = createRef<HTMLTextAreaElement>();
    const save = vi.fn(() => true);
    // This editor's priority lifecycle needs no router or application environment.
    const screen = await render(
      <AssistantCitationCommentEditor
        citation={{ environmentId: EnvironmentId.make("priority-fixture") }}
        inputRef={inputRef}
        onSubmit={save}
        onCancel={() => {}}
      />,
      { router: false },
    );
    cleanup.use(fakeTimers());
    cleanup.use(screen);
    const input = inputRef.current!;
    await act(() => input.focus());
    const type = (value: string) =>
      act(() => {
        input.dispatchEvent(
          new InputEvent("beforeinput", { bubbles: true, inputType: "insertText" }),
        );
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    return {
      input,
      screen,
      save,
      type,
      cleanup,
      [Symbol.asyncDispose]: () => cleanup.disposeAsync(),
    };
  } catch (error) {
    await cleanup.disposeAsync();
    throw error;
  }
}

it("keeps document work behind Ask in chat typing and composition, then saves the complete comment", async ({
  signal,
}) => {
  await using current = await fixture();
  const { input, type, save, screen, cleanup } = current;
  const work = vi.fn();
  await type("Explain this");
  cleanup.defer(afterChatInputQuiet(work));
  await advanceTestClock(signal, 400);
  await type("Explain this carefully.");
  await advanceTestClock(signal, 400);
  expect(work).not.toHaveBeenCalled();
  input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  await advanceTestClock(signal, 1000);
  expect(work).not.toHaveBeenCalled();
  input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  await advanceTestClock(signal, 499);
  expect(work).not.toHaveBeenCalled();
  await advanceTestClock(signal, 1);
  expect(work).toHaveBeenCalledOnce();
  const button = [...screen.container.querySelectorAll("button")].find(
    (item) => item.textContent === "Save",
  )!;
  await act(() => button.click());
  expect(save).toHaveBeenCalledWith("Explain this carefully.");
});

it("holds work during comment selection and releases priority on blur and unmount", async ({
  signal,
}) => {
  await using current = await fixture();
  const { input, type, screen, cleanup } = current;
  input.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
  const afterBlur = vi.fn();
  cleanup.defer(afterChatInputQuiet(afterBlur));
  await advanceTestClock(signal, 1000);
  expect(afterBlur).not.toHaveBeenCalled();
  document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
  await act(() => input.blur());
  await advanceTestClock(signal, 0);
  expect(afterBlur).toHaveBeenCalledOnce();
  await act(() => input.focus());
  await type("Keep this draft");
  const afterUnmount = vi.fn();
  cleanup.defer(afterChatInputQuiet(afterUnmount));
  await screen.unmount();
  await advanceTestClock(signal, 0);
  expect(afterUnmount).toHaveBeenCalledOnce();
  expect(chatInputQuietDelay()).toBe(0);
  input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  expect(chatInputQuietDelay()).toBe(0);
});
