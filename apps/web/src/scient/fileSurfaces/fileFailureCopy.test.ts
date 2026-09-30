import { describe, expect, it } from "vite-plus/test";

import { fileReadFailureCopy, UNSUPPORTED_PREVIEW_TITLE } from "./fileFailureCopy";

describe("fileReadFailureCopy", () => {
  it("presents a binary file as an unsupported preview without a retry", () => {
    expect(
      fileReadFailureCopy({ failure: "binary_file", message: "File 'a.zip' is binary." }),
    ).toEqual({
      title: UNSUPPORTED_PREVIEW_TITLE,
      description: "Scient can't preview this type of file yet.",
      details: null,
      retryable: false,
    });
  });

  it("tells an older server's outside-the-project refusal apart from a dead end", () => {
    for (const failure of ["workspace_path_outside_root", "resolved_path_outside_root"] as const) {
      expect(fileReadFailureCopy({ failure, message: "outside" })).toEqual({
        title: "Outside this project",
        description: "This file is outside the project folder. You can still open it read-only.",
        details: "outside",
        retryable: false,
      });
    }
  });

  it("keeps an unclassified failure generic and moves the raw error into details", () => {
    const raw = "Failed to open '/tmp/report.md': ENOENT: no such file or directory";
    expect(fileReadFailureCopy({ failure: "operation_failed", message: raw })).toEqual({
      title: "Couldn't open this file",
      description: "It may have been moved, renamed, or deleted, or it can't be read right now.",
      details: raw,
      retryable: true,
    });
    expect(fileReadFailureCopy({ failure: null, message: "  " })).toMatchObject({
      title: "Couldn't open this file",
      details: null,
      retryable: true,
    });
  });

  it("names a missing file when the server reports why the read failed", () => {
    expect(
      fileReadFailureCopy({ failure: "operation_failed", reason: "not_found", message: "raw" }),
    ).toEqual({
      title: "File not found",
      description: "Nothing exists at this location. It may have been moved, renamed, or deleted.",
      details: "raw",
      retryable: true,
    });
  });

  it("names a permission failure when the server reports one", () => {
    expect(
      fileReadFailureCopy({
        failure: "operation_failed",
        reason: "permission_denied",
        message: null,
      }),
    ).toMatchObject({ title: "Access denied", details: null, retryable: true });
  });

  it("names a non-file path", () => {
    expect(fileReadFailureCopy({ failure: "path_not_file", message: null })).toMatchObject({
      title: "Not a file",
      details: null,
      retryable: true,
    });
  });
});
