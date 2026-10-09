// @vitest-environment jsdom

import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const readPandocTool = vi.fn();
const installPandocTool = vi.fn();
vi.mock("./client", () => ({ readPandocTool, installPandocTool }));

const { PandocInstallStatus } = await import("./PandocInstallControl");
const { usePandocTool } = await import("./usePandocTool");

const environmentId = EnvironmentId.make("local");
const active = {
  version: "3.11",
  installed: false,
  canInstall: true,
  unavailableReason: null,
  downloadBytes: 41_832_712,
  install: {
    state: "downloading" as const,
    bytesReceived: 12 * 1024 * 1024,
    totalBytes: 41_832_712,
    failureReason: null,
    updatedAtEpochMs: 1,
  },
};

function Harness() {
  const controller = usePandocTool(environmentId);
  return (
    <>
      <PandocInstallStatus controller={controller} showReady />
      <button type="button" onClick={controller.refresh}>
        Export failed
      </button>
    </>
  );
}

const button = (label: string) =>
  [...document.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.startsWith(label),
  );

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  readPandocTool.mockReset();
  installPandocTool.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("usePandocTool status polling", () => {
  it("shows a transient poll failure and retries the status without reinstalling", async () => {
    readPandocTool
      .mockResolvedValueOnce(active)
      .mockRejectedValueOnce(new Error("Status temporarily unavailable."))
      .mockResolvedValueOnce({
        ...active,
        installed: true,
        install: { ...active.install, state: "ready" },
      });

    await act(async () => root.render(<Harness />));
    expect(document.body.textContent).toContain("Downloading Pandoc");

    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Status temporarily unavailable.",
    );
    const retry = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Check again",
    );
    expect(retry).toBeDefined();
    await act(async () => retry?.click());

    expect(readPandocTool).toHaveBeenCalledTimes(3);
    expect(installPandocTool).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.textContent).toContain("Word export is available");
  });
});

describe("usePandocTool reinstall", () => {
  const installed = {
    ...active,
    installed: true,
    install: { ...active.install, state: "ready" as const },
  };
  const unstartable = {
    ...active,
    reinstallRequired: true,
    install: { ...active.install, state: "idle" as const, bytesReceived: null, totalBytes: null },
  };

  it("re-reads the status after a failed export and reinstalls from the offer", async () => {
    readPandocTool.mockResolvedValueOnce(installed).mockResolvedValueOnce(unstartable);
    installPandocTool.mockResolvedValueOnce(active);

    await act(async () => root.render(<Harness />));
    expect(document.body.textContent).toContain("Word export is available");

    // The export dialog asks for a fresh status when an export fails.
    await act(async () => button("Export failed")?.click());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Pandoc could not be started. Reinstall it to export to Word.",
    );
    const reinstall = button("Reinstall Pandoc");
    expect(reinstall?.textContent).toBe("Reinstall Pandoc (40 MB)");
    expect(reinstall?.disabled).toBe(false);

    await act(async () => reinstall?.click());
    expect(installPandocTool).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("Downloading Pandoc");
    expect(button("Reinstall Pandoc")).toBeUndefined();
  });
});
