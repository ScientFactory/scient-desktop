/**
 * The operating system's code and reason for a failed project file
 * operation, which ws.ts adds to the shared file failure context.
 *
 * @module ProjectFileErrorReason
 */
import type { ProjectFileErrorReason } from "@t3tools/contracts";

/** The operating system's error code for a failed file operation, when it gave one. */
export function projectFileOsErrorCode(cause: unknown): string | undefined {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/u.test(code) ? code : undefined;
}

/** The operating system's reason for a failed file operation, when it gave one. */
export function projectFileErrorReason(
  code: string | undefined,
): ProjectFileErrorReason | undefined {
  switch (code) {
    case "ENOENT":
    case "ENOTDIR":
      return "not_found";
    case "EACCES":
    case "EPERM":
      return "permission_denied";
    default:
      return undefined;
  }
}
