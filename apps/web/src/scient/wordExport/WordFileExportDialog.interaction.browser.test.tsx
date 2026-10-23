import { render as _fixtureRender, type Screen, act } from "../../../test/render";

import { EnvironmentId } from "@t3tools/contracts";

import { describe, expect, it, vi } from "vite-plus/test";

const readPandocTool = vi.fn();
const installPandocTool = vi.fn();
const exportWordFile = vi.fn();
const prepareWordFileDiagrams = vi.fn();
vi.mock("./captureDiagrams", () => ({
  captureWordDiagrams: vi.fn(async (plan) => ({ sourceDigest: plan.sourceDigest, diagrams: [] })),
}));
vi.mock("./client", () => ({
  readPandocTool,
  installPandocTool,
  exportWordFile,
  prepareWordFileDiagrams,
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

async function _setupFixture0(_fixture: _Fixture) {
  readPandocTool.mockReset().mockResolvedValue(status(false));
  installPandocTool.mockReset().mockResolvedValue(status(true));
  exportWordFile.mockReset();
  prepareWordFileDiagrams.mockReset().mockResolvedValue({ sourceDigest: revision, diagrams: [] });
  saveConversationExport.mockReset().mockResolvedValue({ _tag: "cancelled" });
  _fixture.container = document.createElement("div");
  document.body.append(_fixture.container);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.container, router: false }),
  );
}

async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.unmount());
  _fixture.container.remove();
  vi.unstubAllGlobals();
}

describe("WordFileExportDialog", () => {
  it("starts exactly one export when a first-use Pandoc install finishes", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    let completeExport!: (value: unknown) => void;
    exportWordFile.mockReturnValue(
      new Promise((resolve) => {
        completeExport = resolve;
      }),
    );
    const savedRevision = vi.fn(async () => revision);
    const onClose = vi.fn();
    await act(
      async () =>
        await _fixture.root0.rerender(
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
      diagramCapture: { sourceDigest: revision, diagrams: [] },
    });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => completeExport({ file: { fileName: "report.docx" }, warnings: [] }));
    expect(saveConversationExport).toHaveBeenCalledOnce();
    expect(exportWordFile).toHaveBeenCalledOnce();
  });

  it("reads Pandoc's state again after a failed export, so a reinstall can be offered", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    readPandocTool.mockResolvedValue(status(true));
    exportWordFile.mockRejectedValue(new Error("Scient could not start Pandoc."));
    await act(
      async () =>
        await _fixture.root0.rerender(
          <WordFileExportDialog
            environmentId={environmentId}
            cwd="/project"
            relativePath="notes/report.md"
            savedRevision={async () => revision}
            onClose={() => {}}
          />,
        ),
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(exportWordFile).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain("Scient could not start Pandoc.");
    expect(readPandocTool.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    container: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
