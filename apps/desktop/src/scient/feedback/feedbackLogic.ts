// @effect-diagnostics globalDate:off -- plain helpers over wall-clock log stamps.
import { SCIENT_FEEDBACK_ORIGIN } from "@t3tools/contracts";

/**
 * Where reports go. Release builds use the Scient service; development builds only a loopback
 * test endpoint, the same rule analytics follows. Null keeps reports on this computer.
 */
export function feedbackEndpoint(input: {
  readonly isPackaged: boolean;
  readonly isDevelopment: boolean;
  readonly testEndpoint: string | undefined;
}): string | null {
  const test = input.testEndpoint?.trim();
  if (test) {
    try {
      const url = new URL(test);
      const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
      if (url.protocol === "http:" && loopback && !url.username && !url.password) {
        return url.origin;
      }
    } catch {
      // An unusable test endpoint falls back to the build's own rule.
    }
  }
  return input.isPackaged && !input.isDevelopment ? SCIENT_FEEDBACK_ORIGIN : null;
}

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [hidden]"],
  [
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi,
    "$1$2[hidden]",
  ],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[hidden]"],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, "[hidden]"],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[hidden]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[hidden]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[hidden]"],
  [/(:\/\/[^\s:/@]+:)[^\s@/]+@/g, "$1[hidden]@"],
];

/** Masks the home folder and secret-shaped text. Best effort: the person still sees the result. */
export function redactLogText(text: string, homeDirectory: string): string {
  let result = text;
  for (const home of new Set([homeDirectory, homeDirectory.replaceAll("\\", "/")])) {
    if (home.length > 1) result = result.split(home).join("~");
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/** The last `maxBytes` of a log, starting at a whole line. */
export function tailLines(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  const tail = new TextDecoder().decode(bytes.slice(bytes.length - maxBytes));
  const newline = tail.indexOf("\n");
  return newline === -1 ? tail : tail.slice(newline + 1);
}

/** Main-window crashes in the renderer history (NDJSON) within the window ending at `now`. */
export function rendererCrashesSince(ndjson: string, since: number): ReadonlyArray<string> {
  const crashes: Array<string> = [];
  for (const line of ndjson.split("\n")) {
    if (!line.includes('"render-process-gone"')) continue;
    try {
      const record = JSON.parse(line) as {
        readonly event?: string;
        readonly surface?: string;
        readonly timestampUnixMs?: number;
        readonly reason?: string;
        readonly exitCode?: number;
      };
      if (
        record.event === "render-process-gone" &&
        record.surface === "main" &&
        typeof record.timestampUnixMs === "number" &&
        record.timestampUnixMs >= since
      ) {
        crashes.push(
          `${new Date(record.timestampUnixMs).toISOString()} window stopped: ${record.reason ?? "unknown"} (exit ${record.exitCode ?? "?"})`,
        );
      }
    } catch {
      // A torn last line while the history is being written.
    }
  }
  return crashes;
}

export interface TraceFailure {
  readonly name: string;
  readonly endedAtMs: number;
  readonly traceId: string;
  readonly cause: string;
}

const nanosToMs = (value: unknown) => {
  try {
    return typeof value === "string" || typeof value === "number"
      ? Number(BigInt(value) / 1_000_000n)
      : null;
  } catch {
    return null;
  }
};

/**
 * Failed, not interrupted, operations in the server trace (NDJSON) that ended at or after
 * `since`, newest first. Reads the same fields as the Diagnostics page.
 */
export function traceFailuresSince(ndjson: string, since: number): ReadonlyArray<TraceFailure> {
  const failures: Array<TraceFailure> = [];
  for (const line of ndjson.split("\n")) {
    if (!line.includes("Failure") && !line.includes('"code":"2"')) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const exit = (record.exit ?? {}) as { readonly _tag?: unknown; readonly cause?: unknown };
    const status = (record.status ?? {}) as { readonly code?: unknown; readonly message?: unknown };
    const attributes = (record.attributes ?? {}) as Record<string, unknown>;
    const failed = exit._tag === "Failure" || status.code === "2";
    const interrupted =
      exit._tag === "Interrupted" ||
      attributes["effect.fiber.interrupted"] === true ||
      status.message === "Interrupted";
    const endedAtMs = nanosToMs(record.endTimeUnixNano);
    if (
      !failed ||
      interrupted ||
      endedAtMs === null ||
      endedAtMs < since ||
      typeof record.name !== "string" ||
      typeof record.traceId !== "string"
    ) {
      continue;
    }
    const cause =
      typeof exit.cause === "string"
        ? exit.cause
        : typeof status.message === "string"
          ? status.message
          : "Failure";
    failures.push({ name: record.name, endedAtMs, traceId: record.traceId, cause: cause.trim() });
  }
  // One entry per trace: a failure surfaces in every span it passes through, and the latest to
  // end is the outermost.
  const seen = new Set<string>();
  return failures
    .toSorted((left, right) => right.endedAtMs - left.endedAtMs)
    .filter((failure) => !seen.has(failure.traceId) && seen.add(failure.traceId));
}

const parseVersion = (version: string) => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};

/** Whether `current` is `fixedIn` or later; prerelease tags are ignored. */
export function runsFixedVersion(current: string, fixedIn: string): boolean {
  const have = parseVersion(current);
  const need = parseVersion(fixedIn);
  if (have === null || need === null) return false;
  for (let index = 0; index < 3; index += 1) {
    if (have[index]! !== need[index]!) return have[index]! > need[index]!;
  }
  return true;
}

/** Retry delay after `attempts` failed uploads: 30 s doubling to 30 min. */
export function retryDelayMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 30 * 60_000);
}

export function excerpt(message: string, fallback: string): string {
  const line = (message.trim() || fallback).split("\n")[0]!.trim();
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}
