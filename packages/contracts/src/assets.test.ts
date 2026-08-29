import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { AssetCreateUrlResult, AssetResource, AttachmentCreateUploadUrlInput } from "./assets.ts";
import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "./orchestration.ts";

const decodeAssetResource = Schema.decodeUnknownSync(AssetResource);
const decodeAssetCreateUrlResult = Schema.decodeUnknownSync(AssetCreateUrlResult);
const decodeLegacyWorkspaceFile = Schema.decodeUnknownSync(
  Schema.TaggedStruct("workspace-file", {
    threadId: Schema.String,
    path: Schema.String,
  }),
);

describe("AssetResource", () => {
  it("accepts a workspace-rooted file without a thread", () => {
    expect(
      decodeAssetResource({
        _tag: "workspace-file",
        cwd: "/workspace",
        relativePath: "reports/דוח.pdf",
      }),
    ).toEqual({
      _tag: "workspace-file",
      cwd: "/workspace",
      relativePath: "reports/דוח.pdf",
    });
  });

  it("retains the legacy thread locator for version compatibility", () => {
    expect(
      decodeAssetResource({
        _tag: "workspace-file",
        threadId: "thread-1",
        path: "/workspace/reports/paper.pdf",
      }),
    ).toMatchObject({ threadId: "thread-1", path: "/workspace/reports/paper.pdf" });
  });

  it("accepts both locators during a rolling client/server upgrade", () => {
    const resource = decodeAssetResource({
      _tag: "workspace-file",
      cwd: "/workspace",
      relativePath: "reports/paper.pdf",
      threadId: "thread-1",
      path: "/workspace/reports/paper.pdf",
    });

    expect(resource).toMatchObject({ cwd: "/workspace", relativePath: "reports/paper.pdf" });
    expect(decodeLegacyWorkspaceFile(resource)).toEqual({
      _tag: "workspace-file",
      threadId: "thread-1",
      path: "/workspace/reports/paper.pdf",
    });
  });

  it.each([
    { _tag: "workspace-file" },
    { _tag: "workspace-file", cwd: "/workspace" },
    { _tag: "workspace-file", relativePath: "paper.pdf" },
    { _tag: "workspace-file", threadId: "thread-1" },
    { _tag: "workspace-file", path: "/workspace/paper.pdf" },
  ])("rejects an incomplete workspace locator: %j", (resource) => {
    expect(() => decodeAssetResource(resource)).toThrow();
  });

  it("accepts exact and HTML-document environment capabilities", () => {
    expect(
      decodeAssetResource({
        _tag: "environment-file",
        path: "/Users/researcher/report.html",
        access: "html-document",
      }),
    ).toMatchObject({ access: "html-document" });
    expect(
      decodeAssetResource({
        _tag: "environment-file",
        path: "C:\\Research\\paper.pdf",
        access: "exact",
      }),
    ).toMatchObject({ access: "exact" });
  });

  it("rejects incomplete or unsafe environment capabilities", () => {
    expect(() =>
      decodeAssetResource({ _tag: "environment-file", path: "/tmp/file.txt" }),
    ).toThrow();
    expect(() =>
      decodeAssetResource({
        _tag: "environment-file",
        path: "/tmp/file\0.txt",
        access: "exact",
      }),
    ).toThrow();
  });

  it("allows signed URLs large enough to carry a maximum environment path", () => {
    const relativeUrl = `/api/assets/${"a".repeat(7_000)}/paper.pdf`;
    expect(
      decodeAssetCreateUrlResult({
        relativeUrl,
        expiresAt: 1,
        sourcePath: `/${"p".repeat(4_000)}`,
      }).relativeUrl,
    ).toBe(relativeUrl);
  });
});

const isUploadInput = Schema.is(AttachmentCreateUploadUrlInput);

const uploadInput = {
  name: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 3,
} as const;

describe("AttachmentCreateUploadUrlInput", () => {
  it("accepts supported image attachments", () => {
    expect(isUploadInput(uploadInput)).toBe(true);
  });

  it("rejects image types that providers do not support", () => {
    expect(isUploadInput({ ...uploadInput, mimeType: "image/svg+xml" })).toBe(false);
  });

  it("accepts generic files without treating them as provider images", () => {
    expect(
      isUploadInput({
        type: "file",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1,
      }),
    ).toBe(true);
    expect(
      isUploadInput({
        type: "file",
        name: "diagram.svg",
        mimeType: "image/svg+xml",
        sizeBytes: 3,
      }),
    ).toBe(true);
  });

  it("rejects empty and oversized uploads", () => {
    expect(isUploadInput({ ...uploadInput, sizeBytes: 0 })).toBe(false);
    expect(
      isUploadInput({ ...uploadInput, sizeBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1 }),
    ).toBe(false);
    expect(
      isUploadInput({
        type: "file",
        name: "archive.zip",
        mimeType: "application/zip",
        sizeBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1,
      }),
    ).toBe(false);
  });
});
