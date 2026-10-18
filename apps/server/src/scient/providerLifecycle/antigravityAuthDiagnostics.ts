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

const controlCharacters = /\p{Cc}+/gu;
const anyUrl = /\b([a-z][a-z0-9+.-]*):\/\/[^\s"'<>]*/giu;
const bearerOrBasic = /\b(Bearer|Basic)\s+[^\s"',;]+/giu;
const jsonWebToken = /\beyJ[\w-]+\.[\w-]+(?:\.[\w-]+)?/gu;
const secretKeyedValue =
  /(["']?)([\w.-]*(?:token|secret|password|passwd|key|code|auth|session|cookie|credential)[\w.-]*)\1(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}"']+)/giu;
// A space belongs to a path only inside a directory name: more path follows it.
const windowsPath =
  /(?:\b[A-Za-z]:|\\\\[^\s\\/"'<>]+)[\\/](?:[^\s"'<>:*?|]| (?=[^\s"'<>:*?|\\/]+[\\/]))*/gu;
const posixPath = /(?<![\w.:<>-])\/(?:(?:[^\s/"'<>:]| (?=[^\s/"'<>:]+\/))+\/)+[^\s/"'<>:]*/gu;
const longOpaqueRun = /[A-Za-z0-9+/=_-]{20,}/gu;

/** `<path>/<last segment>`: the segment says what failed; the rest names the user's files. */
function reducePath(path: string): string {
  const segments = path.split(/[\\/]+/u).filter((segment) => segment.length > 0);
  const last = segments.at(-1);
  return last === undefined || /^[A-Za-z]:$/u.test(last) ? "<path>" : `<path>/${last}`;
}

function reduceUrl(match: string, scheme: string): string {
  if (scheme.toLowerCase() === "file") {
    let path = match.slice("file://".length).replace(/[?#].*$/u, "");
    try {
      path = decodeURIComponent(path);
    } catch {
      // A malformed escape still reduces like any other path.
    }
    return `file://${reducePath(path)}`;
  }
  try {
    // Scheme and host only: userinfo, path, query and fragment can all carry credentials.
    const url = new URL(match);
    return url.hostname ? `${url.protocol}//${url.hostname}` : `${url.protocol}//<host>`;
  } catch {
    return `${scheme}://<host>`;
  }
}

/**
 * Native text for the trace only, never for the UI, kept deny-by-default: URLs
 * shrink to scheme and host, absolute paths to their last segment, and anything
 * that can hold a credential is replaced, before the 500-character bound. What
 * remains still reads as the agent's sentence, so the failure stays diagnosable.
 */
export function localAntigravityNativeText(value: string): string {
  const text = value
    .replace(controlCharacters, " ")
    .replace(anyUrl, reduceUrl)
    .replace(bearerOrBasic, "$1 <redacted>")
    .replace(jsonWebToken, "<redacted>")
    .replace(secretKeyedValue, "$1$2$1$3<redacted>")
    .replace(windowsPath, reducePath)
    .replace(posixPath, reducePath)
    .replace(longOpaqueRun, "<redacted>");
  return text.length > maxNativeTextLength ? `${text.slice(0, maxNativeTextLength - 1)}…` : text;
}

/** The failed request's method, JSON-RPC code, message and `data.details`, for the trace. */
export function antigravityAcpRequestDiagnostic(error: unknown): {
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
    acpMessage: localAntigravityNativeText(error.errorMessage),
    ...(details === undefined ? {} : { acpDetails: localAntigravityNativeText(details) }),
  };
}

export const recordAntigravityAuthFailure = (
  cause: Cause.Cause<unknown>,
  beforeAuthorizationUrl: boolean,
) =>
  Effect.gen(function* () {
    const error = Option.getOrUndefined(Cause.findErrorOption(cause));
    yield* Effect.logWarning("Antigravity sign-in failed.").pipe(
      Effect.annotateLogs({
        ...antigravityAuthFailureDiagnostic(error, beforeAuthorizationUrl),
        ...antigravityAcpRequestDiagnostic(error),
      }),
    );
  }).pipe(Effect.ignoreCause({ log: false }));
