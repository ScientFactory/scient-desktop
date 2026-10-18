import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as AcpErrors from "effect-acp/errors";

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const isProcessExit = Schema.is(AcpErrors.AcpProcessExitedError);
const isAcpRequestError = Schema.is(AcpErrors.AcpRequestError);
const maxNativeTextLength = 500;

/**
 * Google accepted the sign-in, but the agent could not start a session with it. Lifecycle
 * presentation tells this apart from a sign-in that did not finish.
 */
export const ANTIGRAVITY_SESSION_SETUP_FAILED_MESSAGE =
  "Antigravity authenticated, but could not initialize a session or load models.";
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

const userHomeTrail = /[\\/]+$/;
const controlCharacters = /[\p{Cc}]+/gu;
// A URL's query and fragment can carry OAuth codes and state.
const urlQueryOrFragment = /\b([a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/giu;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Native text for the local server trace only, never for the UI: bounded, without URL queries or
 * fragments, and with the user's home shown as `~`.
 */
export function localAntigravityNativeText(value: string, userHome: string): string {
  let text = value.replace(controlCharacters, " ").replace(urlQueryOrFragment, "$1");
  const home = userHome.replace(userHomeTrail, "");
  if (home.length > 1) {
    const slashed = home.replaceAll("\\", "/");
    // File URLs carry the home percent-encoded.
    for (const form of new Set([home, slashed, home.replaceAll("/", "\\"), encodeURI(slashed)])) {
      text = text.replace(new RegExp(escapeRegExp(form), "giu"), "~");
    }
  }
  return text.length > maxNativeTextLength ? `${text.slice(0, maxNativeTextLength - 1)}…` : text;
}

/** The failed request's method, JSON-RPC code, message and `data.details`, for the local trace. */
export function antigravityAcpRequestDiagnostic(
  error: unknown,
  userHome: string,
): {
  readonly acpMethod?: string;
  readonly acpCode?: number;
  readonly acpMessage?: string;
  readonly acpDetails?: string;
} {
  if (!isAcpRequestError(error)) return {};
  const details =
    isRecord(error.data) && typeof error.data.details === "string" ? error.data.details : undefined;
  return {
    ...(error.method === undefined ? {} : { acpMethod: error.method }),
    acpCode: error.code,
    acpMessage: localAntigravityNativeText(error.errorMessage, userHome),
    ...(details === undefined ? {} : { acpDetails: localAntigravityNativeText(details, userHome) }),
  };
}

export const recordAntigravityAuthFailure = (
  cause: Cause.Cause<unknown>,
  beforeAuthorizationUrl: boolean,
) =>
  Effect.gen(function* () {
    const error = Option.getOrUndefined(Cause.findErrorOption(cause));
    const userHome = yield* HostProcess.HomeDirectory;
    yield* Effect.logWarning("Antigravity sign-in failed.").pipe(
      Effect.annotateLogs({
        ...antigravityAuthFailureDiagnostic(error, beforeAuthorizationUrl),
        ...antigravityAcpRequestDiagnostic(error, userHome),
      }),
    );
  }).pipe(Effect.ignoreCause({ log: false }));
