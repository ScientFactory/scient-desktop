import { ProjectReadFileError, ProjectWriteFileError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import { documentFailureReason } from "./documentFailureReason";

const context = { cwd: "/synthetic", relativePath: "paper.tex" };

describe("the reason shown for a failed save or read", () => {
  it("is what the workspace reported, whether or not it arrives inside a cause", () => {
    const readOnly = new ProjectWriteFileError({ ...context, failure: "read_only_in_files" });
    expect(documentFailureReason(readOnly)).toBe(
      "Workspace file 'paper.tex' is read-only in Files.",
    );
    expect(documentFailureReason(Cause.fail(readOnly))).toBe(readOnly.message);
    const unreadable = new ProjectReadFileError({ ...context, failure: "operation_failed" });
    expect(documentFailureReason(Cause.fail(unreadable))).toBe(unreadable.message);
  });

  it("is absent for a defect, an interruption or a lost connection", () => {
    expect(documentFailureReason(Cause.die(new Error("protocol failure")))).toBeNull();
    expect(documentFailureReason(new Error("Disconnected"))).toBeNull();
    expect(documentFailureReason(null)).toBeNull();
  });
});
