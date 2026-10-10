import {
  ArtifactAuthority,
  ArtifactId,
  ArtifactRevisionId,
  BindingGeneration,
  LogicalDocumentKey,
  PdfSourceDescriptor,
} from "@scientfactory/document-artifacts";
import { EnvironmentId, ThreadId, type ScientDocumentHostRequest } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  renderHtmlPdf: vi.fn(),
  renderDocumentPagePdfForHost: vi.fn(),
  openScient: vi.fn(),
  openFile: vi.fn(),
}));
vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: { renderHtmlPdf: mocks.renderHtmlPdf },
}));
vi.mock("./documentPagePdf", () => ({
  renderDocumentPagePdfForHost: mocks.renderDocumentPagePdfForHost,
}));
vi.mock("~/rightPanelStore", () => ({ useRightPanelStore: { getState: () => mocks } }));
vi.mock("~/assets/assetUrls", () => ({
  resolveAssetUrl: (base: string, path: string) => (path.startsWith("/") ? `${base}${path}` : null),
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: [] }),
  useEnvironmentHttpBaseUrl: () => null,
}));
vi.mock("~/state/scientDocumentPdf", () => ({ scientDocumentPdfEnvironment: {} }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: vi.fn() }));
import { executeScientDocumentHostRequest } from "./documentHost";

const environmentId = EnvironmentId.make("documents-host");
const threadId = ThreadId.make("background-build");
const request = (operation: ScientDocumentHostRequest["operation"], input: unknown) =>
  ({
    requestId: "build-1",
    threadId,
    timeoutMs: 15_000,
    operation,
    input,
  }) as ScientDocumentHostRequest;
beforeEach(() => vi.clearAllMocks());

describe("controlled document host", () => {
  it("renders a signed HTML source without opening or synchronizing an interactive tab", async () => {
    mocks.renderHtmlPdf.mockResolvedValue({
      title: "Study",
      sourceUrl: "http://localhost:3773/assets/study.html",
      profile: "source-authored",
      media: "print",
      warnings: [],
      sourceSignals: [],
      blockedRequestCount: 2,
      data: new Uint8Array([37, 80, 68, 70]),
    });
    const result = await executeScientDocumentHostRequest(
      environmentId,
      "http://localhost:3773",
      request("documentPdfRender", { assetRelativeUrl: "/assets/study.html" }),
    );
    expect(mocks.renderHtmlPdf).toHaveBeenCalledExactlyOnceWith(
      "http://localhost:3773/assets/study.html",
    );
    expect(result).toMatchObject({ bytesBase64: "JVBERg", blockedRequestCount: 2, media: "print" });
    expect(mocks.openFile).not.toHaveBeenCalled();
    expect(mocks.openScient).not.toHaveBeenCalled();
  });
  it("rejects missing connection or invalid signed source before invoking the renderer", async () => {
    await expect(
      executeScientDocumentHostRequest(
        environmentId,
        null,
        request("documentPdfRender", { assetRelativeUrl: "/asset" }),
      ),
    ).rejects.toThrow("unavailable");
    await expect(
      executeScientDocumentHostRequest(
        environmentId,
        "http://localhost:3773",
        request("documentPdfRender", { assetRelativeUrl: "https://external.example" }),
      ),
    ).rejects.toThrow("invalid");
    expect(mocks.renderHtmlPdf).not.toHaveBeenCalled();
  });
  it("uses the captured document page renderer and returns its rejection faithfully", async () => {
    const input = { inputRelativeUrl: "/capture", expected: { captureId: "capture" } };
    const rejected = { _tag: "rejected", reason: "not-ready", detail: "Images are incomplete" };
    mocks.renderDocumentPagePdfForHost.mockResolvedValue(rejected);
    expect(
      await executeScientDocumentHostRequest(
        environmentId,
        "http://localhost:3773",
        request("documentPagePdfRender", input),
      ),
    ).toBe(rejected);
    expect(mocks.renderDocumentPagePdfForHost).toHaveBeenCalledExactlyOnceWith(
      "http://localhost:3773",
      input,
    );
  });
  it("presents a generated PDF on the request's background thread", async () => {
    const source = PdfSourceDescriptor.make({
      _tag: "generated-pdf",
      authority: ArtifactAuthority.make("documents-host"),
      logicalDocumentKey: LogicalDocumentKey.make("study"),
      title: "Study",
      fileName: "Study.pdf",
      capabilities: { canSaveCopy: true, canRevealSource: false },
      artifactId: ArtifactId.make("study"),
      revisionId: ArtifactRevisionId.make("r1"),
      bindingGeneration: BindingGeneration.make(1),
      bindingStatus: "current",
      staleReason: null,
      pageCount: 1,
    });
    await executeScientDocumentHostRequest(
      environmentId,
      null,
      request("documentPdfPresent", { source }),
    );
    expect(mocks.openScient).toHaveBeenCalledWith(
      { environmentId, threadId },
      expect.objectContaining({ module: "generated-pdf", source }),
    );
  });
  it("presents the LaTeX source in Split with its resolved root without persisting a preview preference", async () => {
    await executeScientDocumentHostRequest(
      environmentId,
      null,
      request("documentLatexPresent", {
        sourcePath: "papers/chapter.tex",
        rootSourcePath: "papers/main.tex",
      }),
    );
    expect(mocks.openFile).toHaveBeenCalledExactlyOnceWith(
      { environmentId, threadId },
      "papers/chapter.tex",
      undefined,
      { latexPreviewMode: "split", latexRootRelativePath: "papers/main.tex" },
    );
  });
});
