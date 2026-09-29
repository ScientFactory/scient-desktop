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

  it("does not offer a retry that cannot succeed for paths outside the project", () => {
    for (const failure of ["workspace_path_outside_root", "resolved_path_outside_root"] as const) {
      expect(fileReadFailureCopy({ failure, message: "outside" })).toMatchObject({
        title: "Outside this project",
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

  it("names a non-file path", () => {
    expect(fileReadFailureCopy({ failure: "path_not_file", message: null })).toMatchObject({
      title: "Not a file",
      details: null,
      retryable: true,
    });
  });
});
