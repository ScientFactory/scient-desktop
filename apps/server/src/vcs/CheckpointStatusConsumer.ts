/** Incremental porcelain-v1 -z parsing with a bounded record and work budget.
 * The consumer is awaited by ProcessRunner, so it cannot accumulate stat jobs.
 * Paths stay raw bytes: `-z` output is unquoted, and a filename that is not
 * valid UTF-8 (allowed on Linux) must still reach lstat unchanged.
 */
import { VcsCheckpointUnavailableError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

const CHECKPOINT_ENUMERATION_LIMITS = {
  maxBytes: 128 * 1024 * 1024,
  maxPaths: 250_000,
  maxRecordBytes: 1024 * 1024,
} as const;

const SLASH = 0x2f;
const BACKSLASH = 0x5c;
const DOT = 0x2e;
const COLON = 0x3a;
const SPACE = 0x20;

const isAsciiLetter = (byte: number | undefined) =>
  byte !== undefined && ((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a));

const isRenameOrCopy = (byte: number | undefined) => byte === 0x52 || byte === 0x43; // R, C

// Git's paths are repository relative. Do not turn malformed output into a
// stat outside the root, including on Windows.
const isUnsafePath = (name: Uint8Array, windows: boolean) => {
  if (name[0] === SLASH) return true;
  if (windows && (name[0] === BACKSLASH || (isAsciiLetter(name[0]) && name[1] === COLON)))
    return true;
  let segmentStart = 0;
  for (let index = 0; index <= name.byteLength; index++) {
    const byte = name[index];
    if (index < name.byteLength && byte !== SLASH && !(windows && byte === BACKSLASH)) continue;
    if (index - segmentStart === 2 && name[segmentStart] === DOT && name[segmentStart + 1] === DOT)
      return true;
    segmentStart = index + 1;
  }
  return false;
};

export const makeCheckpointStatusConsumer = <E>(input: {
  readonly cwd: string;
  readonly operation: string;
  readonly platform: NodeJS.Platform;
  readonly onPath: (path: Uint8Array) => Effect.Effect<void, E>;
  readonly limits?: {
    readonly maxBytes: number;
    readonly maxPaths: number;
    readonly maxRecordBytes: number;
  };
}) => {
  const limits = input.limits ?? CHECKPOINT_ENUMERATION_LIMITS;
  let record = new Uint8Array(0);
  let bytes = 0;
  let paths = 0;
  let skipRenameSource = false;
  const unavailable = (reason: "path-limit" | "filesystem-error", detail: string) =>
    new VcsCheckpointUnavailableError({
      operation: input.operation,
      cwd: input.cwd,
      reason,
      detail,
    });
  const consume = Effect.fnUntraced(function* (chunk: Uint8Array) {
    bytes += chunk.byteLength;
    if (bytes > limits.maxBytes)
      return yield* unavailable(
        "path-limit",
        "The changed-path listing exceeds the checkpoint enumeration budget.",
      );
    let start = 0;
    while (start < chunk.byteLength) {
      const nul = chunk.indexOf(0, start);
      const end = nul === -1 ? chunk.byteLength : nul;
      const size = record.byteLength + end - start;
      if (size > limits.maxRecordBytes)
        return yield* unavailable(
          "path-limit",
          "A changed path exceeds the checkpoint record budget.",
        );
      const joined = new Uint8Array(size);
      joined.set(record);
      joined.set(chunk.subarray(start, end), record.byteLength);
      record = joined;
      if (nul === -1) break;
      paths += 1;
      if (paths > limits.maxPaths)
        return yield* unavailable(
          "path-limit",
          "Too many changed paths to safely capture a checkpoint.",
        );
      if (skipRenameSource) skipRenameSource = false;
      else {
        if (record.byteLength < 4 || record[2] !== SPACE)
          return yield* unavailable(
            "filesystem-error",
            "Git returned an incomplete changed-path record.",
          );
        const name = record.subarray(3);
        if (isUnsafePath(name, input.platform === "win32"))
          return yield* unavailable("filesystem-error", "Git returned an unsafe changed path.");
        skipRenameSource = isRenameOrCopy(record[0]) || isRenameOrCopy(record[1]);
        yield* input.onPath(name);
      }
      record = new Uint8Array(0);
      start = end + 1;
    }
  });
  const finish = Effect.suspend(() =>
    record.byteLength === 0 && !skipRenameSource
      ? Effect.void
      : Effect.fail(
          unavailable("filesystem-error", "Git returned an incomplete changed-path listing."),
        ),
  );
  return { consume, finish };
};
