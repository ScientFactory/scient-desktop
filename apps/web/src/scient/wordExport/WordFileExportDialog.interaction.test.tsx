// @vitest-environment jsdom

import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const readPandocTool = vi.fn();
const installPandocTool = vi.fn();
const exportWordFile = vi.fn();
vi.mock("./client", () => ({
  readPandocTool,
  installPandocTool,
  exportWordFile,
  exportWordLatex: vi.fn(),
}));

const saveConversationExport = vi.fn();
vi.mock("../conversationExport/exportActions", () => ({
  saveConversationExport,
  saveFailureMessage: vi.fn(),
}));

const { WordFileExportDialog } = await import("./WordFileExportDialog");

const environmentId = EnvironmentId.make("local");
const revision = `sha256:${"a".repeat(64)}`;

function status(installed: boolean) {
  return {
    version: "3.11",
    installed,
    canInstall: true,
    unavailableReason: null,
    downloadBytes: 41_832_712,
    install: {
      state: installed ? "ready" : "idle",
      bytesReceived: null,
      totalBytes: null,
      failureReason: null,
      updatedAtEpochMs: 1,
    },
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  readPandocTool.mockReset().mockResolvedValue(status(false));
  installPandocTool.mockReset().mockResolvedValue(status(true));
  exportWordFile.mockReset();
  saveConversationExport.mockReset().mockResolvedValue({ _tag: "cancelled" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("WordFileExportDialog", () => {
  it("starts exactly one export when a first-use Pandoc install finishes", async () => {
    let completeExport!: (value: unknown) => void;
    exportWordFile.mockReturnValue(
      new Promise((resolve) => {
        completeExport = resolve;
      }),
    );
    const savedRevision = vi.fn(async () => revision);
    const onClose = vi.fn();
    await act(async () =>
      root.render(
        <WordFileExportDialog
          environmentId={environmentId}
          cwd="/project"
          relativePath="notes/report.md"
          savedRevision={savedRevision}
          onClose={onClose}
        />,
      ),
    );

    const install = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Install Pandoc"),
    );
    expect(install).toBeDefined();
    await act(async () => install?.click());

    expect(installPandocTool).toHaveBeenCalledOnce();
    expect(savedRevision).toHaveBeenCalledOnce();
    expect(exportWordFile).toHaveBeenCalledExactlyOnceWith(environmentId, {
      cwd: "/project",
      relativePath: "notes/report.md",
      revision,
    });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () =>
      completeExport({ file: { fileName: "report.docx" }, warnings: [] }),
    );
    expect(saveConversationExport).toHaveBeenCalledOnce();
    expect(exportWordFile).toHaveBeenCalledOnce();
  });
});
