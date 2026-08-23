import {
  ArtifactAuthority,
  ArtifactId,
  ArtifactRevisionId,
  BindingGeneration,
  LogicalDocumentKey,
  PdfSourceDescriptor,
  type AssetCopyResult,
} from "@scientfactory/document-artifacts";
import { EnvironmentId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  createAssetUrl: vi.fn(),
  httpBaseUrl: "https://environment.scient.test/base/" as string | null,
  saveAssetCopy: vi.fn(),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({ documents: { saveAssetCopy: mocks.saveAssetCopy } }),
}));
vi.mock("~/state/assets", () => ({ assetEnvironment: { createUrl: vi.fn() } }));
vi.mock("~/state/environments", () => ({
  useEnvironmentHttpBaseUrl: () => mocks.httpBaseUrl,
}));
vi.mock("~/state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => mocks.createAssetUrl,
}));

import { usePdfSaveCopy } from "./usePdfSaveCopy";

const environmentId = EnvironmentId.make("environment-1");
const source = PdfSourceDescriptor.make({
  _tag: "generated-pdf",
  authority: ArtifactAuthority.make(environmentId),
  logicalDocumentKey: LogicalDocumentKey.make("browser-export:report"),
  title: "Report",
  fileName: "Report.pdf",
  capabilities: { canSaveCopy: true, canRevealSource: false },
  artifactId: ArtifactId.make("artifact-1"),
  revisionId: ArtifactRevisionId.make("revision-1"),
  bindingGeneration: BindingGeneration.make(1),
  bindingStatus: "current",
  staleReason: null,
});

let saveCopy: ((source: PdfSourceDescriptor) => Promise<AssetCopyResult>) | null = null;

function CaptureHook() {
  saveCopy = usePdfSaveCopy(environmentId);
  return null;
}

describe("usePdfSaveCopy", () => {
  beforeEach(() => {
    saveCopy = null;
    mocks.httpBaseUrl = "https://environment.scient.test/base/";
    mocks.createAssetUrl.mockReset();
    mocks.saveAssetCopy.mockReset();
    mocks.createAssetUrl.mockResolvedValue({
      _tag: "Success",
      value: {
        relativeUrl: "/api/assets/signed-token/report.pdf",
        expiresAt: 123_456,
      },
    });
    mocks.saveAssetCopy.mockResolvedValue({ _tag: "saved", path: "/tmp/Report.pdf" });
    renderToStaticMarkup(<CaptureHook />);
  });

  it("authorizes the generated revision and delegates to the existing Save Copy host", async () => {
    await expect(saveCopy?.(source)).resolves.toEqual({
      _tag: "saved",
      path: "/tmp/Report.pdf",
    });

    expect(mocks.createAssetUrl).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: {
        resource: {
          _tag: "generated-document",
          authority: "environment-1",
          artifactId: "artifact-1",
          revisionId: "revision-1",
        },
      },
    });
    expect(mocks.saveAssetCopy).toHaveBeenCalledWith({
      url: "https://environment.scient.test/api/assets/signed-token/report.pdf",
      suggestedFileName: "Report.pdf",
    });
  });

  it("fails before opening a Save dialog when the environment is disconnected", async () => {
    mocks.httpBaseUrl = null;
    renderToStaticMarkup(<CaptureHook />);

    await expect(saveCopy?.(source)).rejects.toThrow("environment connection is unavailable");
    expect(mocks.createAssetUrl).not.toHaveBeenCalled();
    expect(mocks.saveAssetCopy).not.toHaveBeenCalled();
  });

  it("does not authorize a source through the wrong environment connection", async () => {
    const otherEnvironmentSource = PdfSourceDescriptor.make({
      ...source,
      authority: ArtifactAuthority.make("environment-2"),
    });

    await expect(saveCopy?.(otherEnvironmentSource)).rejects.toThrow(
      "belongs to a different environment",
    );
    expect(mocks.createAssetUrl).not.toHaveBeenCalled();
    expect(mocks.saveAssetCopy).not.toHaveBeenCalled();
  });
});
