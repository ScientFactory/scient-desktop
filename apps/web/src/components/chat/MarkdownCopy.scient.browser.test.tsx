import { describe, expect, it, vi } from "vite-plus/test";
import "~/index.css";
import { act, fakeTimers, render } from "../../../test/render";
import { advanceTestClock } from "../../../test/testClock";
import { MarkdownCodeBlock } from "~/scient/presentation/MarkdownCodeBlock";
import { CodeBlockActions } from "~/scient/presentation/CodeBlockActions";

function clipboardValue(value: unknown) {
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value });
  return {
    [Symbol.dispose]() {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else Reflect.deleteProperty(navigator, "clipboard");
    },
  };
}

describe("canonical code copy selection and lifetime", () => {
  it.each([true, false])(
    "preserves a backward rendered-code selection when execCommand returns %s",
    async (accepted) => {
      const code = "alpha βeta gamma\n  delta\tomega  \n";
      const failed = vi.fn();
      await using screen = await render(
        <MarkdownCodeBlock
          code={code}
          language="text"
          fenceTitle={null}
          theme="light"
          onCopyFailure={failed}
        />,
        // The canonical block has no links or route dependencies.
        { router: false },
      );
      using _clipboard = clipboardValue(undefined);
      await vi.waitFor(() =>
        expect(screen.container.querySelector(".chat-markdown-shiki code")).not.toBeNull(),
      );
      const body = screen.container.querySelector(".chat-markdown-shiki code")!;
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      const first = walker.nextNode()!;
      expect(first.textContent!.length).toBeGreaterThan(6);
      const selection = document.getSelection()!;
      selection.setBaseAndExtent(first, 6, first, 2);
      using _cleanup = { [Symbol.dispose]: () => selection.removeAllRanges() };
      const selected = selection.toString();
      expect(selected.length).toBe(4);
      let copied: string | null = null;
      using exec = vi.spyOn(document, "execCommand").mockImplementation(() => {
        const temporary = document.activeElement as HTMLTextAreaElement;
        copied = temporary.value.slice(temporary.selectionStart, temporary.selectionEnd);
        return accepted;
      });
      // Native click dispatch activates Copy without a pointer-down that discards the test selection.
      await act(() =>
        screen.container.querySelector<HTMLButtonElement>('[aria-label="Copy code"]')!.click(),
      );
      expect(exec).toHaveBeenCalledExactlyOnceWith("copy");
      expect(copied).toBe(code);
      expect(selection.toString()).toBe(selected);
      expect([
        selection.anchorNode,
        selection.anchorOffset,
        selection.focusNode,
        selection.focusOffset,
      ]).toEqual([first, 6, first, 2]);
      expect(screen.container.querySelector('[aria-label="Copied"]') !== null).toBe(accepted);
      expect(failed).toHaveBeenCalledTimes(accepted ? 0 : 1);
    },
  );

  it("does not schedule Copied feedback after the code actions unmount during an async copy", async () => {
    const completion = Promise.withResolvers<void>();
    using _clipboard = clipboardValue({ writeText: () => completion.promise });
    await using resources = new AsyncDisposableStack();
    const screen = resources.use(
      await render(
        <CodeBlockActions
          wrapped={false}
          onWrapChange={() => {}}
          readCode={() => "original bytes\n"}
        />,
        { router: false },
      ),
    );
    const clock = fakeTimers();
    resources.defer(() => clock[Symbol.dispose]());
    resources.defer(() => screen.unmount());
    await act(() =>
      screen.container.querySelector<HTMLButtonElement>('[aria-label="Copy code"]')!.click(),
    );
    await screen.unmount();
    using timeout = vi.spyOn(globalThis, "setTimeout");
    await act(() => completion.resolve());
    expect(timeout.mock.calls.filter(([, delay]) => delay === 1200)).toHaveLength(0);
    expect(screen.container.childElementCount).toBe(0);
  });

  it("restarts one feedback timer and cancels it on unmount", async ({ signal }) => {
    using _clipboard = clipboardValue({ writeText: vi.fn().mockResolvedValue(undefined) });
    await using resources = new AsyncDisposableStack();
    const screen = resources.use(
      await render(
        <CodeBlockActions wrapped={false} onWrapChange={() => {}} readCode={() => "copy\n"} />,
        { router: false },
      ),
    );
    const clock = fakeTimers();
    resources.defer(() => clock[Symbol.dispose]());
    resources.defer(() => screen.unmount());
    using timeout = vi.spyOn(globalThis, "setTimeout");
    using clear = vi.spyOn(globalThis, "clearTimeout");
    await act(() =>
      screen.container.querySelector<HTMLButtonElement>('[aria-label="Copy code"]')!.click(),
    );
    expect(screen.container.querySelector('[aria-label="Copied"]')).not.toBeNull();
    const feedbackTimer = () =>
      timeout.mock.results[timeout.mock.calls.findLastIndex(([, delay]) => delay === 1200)]!.value;
    const firstTimer = feedbackTimer();
    await advanceTestClock(signal, 600);
    await act(() =>
      screen.container.querySelector<HTMLButtonElement>('[aria-label="Copied"]')!.click(),
    );
    expect(clear).toHaveBeenCalledWith(firstTimer);
    await advanceTestClock(signal, 600);
    expect(screen.container.querySelector('[aria-label="Copied"]')).not.toBeNull();
    await advanceTestClock(signal, 600);
    expect(screen.container.querySelector('[aria-label="Copy code"]')).not.toBeNull();
    await act(() =>
      screen.container.querySelector<HTMLButtonElement>('[aria-label="Copy code"]')!.click(),
    );
    const lastTimer = feedbackTimer();
    await screen.unmount();
    expect(clear).toHaveBeenCalledWith(lastTimer);
  });
});
