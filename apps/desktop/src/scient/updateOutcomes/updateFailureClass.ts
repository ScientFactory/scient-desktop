import * as Cause from "effect/Cause";

/** Why an update step failed, from the updater's own error codes, statuses and Node/Chromium errors. */
export type UpdateFailureClass =
  | "network"
  | "timeout"
  | "certificate"
  | "http_4xx"
  | "http_5xx"
  | "feed"
  | "checksum"
  | "signature"
  | "disk_full"
  | "permission"
  | "configuration"
  | "cancelled"
  | "internal"
  | "unknown";

const FEED_CODES = new Set([
  "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
  "ERR_UPDATER_LATEST_VERSION_NOT_FOUND",
  "ERR_UPDATER_NO_PUBLISHED_VERSIONS",
  "ERR_UPDATER_RELEASE_NOT_FOUND",
  "ERR_UPDATER_ASSET_NOT_FOUND",
  "ERR_UPDATER_ZIP_FILE_NOT_FOUND",
  "ERR_UPDATER_INVALID_UPDATE_INFO",
  "ERR_UPDATER_INVALID_RELEASE_FEED",
  "ERR_UPDATER_NO_FILES_PROVIDED",
  "ERR_UPDATER_NO_CHECKSUM",
  "ERR_UPDATER_INVALID_VERSION",
]);
const CONFIGURATION_CODES = new Set([
  "ERR_UPDATER_INVALID_PROVIDER_CONFIGURATION",
  "ERR_UPDATER_UNSUPPORTED_PROVIDER",
  "ERR_UPDATER_INVALID_CHANNEL",
  "ERR_UPDATER_WEB_INSTALLER_DISABLED",
]);

const SIGNATURE = /not signed by the application owner|code ?signature|codesign/iu;
const CHECKSUM = /checksum mismatch/iu;
const DISK_FULL = /\bENOSPC\b|no space left/iu;
const PERMISSION = /\b(?:EACCES|EPERM|EROFS)\b|permission denied|operation not permitted/iu;
const CERTIFICATE =
  /net::ERR_(?:CERT_|SSL_)|\b(?:CERT_[A-Z_]+|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT(?:_LOCALLY)?|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|ERR_TLS_CERT_ALTNAME_INVALID)\b/u;
const TIMEOUT =
  /\b(?:ETIMEDOUT|ESOCKETTIMEDOUT)\b|net::ERR_(?:CONNECTION_)?TIMED_OUT|\btimed? ?out\b/iu;
const NETWORK =
  /\b(?:ENOTFOUND|ECONNRESET|ECONNREFUSED|ECONNABORTED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ENETDOWN|EPIPE)\b|net::ERR_[A-Z0-9_]+/u;
const HTTP_STATUS = /\b(?:HttpError: |status )([1-5]\d\d)\b/u;

interface ErrorFacts {
  readonly codes: ReadonlyArray<string>;
  readonly statuses: ReadonlyArray<number>;
  readonly names: ReadonlyArray<string>;
  /** Local only: classified here and never stored or sent. */
  readonly text: string;
}

function collect(cause: unknown): ErrorFacts {
  const codes: string[] = [];
  const statuses: number[] = [];
  const names: string[] = [];
  const texts: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || value === null || value === undefined) return;
    if (Cause.isCause(value)) {
      for (const reason of value.reasons) {
        if (reason._tag === "Fail") visit(reason.error, depth + 1);
        else if (reason._tag === "Die") visit(reason.defect, depth + 1);
      }
      return;
    }
    if (typeof value === "string") {
      texts.push(value);
      return;
    }
    if (typeof value !== "object") return;
    const error = value as {
      readonly code?: unknown;
      readonly statusCode?: unknown;
      readonly name?: unknown;
      readonly message?: unknown;
      readonly cause?: unknown;
    };
    if (typeof error.code === "string") codes.push(error.code);
    if (typeof error.statusCode === "number") statuses.push(error.statusCode);
    if (typeof error.name === "string") names.push(error.name);
    // builder-util-runtime's CancellationError keeps the default name.
    if (typeof value.constructor?.name === "string") names.push(value.constructor.name);
    if (typeof error.message === "string") texts.push(error.message);
    visit(error.cause, depth + 1);
  };
  visit(cause, 0);
  return { codes, statuses, names, text: texts.join("\n") };
}

function httpStatus(facts: ErrorFacts): number | undefined {
  const status =
    facts.statuses.find((value) => value >= 100 && value <= 599) ??
    facts.codes.map((code) => /^HTTP_ERROR_(\d{3})$/u.exec(code)?.[1]).find(Boolean) ??
    HTTP_STATUS.exec(facts.text)?.[1];
  return status === undefined ? undefined : Number(status);
}

/** Classifies an electron-updater failure; feed errors wrap transport causes, so those win. */
export function classifyUpdateFailure(cause: unknown): UpdateFailureClass {
  try {
    const facts = collect(cause);
    const has = (code: string) => facts.codes.includes(code);
    if (has("ERR_UPDATER_INVALID_SIGNATURE") || SIGNATURE.test(facts.text)) return "signature";
    if (has("ERR_CHECKSUM_MISMATCH") || CHECKSUM.test(facts.text)) return "checksum";
    if (has("ENOSPC") || DISK_FULL.test(facts.text)) return "disk_full";
    if (["EACCES", "EPERM", "EROFS"].some(has) || PERMISSION.test(facts.text)) return "permission";
    if (CERTIFICATE.test(facts.text) || facts.codes.some((code) => CERTIFICATE.test(code))) {
      return "certificate";
    }
    if (TIMEOUT.test(facts.text) || facts.codes.some((code) => TIMEOUT.test(code))) {
      return "timeout";
    }
    if (NETWORK.test(facts.text) || facts.codes.some((code) => NETWORK.test(code))) {
      return "network";
    }
    const feed = facts.codes.some((code) => FEED_CODES.has(code));
    const status = httpStatus(facts);
    if (feed && (status === undefined || status === 404)) return "feed";
    if (status !== undefined && status >= 400) return status >= 500 ? "http_5xx" : "http_4xx";
    if (feed) return "feed";
    if (facts.codes.some((code) => CONFIGURATION_CODES.has(code))) return "configuration";
    if (facts.names.includes("CancellationError")) return "cancelled";
    return "unknown";
  } catch {
    return "unknown";
  }
}
