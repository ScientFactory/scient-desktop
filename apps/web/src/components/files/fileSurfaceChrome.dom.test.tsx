// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { FileSurfaceFailure } from "./fileSurfaceChrome";

describe("file surface failure interactions", () => {
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

  it("retries on request and ignores clicks while a retry is pending", () => {
    const onRetry = vi.fn();
    act(() =>
      root.render(<FileSurfaceFailure title="Couldn't open" description="" onRetry={onRetry} />),
    );
    act(() => tryAgain()?.click());
    expect(onRetry).toHaveBeenCalledOnce();

    act(() =>
      root.render(
        <FileSurfaceFailure title="Couldn't open" description="" onRetry={onRetry} retrying />,
      ),
    );
    expect(tryAgain()?.disabled).toBe(true);
    act(() => tryAgain()?.click());
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("reveals the raw error only when Details is opened", () => {
    act(() =>
      root.render(
        <FileSurfaceFailure title="Couldn't open" description="" details="EACCES: denied" />,
      ),
    );
    expect(container.textContent).not.toContain("EACCES");
    const details = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Details",
    );
    expect(details?.getAttribute("aria-expanded")).toBe("false");

    act(() => details?.click());

    expect(details?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("pre")?.textContent).toBe("EACCES: denied");
  });
});
