// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { FileReadFailure } from "./FileReadFailure";

describe("files panel read failure", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const tryAgain = () =>
    [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Try again"),
    );

  it("recovers through Try again: request, pending, then the file replaces the failure", () => {
    const onRetry = vi.fn();
    const failed = (retrying: boolean) => (
      <FileReadFailure
        failure="operation_failed"
        message="Failed to open '/tmp/report.md'."
        retrying={retrying}
        onRetry={onRetry}
      />
    );
    act(() => root.render(failed(false)));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't open this file",
    );
    expect(container.textContent).not.toContain("/tmp/report.md");

    act(() => tryAgain()?.click());
    expect(onRetry).toHaveBeenCalledOnce();

    act(() => root.render(failed(true)));
    expect(tryAgain()?.getAttribute("aria-busy")).toBe("true");
    act(() => tryAgain()?.click());
    expect(onRetry).toHaveBeenCalledOnce();

    act(() => root.render(<p>report contents</p>));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toBe("report contents");
  });

  it("offers no retry where reading again cannot help", () => {
    for (const failure of ["binary_file", "resolved_path_outside_root"] as const) {
      act(() =>
        root.render(
          <FileReadFailure failure={failure} message="x" retrying={false} onRetry={vi.fn()} />,
        ),
      );
      expect(tryAgain()).toBeUndefined();
    }
    expect(container.textContent).toContain("Outside this project");
  });
});
