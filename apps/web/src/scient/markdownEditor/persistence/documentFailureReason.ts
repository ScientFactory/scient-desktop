import { ProjectReadFileError, ProjectWriteFileError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";

const isReadFailure = Schema.is(ProjectReadFileError);
const isWriteFailure = Schema.is(ProjectWriteFileError);

/** What the workspace said about a failed read or write, when it said anything. */
export function documentFailureReason(error: unknown): string | null {
  const reasons = Cause.isCause(error)
    ? error.reasons.flatMap((reason) => (reason._tag === "Fail" ? [reason.error] : []))
    : [error];
  for (const reason of reasons)
    if (isWriteFailure(reason) || isReadFailure(reason)) return reason.message;
  return null;
}
