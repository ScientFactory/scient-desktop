// @vitest-environment jsdom

import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const readPandocTool = vi.fn();
const installPandocTool = vi.fn();
vi.mock("../wordExport/client", () => ({ readPandocTool, installPandocTool }));

const { WordPandocRequirement } = await import("./WordPandocRequirement");

const environmentId = EnvironmentId.make("local");

function status(install: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    version: "3.11",
    installed: false,
    canInstall: true,
    unavailableReason: null,
    downloadBytes: 41_832_712,
    install: {
      state: "idle",
      bytesReceived: null,
      totalBytes: null,
      failureReason: null,
      updatedAtEpochMs: 1,
      ...install,
    },
    ...overrides,
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  readPandocTool.mockReset();
  installPandocTool.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(disabled: boolean) {
  await act(async () =>
    root.render(
      <WordPandocRequirement
        environmentId={environmentId}
        reason="Word export is not available."
        disabled={disabled}
        onAvailable={() => undefined}
      />,
    ),
  );
  await act(async () => {
    await Promise.resolve();
  });
}

function installButton() {
  return [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "Install Pandoc",
  );
}

describe("WordPandocRequirement", () => {
  it("disables the install while an export is running", async () => {
    readPandocTool.mockResolvedValue(status({}));
    await render(true);
    expect(container.textContent).toContain("Word export needs Pandoc (40 MB, one-time download).");
    expect(installButton()?.disabled).toBe(true);
    await act(async () => installButton()?.click());
    expect(installPandocTool).not.toHaveBeenCalled();

    await render(false);
    expect(installButton()?.disabled).toBe(false);
  });

  it("shows the install progress as a status line with nothing to press", async () => {
    readPandocTool.mockResolvedValue(
      status({ state: "downloading", bytesReceived: 12 * 1024 * 1024, totalBytes: 41_832_712 }),
    );
    await render(false);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Downloading Pandoc… 12 MB of 40 MB",
    );
    expect(container.querySelector("button")).toBeNull();
  });

  it("gives the server's reason when Pandoc is installed but Word export is still unavailable", async () => {
    readPandocTool.mockResolvedValue(status({ state: "ready" }, { installed: true }));
    await render(false);
    expect(container.textContent).toBe("Word export is not available.");
  });
});
