import { AnalysisOperationError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

import { analysisOperationReason } from "./analysisRunUiState";

describe("analysis run UI state", () => {
  it("recognizes an uninitialized project without conflating unrelated failures", () => {
    const uninitialized = AsyncResult.failure(
      Cause.fail(
        new AnalysisOperationError({
          operation: "list",
          reason: "project-not-initialized",
          message: "Initialize this folder.",
        }),
      ),
    );
    const unrelated = AsyncResult.failure(Cause.fail(new Error("connection closed")));

    expect(analysisOperationReason(uninitialized)).toBe("project-not-initialized");
    expect(analysisOperationReason(unrelated)).toBeNull();
    expect(analysisOperationReason(AsyncResult.success({}))).toBeNull();
  });
});
