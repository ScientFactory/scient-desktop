// @vitest-environment happy-dom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { CommandPaletteContent } from "./CommandPaletteContent";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("keeps autofocus and delivers Enter to the caller's input ownership guard after remount", async () => {
  const ref = createRef<HTMLInputElement>();
  const submit = vi.fn();
  for (const key of ["first", "replacement"]) {
    await act(() =>
      root.render(
        <CommandPaletteContent
          key={key}
          inputProps={{ ref, placeholder: "Project path" }}
          containerProps={{
            onKeyDownCapture: (event) => {
              if (event.target !== ref.current || event.key !== "Enter") return;
              event.preventDefault();
              event.stopPropagation();
              submit();
            },
          }}
        >
          {null}
        </CommandPaletteContent>,
      ),
    );
    const input = container.querySelector("input")!;
    expect(ref.current).toBe(input);
    expect(document.activeElement).toBe(input);
    await act(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      ),
    );
  }
  expect(submit).toHaveBeenCalledTimes(2);
  await act(() => root.render(null));
  expect(ref.current).toBeNull();
});

it("preserves React callback-ref cleanup", async () => {
  const cleanup = vi.fn();
  const ref = vi.fn(() => cleanup);
  await act(() =>
    root.render(<CommandPaletteContent inputProps={{ ref }}>{null}</CommandPaletteContent>),
  );
  expect(ref).toHaveBeenCalledWith(container.querySelector("input"));
  await act(() => root.render(null));
  expect(cleanup).toHaveBeenCalledOnce();
});
