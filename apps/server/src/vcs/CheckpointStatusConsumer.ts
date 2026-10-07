/** Incremental porcelain-v1 -z parsing with a bounded record and work budget.
 * The consumer is awaited by ProcessRunner, so it cannot accumulate stat jobs.
 */
import { VcsCheckpointUnavailableError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

const CHECKPOINT_ENUMERATION_LIMITS = {
  maxBytes: 128 * 1024 * 1024,
  maxPaths: 250_000,
  maxRecordBytes: 1024 * 1024,
} as const;

export const makeCheckpointStatusConsumer = <E>(input: {
  readonly cwd: string;
  readonly operation: string;
  readonly platform: NodeJS.Platform;
  readonly onPath: (path: string) => Effect.Effect<void, E>;
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
        const text = yield* Effect.try({
          try: () => new TextDecoder("utf-8", { fatal: true }).decode(record),
          catch: () =>
            unavailable("filesystem-error", "A changed filename cannot be decoded safely."),
        });
        if (text.length < 4 || text[2] !== " ")
          return yield* unavailable(
            "filesystem-error",
            "Git returned an incomplete changed-path record.",
          );
        const name = text.slice(3);
        // Git's paths are repository relative. Do not turn malformed output into
        // a stat outside the root, including on Windows.
        if (
          name.startsWith("/") ||
          (input.platform === "win32" && (name.startsWith("\\") || /^[A-Za-z]:/.test(name))) ||
          name.split(input.platform === "win32" ? /[\\/]/ : /\//).includes("..")
        )
          return yield* unavailable("filesystem-error", "Git returned an unsafe changed path.");
        skipRenameSource = /[RC]/.test(text.slice(0, 2));
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
