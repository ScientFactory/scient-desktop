// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useLatexAutoBuild } from "./useLatexAutoBuild";
import { LATEX_AUTO_COMPILE_DELAY_MS } from "./latexCompilation";

describe("PDF-visible automatic builds", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const requestBuild = vi.fn();
  let input: Parameters<typeof useLatexAutoBuild>[0];
  function Harness() {
    useLatexAutoBuild(input);
    return null;
  }
  const render = async () => {
    await act(async () => root.render(<Harness />));
  };
  const tick = async (ms: number) => {
    await act(async () => vi.advanceTimersByTime(ms));
  };
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    requestBuild.mockReset();
    input = {
      visible: true,
      needsBuild: true,
      blocked: false,
      busy: false,
      toolchainReady: true,
      sourceKey: "r1",
      requestBuild,
    };
    container = document.createElement("div");
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it("builds a stale PDF immediately on open and re-entry", async () => {
    await render();
    await tick(0);
    expect(requestBuild).toHaveBeenCalledTimes(1);
    input = { ...input, visible: false };
    await render();
    input = { ...input, visible: true };
    await render();
    await tick(0);
    expect(requestBuild).toHaveBeenCalledTimes(2);
  });
  it("does not build a current PDF or while PDF is hidden", async () => {
    input = { ...input, needsBuild: false };
    await render();
    await tick(10_000);
    input = { ...input, visible: false, needsBuild: true };
    await render();
    await tick(10_000);
    expect(requestBuild).not.toHaveBeenCalled();
  });
  it("does not request timed builds after editing or saving", async () => {
    input = { ...input, needsBuild: false };
    await render();
    input = { ...input, needsBuild: true, sourceKey: "r2", blocked: true };
    await render();
    await tick(1000);
    input = { ...input, sourceKey: "r3", blocked: false };
    await render();
    await tick(2499);
    expect(requestBuild).not.toHaveBeenCalled();
    await tick(1);
    expect(requestBuild).not.toHaveBeenCalled();
    await tick(60_000);
    expect(requestBuild).not.toHaveBeenCalled();
  });
  it("coalesces edits during a running build into one later build", async () => {
    input = { ...input, busy: true };
    await render();
    for (const key of ["r2", "r3", "r4"]) {
      input = { ...input, sourceKey: key };
      await render();
    }
    await tick(3000);
    expect(requestBuild).not.toHaveBeenCalled();
    input = { ...input, busy: false };
    await render();
    await tick(0);
    expect(requestBuild).toHaveBeenCalledTimes(1);
    await render();
    await tick(10_000);
    expect(requestBuild).toHaveBeenCalledTimes(1);
  });
  it("does not retry a failed unchanged source or compile without TeX", async () => {
    input = { ...input, toolchainReady: false };
    await render();
    await tick(10_000);
    expect(requestBuild).not.toHaveBeenCalled();
    input = { ...input, toolchainReady: true };
    await render();
    await tick(0);
    expect(requestBuild).toHaveBeenCalledTimes(1);
    input = { ...input, busy: true };
    await render();
    input = { ...input, busy: false };
    await render();
    await tick(10_000);
    expect(requestBuild).toHaveBeenCalledTimes(1);
  });
  it("waits for a pause, coalesces rapid edits, and compiles while Source is visible", async () => {
    input = { ...input, mode: "auto", visible: false, needsBuild: false };
    await render();
    input = { ...input, needsBuild: true, sourceKey: "edit-1" };
    await render();
    await tick(1_500);
    input = { ...input, sourceKey: "edit-2" };
    await render();
    await tick(LATEX_AUTO_COMPILE_DELAY_MS - 1);
    expect(requestBuild).not.toHaveBeenCalled();
    await tick(1);
    expect(requestBuild).toHaveBeenCalledTimes(1);
  });
  it("waits for saves and a running build, then builds only the newest source", async () => {
    input = { ...input, mode: "auto", busy: true };
    await render();
    input = { ...input, sourceKey: "included-edit-1" };
    await render();
    input = { ...input, sourceKey: "included-edit-2", busy: false, blocked: true };
    await render();
    await tick(10_000);
    expect(requestBuild).not.toHaveBeenCalled();
    input = { ...input, blocked: false };
    await render();
    await tick(LATEX_AUTO_COMPILE_DELAY_MS);
    expect(requestBuild).toHaveBeenCalledTimes(1);
  });
  it("does not loop on a failed source; retries after an included source changes", async () => {
    input = { ...input, mode: "auto" };
    await render();
    await tick(LATEX_AUTO_COMPILE_DELAY_MS);
    input = { ...input, busy: true };
    await render();
    input = { ...input, busy: false };
    await render();
    await tick(60_000);
    expect(requestBuild).toHaveBeenCalledTimes(1);
    input = { ...input, sourceKey: "included-file-new-revision" };
    await render();
    await tick(LATEX_AUTO_COMPILE_DELAY_MS);
    expect(requestBuild).toHaveBeenCalledTimes(2);
  });
  it("builds again when an outside change makes a previously current PDF stale", async () => {
    input = { ...input, mode: "auto" };
    await render();
    await tick(LATEX_AUTO_COMPILE_DELAY_MS);
    input = { ...input, needsBuild: false };
    await render();
    input = { ...input, needsBuild: true };
    await render();
    await tick(LATEX_AUTO_COMPILE_DELAY_MS);
    expect(requestBuild).toHaveBeenCalledTimes(2);
  });
  it("cancels a pending automatic build when switched to Manual", async () => {
    input = { ...input, mode: "auto" };
    await render();
    await tick(1_000);
    input = { ...input, mode: "manual" };
    await render();
    await tick(60_000);
    input = { ...input, visible: false };
    await render();
    input = { ...input, visible: true };
    await render();
    await tick(60_000);
    expect(requestBuild).not.toHaveBeenCalled();
  });
  it("retires timers when the document closes", async () => {
    input = { ...input, mode: "auto" };
    await render();
    await act(() => root.unmount());
    root = createRoot(container);
    await tick(60_000);
    expect(requestBuild).not.toHaveBeenCalled();
  });
});
