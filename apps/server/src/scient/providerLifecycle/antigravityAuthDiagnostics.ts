import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as AcpErrors from "effect-acp/errors";

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const isProcessExit = Schema.is(AcpErrors.AcpProcessExitedError);
const isAcpRequestError = Schema.is(AcpErrors.AcpRequestError);

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

const standardJsonRpcMessages = new Set([
  "Parse error",
  "Invalid Request",
  "Method not found",
  "Invalid params",
  "Internal error",
]);
const profileFolderNames = new Set([
  "skills",
  "plugins",
  "config",
  "conversations",
  "antigravity-cli",
  "antigravity-acp",
]);
// Node and Go spell the same failures differently, and Windows uses its own sentences.
const osErrorPatterns: ReadonlyArray<readonly [code: string, pattern: RegExp]> = [
  ["EEXIST", /\bEEXIST\b|\bfile exists\b|Cannot create a file when that file already exists\./iu],
  [
    "ENOENT",
    /\bENOENT\b|\bno such file or directory\b|The system cannot find the (?:path|file) specified\./iu,
  ],
  ["EACCES", /\bEACCES\b|\bpermission denied\b|Access is denied\./iu],
  ["EPERM", /\bEPERM\b|\boperation not permitted\b/iu],
  ["ENOTDIR", /\bENOTDIR\b|\bnot a directory\b/iu],
];
const workspaceFolderFailure =
  /failed to create workspace folder\s+"?([^"\s]+)"?\s*:\s*mkdir\b(.*)$/isu;

/** The folder's last segment, only when it is one of the agent profile's own folders. */
function profileFolder(location: string): string | undefined {
  let path = location;
  try {
    path = decodeURIComponent(location);
  } catch {
    // A malformed escape is still split like any other path.
  }
  const segment = path.split(/[\\/]+/u).findLast((part) => part.length > 0);
  return segment !== undefined && profileFolderNames.has(segment) ? segment : undefined;
}

/**
 * The agent's `data.details` reduced to a known failure shape. No text of the
 * agent's own is kept: an unrecognized message is recorded only as its kind and
 * length, because a filter of credentials and paths inside free text cannot be
 * complete.
 */
function classifyAcpRequestDetails(details: string) {
  const workspace = workspaceFolderFailure.exec(details);
  if (workspace) {
    const folder = profileFolder(workspace[1]!);
    const errorCode = osErrorPatterns.find(([, pattern]) => pattern.test(workspace[2]!))?.[0];
    return {
      detailsKind: "workspace_folder_create_failed",
      ...(folder === undefined ? {} : { detailsFolder: folder }),
      ...(errorCode === undefined ? {} : { detailsErrorCode: errorCode }),
    } as const;
  }
  return { detailsKind: "unrecognized", detailsLength: details.length } as const;
}

/**
 * Allowlisted facts of a failed ACP request, for the trace: the method this
 * client sent, the JSON-RPC code, the message only when it is a standard
 * JSON-RPC message, and the kind of failure `data.details` describes.
 */
export function antigravityAcpRequestDiagnostic(error: unknown): {
  readonly acpMethod?: string;
  readonly acpCode?: number;
  readonly acpMessage?: string;
  readonly detailsKind?: "workspace_folder_create_failed" | "unrecognized";
  readonly detailsFolder?: string;
  readonly detailsErrorCode?: string;
  readonly detailsLength?: number;
} {
  if (!isAcpRequestError(error)) return {};
  const details =
    isRecord(error.data) && typeof error.data.details === "string" ? error.data.details : undefined;
  return {
    ...(error.method === undefined ? {} : { acpMethod: error.method }),
    acpCode: error.code,
    ...(standardJsonRpcMessages.has(error.errorMessage) ? { acpMessage: error.errorMessage } : {}),
    ...(details === undefined ? {} : classifyAcpRequestDetails(details)),
  };
}

export const recordAntigravityAuthFailure = Effect.fn(
  "antigravityAuthDiagnostics.recordAntigravityAuthFailure",
)(
  function* (cause: Cause.Cause<unknown>, beforeAuthorizationUrl: boolean) {
    const error = Option.getOrUndefined(Cause.findErrorOption(cause));
    yield* Effect.logWarning("Antigravity sign-in failed.").pipe(
      Effect.annotateLogs({
        ...antigravityAuthFailureDiagnostic(error, beforeAuthorizationUrl),
        ...antigravityAcpRequestDiagnostic(error),
      }),
    );
  },
  (effect) => effect.pipe(Effect.ignoreCause({ log: false })),
);
