import { ProjectReadFileError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import { documentCurrentMissingReview, documentFailureReason } from "./documentFailureReason";

const context = { cwd: "/synthetic", relativePath: "paper.tex" };

describe("the reason shown for a failed save or read", () => {
  it("is absent for a defect, an interruption or a lost connection", () => {
    expect(documentFailureReason(Cause.die(new Error("protocol failure")))).toBeNull();
    expect(documentFailureReason(new Error("Disconnected"))).toBeNull();
    expect(documentFailureReason(null)).toBeNull();
  });

  it("distinguishes qualified physical absence from ordinary missing referents, roots, permission errors, and other targets", () => {
    const qualified = new ProjectReadFileError({
      ...context,
      failure: "operation_failed",
      reason: "not_found",
      currentMissing: true,
    });
    expect(documentCurrentMissingReview(Cause.fail(qualified), context)).toEqual({
      missing: true,
      revision: null,
    });
    for (const error of [
      new ProjectReadFileError({ ...context, failure: "operation_failed", reason: "not_found" }),
      new ProjectReadFileError({
        ...context,
        failure: "operation_failed",
        reason: "permission_denied",
      }),
      new ProjectReadFileError({
        ...context,
        relativePath: "other.tex",
        failure: "operation_failed",
        reason: "not_found",
        currentMissing: true,
      }),
      new ProjectReadFileError({
        ...context,
        cwd: "/other-root",
        failure: "operation_failed",
        reason: "not_found",
        currentMissing: true,
      }),
      { ...qualified, _tag: "OtherFailure" },
    ])
      expect(documentCurrentMissingReview(Cause.fail(error), context)).toBeNull();
    expect(
      documentCurrentMissingReview(
        Cause.combine(Cause.fail(qualified), Cause.die(new Error("Root defect"))),
        context,
      ),
    ).toBeNull();
  });

  it("preserves remaining retained attention in a qualified missing read", () => {
    const error = new ProjectReadFileError({
      ...context,
      failure: "operation_failed",
      reason: "not_found",
      currentMissing: true,
      publicationOutcome: "retained-attention",
      recoveryId: "remaining",
      mutationId: "original",
      retainedPaths: ["/retained/paper.tex"],
    });
    expect(documentCurrentMissingReview(error, context)).toMatchObject({
      missing: true,
      revision: null,
      publicationAttention: {
        recoveryId: "remaining",
        mutationId: "original",
        retainedPaths: ["/retained/paper.tex"],
      },
    });
  });
});
