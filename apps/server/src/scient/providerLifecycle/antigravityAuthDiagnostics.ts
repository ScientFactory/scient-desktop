import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as AcpErrors from "effect-acp/errors";

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const isProcessExit = Schema.is(AcpErrors.AcpProcessExitedError);
const failureTypes = new Set([
  "ProviderSetupError",
  "AcpSpawnError",
  "AcpProcessExitedError",
  "AcpInputStreamEndedError",
  "AcpProtocolParseError",
  "AcpTransportError",
  "AcpRequestError",
]);
const systemCodes = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "ENOEXEC",
  "ENOMEM",
  "ENOSPC",
  "EIO",
  "EBUSY",
  "ETIMEDOUT",
]);

/** Select metadata, never redact arbitrary provider text after retaining it. */
export function antigravityAuthFailureDiagnostic(error: unknown, beforeAuthorizationUrl: boolean) {
  let current = error;
  let systemErrorCode: string | undefined;
  // Native platform errors may wrap errno; bound traversal, including cyclic causes.
  for (let depth = 0; depth < 4 && isRecord(current); depth++) {
    if (typeof current.code === "string" && systemCodes.has(current.code)) {
      systemErrorCode = current.code;
      break;
    }
    current = current.cause;
  }
  return {
    phase: beforeAuthorizationUrl ? "before-authorization" : "after-authorization",
    failureType:
      isRecord(error) && typeof error._tag === "string" && failureTypes.has(error._tag)
        ? error._tag
        : "unknown",
    ...(isProcessExit(error) && typeof error.code === "number" && Number.isSafeInteger(error.code)
      ? { exitCode: error.code }
      : {}),
    ...(systemErrorCode === undefined ? {} : { systemErrorCode }),
  };
}

export const recordAntigravityAuthFailure = (
  cause: Cause.Cause<unknown>,
  beforeAuthorizationUrl: boolean,
) =>
  Effect.logWarning("Antigravity sign-in failed.").pipe(
    Effect.annotateLogs(
      antigravityAuthFailureDiagnostic(
        Option.getOrUndefined(Cause.findErrorOption(cause)),
        beforeAuthorizationUrl,
      ),
    ),
    Effect.ignoreCause({ log: false }),
  );
