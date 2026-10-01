import { describe, expect, it } from "vite-plus/test";

import {
  fileReadFailureCopy,
  readFailureBlocksPreview,
  refreshFailureNoticeCopy,
  staleCopyNotice,
  UNSUPPORTED_PREVIEW_TITLE,
} from "./fileFailureCopy";

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

  it("turns a missing file with candidates into a question", () => {
    expect(
      fileReadFailureCopy({
        failure: "operation_failed",
        reason: "not_found",
        message: null,
        candidateCount: 2,
      }),
    ).toMatchObject({ title: "Which file did you mean?", retryable: true });
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

  it("says only what the operating system reported for a denied read", () => {
    const denied = (osErrorCode: string | null, hostOs: string | null) =>
      fileReadFailureCopy({
        failure: "operation_failed",
        reason: "permission_denied",
        osErrorCode,
        hostOs,
        message: null,
      }).description;

    // A plain permission problem is not a privacy setting, on any system.
    expect(denied("EACCES", "darwin")).toContain("permissions of the file and its folders");
    expect(denied("EACCES", "darwin")).not.toContain("Privacy");
    // Only the code macOS uses when the system itself declines mentions it,
    // conditionally, and as a setting on the computer that holds the file.
    expect(denied("EPERM", "darwin")).toContain("If it is in a protected folder");
    expect(denied("EPERM", "darwin")).toContain("Privacy & Security there");
    expect(denied("EPERM", "linux")).toBe("The operating system denied access to this file.");
    // An older server reports no code: nothing more specific is claimed.
    expect(denied(null, "darwin")).toBe("The operating system denied access to this file.");
  });

  it("names a non-file path", () => {
    expect(fileReadFailureCopy({ failure: "path_not_file", message: null })).toMatchObject({
      title: "Not a file",
      details: null,
      retryable: true,
    });
  });
});

describe("readFailureBlocksPreview", () => {
  const failed = { hasData: false, failure: "operation_failed" as const, isHostFile: false };

  it("shows the explained failure instead of a media viewer that would fail again", () => {
    expect(readFailureBlocksPreview({ ...failed, reason: "not_found" })).toBe(true);
    expect(readFailureBlocksPreview({ ...failed, reason: "permission_denied" })).toBe(true);
    expect(
      readFailureBlocksPreview({
        hasData: false,
        failure: "path_not_file",
        reason: null,
        isHostFile: true,
      }),
    ).toBe(true);
  });

  it("lets viewers handle binary media, workspace folders, and readable files", () => {
    expect(readFailureBlocksPreview({ ...failed, failure: "binary_file", reason: null })).toBe(
      false,
    );
    expect(
      readFailureBlocksPreview({
        hasData: false,
        failure: "path_not_file",
        reason: null,
        isHostFile: false,
      }),
    ).toBe(false);
    expect(readFailureBlocksPreview({ ...failed, hasData: true, reason: "not_found" })).toBe(false);
  });
});

describe("staleCopyNotice", () => {
  it("says why the open file could not be refreshed when the system said so", () => {
    expect(staleCopyNotice("not_found")).toBe(
      "This file is no longer at this location. Showing the last available copy.",
    );
    expect(staleCopyNotice("permission_denied")).toContain("can no longer be read");
    expect(staleCopyNotice(null)).toBe(
      "The latest version could not be loaded. Showing the last available copy.",
    );
  });
});

describe("refreshFailureNoticeCopy", () => {
  it("names a moved file and a denied read, and claims nothing without a reason", () => {
    expect(refreshFailureNoticeCopy({ reason: "not_found", osErrorCode: "ENOENT" }, null)).toEqual({
      title: "This file is no longer at this location",
      description:
        "It may have been moved, renamed, or deleted. The last confirmed version is still open.",
    });
    const denied = refreshFailureNoticeCopy(
      { reason: "permission_denied", osErrorCode: "EACCES" },
      "darwin",
    );
    expect(denied?.title).toBe("This file can no longer be read");
    expect(denied?.description).toContain("permissions of the file and its folders");
    expect(denied?.description).toContain("The last confirmed version is still open.");
    expect(refreshFailureNoticeCopy(null, "darwin")).toBeNull();
  });
});
