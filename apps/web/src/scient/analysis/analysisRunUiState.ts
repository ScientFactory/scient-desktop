import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

export function analysisOperationReason(
  result: AsyncResult.AsyncResult<unknown, unknown>,
): string | null {
  if (result._tag !== "Failure") return null;
  const error = Cause.squash(result.cause);
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { readonly _tag?: unknown; readonly reason?: unknown };
  return candidate._tag === "AnalysisOperationError" && typeof candidate.reason === "string"
    ? candidate.reason
    : null;
}
