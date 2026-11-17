import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import { ControlledHtmlPdfRenderRequest } from "../htmlPdfBuild.ts";
import { ScientCloudShareBlob } from "../scientCloud.ts";
import { ScientConversationExportFile } from "../scientConversationExport.ts";
import { ScientDocumentPageRenderRequest } from "../scientDocumentExport.ts";

const SIGNED_PATH = "/api/assets/eyJraW5kIjoiZmlsZSJ9.Zm9v-YmFy_Yg/Export%20design%20(1).md";
const LOCAL_SERVICE = "http://127.0.0.1:8080/api/assets/token/file.md";

const isExportFile = Schema.is(ScientConversationExportFile);
const exportFile = (relativeUrl: string) => ({
  fileName: "Export design.md",
  mediaType: "text/markdown; charset=utf-8",
  byteLength: 120,
  relativeUrl,
  expiresAt: 1,
});

describe("signed asset download paths", () => {
  it("accept the path the server signs, up to the export's length limit", () => {
    expect(isExportFile(exportFile(SIGNED_PATH))).toBe(true);
    expect(isExportFile(exportFile(`/api/assets/${"a".repeat(7_000)}/file.md`))).toBe(true);
  });

  it.each([
    ["an absolute URL", LOCAL_SERVICE],
    ["a protocol-relative URL", "//127.0.0.1:8080/api/assets/token/file.md"],
    ["a path outside the asset route", "/api/orchestration/token/file.md"],
    ["a dot-segment token", "/api/assets/../file.md"],
    ["a dot-segment file name", "/api/assets/token/.."],
    ["an encoded dot-segment file name", "/api/assets/token/%2e%2E"],
    ["a nested file path", "/api/assets/token/dir/file.md"],
    ["a query", "/api/assets/token/file.md?next=1"],
  ])("refuse %s", (_case, relativeUrl) => {
    expect(isExportFile(exportFile(relativeUrl))).toBe(false);
  });

  it.each([
    [
      "cloud share blob",
      Schema.is(ScientCloudShareBlob),
      (relativeUrl: string) => ({
        localId: "attachment-1",
        sha256: "a".repeat(64),
        bytes: 3,
        name: "decay.png",
        mimeType: "image/png",
        relativeUrl,
      }),
    ],
    [
      "HTML PDF render request",
      Schema.is(ControlledHtmlPdfRenderRequest),
      (assetRelativeUrl: string) => ({ assetRelativeUrl }),
    ],
    [
      "document page render request",
      Schema.is(ScientDocumentPageRenderRequest),
      (inputRelativeUrl: string) => ({
        inputRelativeUrl,
        expected: {
          captureId: "00000000-0000-4000-8000-000000000000",
          documentKind: "conversation",
          sourceDigest: `sha256:${"a".repeat(64)}`,
        },
      }),
    ],
  ] as const)("hold for the %s", (_name, is, make) => {
    expect(is(make(SIGNED_PATH))).toBe(true);
    expect(is(make(LOCAL_SERVICE))).toBe(false);
  });
});
