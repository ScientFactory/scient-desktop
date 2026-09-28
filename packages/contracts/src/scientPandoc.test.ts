import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ScientPandocToolStatus,
  ScientWordExportError,
  ScientWordFileExportRequest,
  ScientWordFileExportResult,
} from "./scientPandoc.ts";
import { ScientWordDiagramCapture } from "./scientConversationExport.ts";

const decodeToolStatus = Schema.decodeUnknownSync(ScientPandocToolStatus);
const decodeFileRequest = Schema.decodeUnknownSync(ScientWordFileExportRequest);
const decodeFileResult = Schema.decodeUnknownSync(ScientWordFileExportResult);
const decodeDiagramCapture = Schema.decodeUnknownSync(ScientWordDiagramCapture);

describe("Word export contracts", () => {
  it("bounds aggregate PNG payload before export service decoding", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const entry = (n: number) => ({
      id: `mermaid-${n.toString(16).padStart(16, "0")}`,
      result: { _tag: "png", base64: "A".repeat(2_000_000) },
    });
    expect(() =>
      decodeDiagramCapture({
        sourceDigest: digest,
        diagrams: Array.from({ length: 6 }, (_, n) => entry(n)),
      }),
    ).toThrow();
    expect(
      decodeDiagramCapture({ sourceDigest: digest, diagrams: [entry(0)] }).diagrams,
    ).toHaveLength(1);
  });

  it("decodes the managed tool's status while an install runs", () => {
    const status = decodeToolStatus({
      version: "3.11",
      installed: false,
      canInstall: true,
      unavailableReason: null,
      downloadBytes: 41_832_712,
      install: {
        state: "downloading",
        bytesReceived: 1_048_576,
        totalBytes: 41_832_712,
        failureReason: null,
        updatedAtEpochMs: 1,
      },
    });
    expect(status.install.state).toBe("downloading");
    expect(() =>
      decodeToolStatus({
        ...status,
        install: { ...status.install, state: "compiling" },
      }),
    ).toThrow();
  });

  it("requires the editor's revision to export a project file", () => {
    expect(() =>
      decodeFileRequest({
        cwd: "/work/project",
        relativePath: "notes/report.md",
      }),
    ).toThrow();
    expect(
      decodeFileRequest({
        cwd: "/work/project",
        relativePath: "notes/report.md",
        revision: "sha256:abc",
      }).revision,
    ).toBe("sha256:abc");
  });

  it("returns a signed file and one-line warnings", () => {
    const result = decodeFileResult({
      file: {
        fileName: "report.docx",
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        byteLength: 2_048,
        relativeUrl: "/api/assets/signed",
        expiresAt: 10,
      },
      warnings: [{ code: "resource-unresolved", message: "Image “plot.png” was not embedded." }],
    });
    expect(result.warnings).toHaveLength(1);
    const error = new ScientWordExportError({ reason: "file-changed", message: "Save first." });
    expect(error.reason).toBe("file-changed");
  });
});
