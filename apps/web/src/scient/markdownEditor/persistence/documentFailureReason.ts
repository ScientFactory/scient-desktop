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

function fileFailures(error: unknown) {
  const reasons = Cause.isCause(error)
    ? error.reasons.flatMap((reason) => (reason._tag === "Fail" ? [reason.error] : []))
    : [error];
  return reasons.filter(
    (reason) =>
      isWriteFailure(reason) ||
      isReadFailure(reason) ||
      isRenameFailure(reason) ||
      isDeleteFailure(reason),
  );
}

/** What the workspace said about a failed file operation, when it said anything. */
export function documentFailureReason(error: unknown): string | null {
  return fileFailures(error)[0]?.message ?? null;
}

const PLAIN_OS_REASONS: Readonly<Record<string, string>> = {
  ENOSPC: "the disk is full",
  EDQUOT: "the disk is full",
  EACCES: "the file is locked or protected",
  EPERM: "the file is locked or protected",
  EBUSY: "another program is using the file",
  ETXTBSY: "another program is using the file",
  EROFS: "the disk is read-only",
  ENOENT: "the file or its folder is missing",
  ENAMETOOLONG: "the name is too long",
  EIO: "the disk reported an error",
};
const failureCode = (failure: ReturnType<typeof fileFailures>[number]) =>
  "osErrorCode" in failure && typeof failure.osErrorCode === "string" ? failure.osErrorCode : null;
const failureKind = (failure: ReturnType<typeof fileFailures>[number]) =>
  "reason" in failure && typeof failure.reason === "string" ? failure.reason : null;

/** A short cause in plain words for a failed file operation, when the system named one. */
export function documentFailurePlainReason(error: unknown): string | null {
  for (const failure of fileFailures(error)) {
    const code = failureCode(failure);
    const plain = code === null ? undefined : PLAIN_OS_REASONS[code];
    if (plain) return plain;
    const kind = failureKind(failure);
    if (kind === "permission_denied") return PLAIN_OS_REASONS.EACCES!;
    if (kind === "not_found") return PLAIN_OS_REASONS.ENOENT!;
  }
  return null;
}

/** The operating system's code for a failed file operation, for bug reports. */
export function documentFailureCode(error: unknown): string | null {
  for (const failure of fileFailures(error)) {
    const code = failureCode(failure);
    if (code) return code;
  }
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
