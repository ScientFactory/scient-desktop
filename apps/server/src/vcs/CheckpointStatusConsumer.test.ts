import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeCheckpointStatusConsumer } from "./CheckpointStatusConsumer.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

it.effect("handles every byte boundary, Unicode, renames, and POSIX backslashes", () =>
  Effect.gen(function* () {
    const paths: string[] = [];
    const consumer = makeCheckpointStatusConsumer({
      cwd: "/fixture",
      operation: "test",
      platform: "darwin",
      onPath: (path) =>
        Effect.sync(() => {
          paths.push(new TextDecoder().decode(path));
        }),
    });
    for (const byte of bytes(
      "?? שלום.txt\0R  new.txt\0old.txt\0?? data\\..\\result.txt\0?? C:\\result.txt\0",
    ))
      yield* consumer.consume(new Uint8Array([byte]));
    yield* consumer.finish;
    assert.deepEqual(paths, ["שלום.txt", "new.txt", "data\\..\\result.txt", "C:\\result.txt"]);
  }),
);

it.effect("consumes a valid listing larger than 16 MiB with bounded records", () =>
  Effect.gen(function* () {
    let count = 0;
    const consumer = makeCheckpointStatusConsumer({
      cwd: "/fixture",
      operation: "test",
      platform: "darwin",
      onPath: () =>
        Effect.sync(() => {
          count += 1;
        }),
    });
    const chunk = bytes(("?? " + "x".repeat(180) + "\0").repeat(256));
    for (let n = 0; n < 400; n++) yield* consumer.consume(chunk);
    yield* consumer.finish;
    assert.equal(count, 102_400);
    assert.isAbove(chunk.byteLength * 400, 16 * 1024 * 1024);
  }),
);

it.effect.each(
  (
    [
      ["byte budget", "?? abc\0", { maxBytes: 6, maxPaths: 2, maxRecordBytes: 20 }, "path-limit"],
      [
        "path budget",
        "?? a\0?? b\0",
        { maxBytes: 100, maxPaths: 1, maxRecordBytes: 20 },
        "path-limit",
      ],
      ["record budget", "?? abc", { maxBytes: 100, maxPaths: 2, maxRecordBytes: 5 }, "path-limit"],
      ["missing delimiter", "?? a", undefined, "filesystem-error"],
      ["missing rename source", "R  a\0", undefined, "filesystem-error"],
      ["POSIX traversal", "?? ../a\0", undefined, "filesystem-error"],
      ["Windows traversal", "?? a\\..\\b\0", undefined, "filesystem-error"],
      ["Windows drive path", "?? C:\\a\0", undefined, "filesystem-error"],
    ] as const
  ).map(([name, text, limits, reason]) => ({
    caseTitle: `refuses ${name} without treating an incomplete listing as complete`,
    name,
    text,
    limits,
    reason,
  })),
)("$caseTitle", ({ name, text, limits, reason }) =>
  Effect.gen(function* () {
    const consumer = makeCheckpointStatusConsumer({
      cwd: "/fixture",
      operation: "test",
      platform: name.startsWith("Windows") ? "win32" : "darwin",
      onPath: () => Effect.void,
      ...(limits === undefined ? {} : { limits }),
    });
    const result = yield* Effect.result(
      Effect.andThen(consumer.consume(bytes(text)), consumer.finish),
    );
    assert.deepInclude(result, { _tag: "Failure" });
    if (result._tag === "Failure") assert.equal(result.failure.reason, reason);
  }),
);

it.effect("passes a filename that is not valid UTF-8 through unchanged", () =>
  Effect.gen(function* () {
    const paths: Uint8Array[] = [];
    const consumer = makeCheckpointStatusConsumer({
      cwd: "/fixture",
      operation: "test",
      platform: "linux",
      onPath: (path) =>
        Effect.sync(() => {
          paths.push(Uint8Array.from(path));
        }),
    });
    // "?? caf\xe9.txt" in Latin-1, as an extracted archive can leave it on Linux.
    yield* consumer.consume(new Uint8Array([63, 63, 32, 99, 97, 102, 0xe9, 46, 116, 120, 116, 0]));
    yield* consumer.finish;
    assert.deepEqual(paths, [new Uint8Array([99, 97, 102, 0xe9, 46, 116, 120, 116])]);
  }),
);
