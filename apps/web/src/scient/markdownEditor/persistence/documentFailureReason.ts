import type {
  DocumentFilePublicationAttention,
  DocumentPersistenceCurrentReview,
} from "@scientfactory/scient-document";
import {
  ProjectDeleteFileError,
  ProjectReadFileError,
  ProjectRenameFileError,
  ProjectWriteFileError,
  type ProjectFilePublicationOutcome,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";

const isReadFailure = Schema.is(ProjectReadFileError);
const isWriteFailure = Schema.is(ProjectWriteFileError);
const isRenameFailure = Schema.is(ProjectRenameFileError);
const isDeleteFailure = Schema.is(ProjectDeleteFileError);

/** What the workspace said about a failed file operation, when it said anything. */
export function documentFailureReason(error: unknown): string | null {
  const reasons = Cause.isCause(error)
    ? error.reasons.flatMap((reason) => (reason._tag === "Fail" ? [reason.error] : []))
    : [error];
  for (const reason of reasons)
    if (
      isWriteFailure(reason) ||
      isReadFailure(reason) ||
      isRenameFailure(reason) ||
      isDeleteFailure(reason)
    )
      return reason.message;
  return null;
}

export function describeDocumentPublicationAttention(
  error: unknown,
  mutationId?: string,
): DocumentFilePublicationAttention | null {
  const reasons = Cause.isCause(error)
    ? error.reasons.flatMap((reason) => (reason._tag === "Fail" ? [reason.error] : []))
    : [error];
  for (const reason of reasons) {
    if (
      (isWriteFailure(reason) ||
        isReadFailure(reason) ||
        isRenameFailure(reason) ||
        isDeleteFailure(reason)) &&
      (reason.publicationOutcome === "retained-attention" ||
        reason.failure === "recovery_required") &&
      reason.recoveryId !== undefined &&
      reason.retainedPaths !== undefined &&
      (reason.mutationId ?? mutationId) !== undefined
    )
      return {
        recoveryId: reason.recoveryId,
        mutationId: (reason.mutationId ?? mutationId)!,
        retainedPaths: reason.retainedPaths,
        message: reason.message,
      };
  }
  return null;
}

/** Only the backend can prove a refusal did not admit namespace work. */
export function documentPublicationOutcome(error: unknown): ProjectFilePublicationOutcome | null {
  const reasons = Cause.isCause(error) ? error.reasons : [{ _tag: "Fail", error } as const];
  let unchanged = reasons.length > 0;
  for (const reason of reasons) {
    if (reason._tag !== "Fail") {
      unchanged = false;
      continue;
    }
    const value = reason.error;
    if (
      isWriteFailure(value) ||
      isReadFailure(value) ||
      isRenameFailure(value) ||
      isDeleteFailure(value)
    ) {
      if (value.publicationOutcome === "retained-attention") return "retained-attention";
      if (value.publicationOutcome !== "unchanged") unchanged = false;
    } else unchanged = false;
  }
  return unchanged ? "unchanged" : null;
}

/** Only an exact, backend-confirmed absent pathname is a missing-current review. */
export function documentCurrentMissingReview(
  error: unknown,
  target: { readonly cwd: string; readonly relativePath: string },
): Extract<DocumentPersistenceCurrentReview, { readonly missing: true }> | null {
  const reasons = Cause.isCause(error) ? error.reasons : [{ _tag: "Fail", error } as const];
  if (
    reasons.length === 0 ||
    !reasons.every(
      (reason) =>
        reason._tag === "Fail" &&
        isReadFailure(reason.error) &&
        reason.error.failure === "operation_failed" &&
        reason.error.reason === "not_found" &&
        reason.error.currentMissing === true &&
        reason.error.cwd === target.cwd &&
        reason.error.relativePath === target.relativePath,
    )
  )
    return null;
  const publicationAttention = describeDocumentPublicationAttention(error);
  return {
    missing: true,
    revision: null,
    ...(publicationAttention ? { publicationAttention } : {}),
  };
}
