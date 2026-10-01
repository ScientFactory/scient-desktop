// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useLatexAutoBuild } from "./useLatexAutoBuild";

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
      lastEditAt: 0,
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
  it("waits 2.5 seconds from the final edit and waits for saves", async () => {
    input = { ...input, needsBuild: false };
    await render();
    input = { ...input, needsBuild: true, sourceKey: "r2", lastEditAt: Date.now(), blocked: true };
    await render();
    await tick(1000);
    input = { ...input, sourceKey: "r3", lastEditAt: Date.now(), blocked: false };
    await render();
    await tick(2499);
    expect(requestBuild).not.toHaveBeenCalled();
    await tick(1);
    expect(requestBuild).toHaveBeenCalledTimes(1);
  });
  it("coalesces edits during a running build into one later build", async () => {
    input = { ...input, busy: true };
    await render();
    for (const key of ["r2", "r3", "r4"]) {
      input = { ...input, sourceKey: key, lastEditAt: Date.now() };
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
});
