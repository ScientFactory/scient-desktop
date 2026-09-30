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

  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes(label),
    );

  it("names the missing location and lets the user pick a same-named file", () => {
    const onOpenCandidate = vi.fn();
    act(() =>
      root.render(
        <FileReadFailure
          failure="operation_failed"
          reason="not_found"
          message="raw"
          retrying={false}
          onRetry={vi.fn()}
          path="/Users/me/reviews/notes.md"
          candidates={["reviews/notes.md", "archive/notes.md"]}
          onOpenCandidate={onOpenCandidate}
        />,
      ),
    );
    expect(container.textContent).toContain("File not found");
    expect(container.textContent).toContain("/Users/me/reviews/notes.md");
    expect(container.textContent).toContain("Files with the same name exist in this project:");
    expect(tryAgain()).toBeDefined();

    act(() => button("archive/notes.md")?.click());
    expect(onOpenCandidate).toHaveBeenCalledExactlyOnceWith("archive/notes.md");
  });

  it("offers same-named files only for a file that is not found", () => {
    act(() =>
      root.render(
        <FileReadFailure
          failure="operation_failed"
          reason="permission_denied"
          message={null}
          retrying={false}
          onRetry={vi.fn()}
          path="/Users/me/private/notes.md"
          candidates={["reviews/notes.md"]}
          onOpenCandidate={vi.fn()}
          onOpenPrivacySettings={vi.fn()}
        />,
      ),
    );
    expect(container.textContent).toContain("Access denied");
    expect(button("reviews/notes.md")).toBeUndefined();
    expect(button("Open Privacy Settings")).toBeDefined();
  });

  it("opens an older server's outside-the-project refusal read-only", () => {
    const onOpenReadOnly = vi.fn();
    act(() =>
      root.render(
        <FileReadFailure
          failure="workspace_path_outside_root"
          message="outside"
          retrying={false}
          onRetry={vi.fn()}
          onOpenReadOnly={onOpenReadOnly}
        />,
      ),
    );
    act(() => button("Open read-only")?.click());
    expect(onOpenReadOnly).toHaveBeenCalledOnce();
  });
});
