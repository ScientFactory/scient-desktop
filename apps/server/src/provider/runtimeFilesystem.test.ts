import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import { makeInstallerFilesystem } from "./runtimeFilesystem.ts";

const lock = PlatformError.systemError({
  _tag: "PermissionDenied",
  module: "FileSystem",
  method: "rename",
  cause: Object.assign(new Error("locked executable"), { code: "EPERM" }),
});

it.effect("retries the native error wrapped by Effect and publishes only once", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const fs = FileSystem.makeNoop({
      rename: () => Effect.suspend(() => (++attempts < 3 ? Effect.fail(lock) : Effect.void)),
    });
    const fiber = yield* makeInstallerFilesystem(fs, "win32")
      .rename("stage", "active")
      .pipe(Effect.forkChild);
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(fiber);
    expect(attempts).toBe(3);
  }),
);

it.effect(
  "preserves the original operation error as well as permanent scoped cleanup failure",
  () =>
    Effect.gen(function* () {
      let removals = 0;
      const fs = FileSystem.makeNoop({
        makeTempDirectory: () => Effect.succeed("private-stage"),
        remove: () =>
          Effect.suspend(() => {
            removals++;
            return Effect.fail(lock);
          }),
      });
      const installer = makeInstallerFilesystem(fs, "win32");
      const fiber = yield* Effect.gen(function* () {
        yield* installer.makeTempDirectoryScoped();
        return yield* Effect.fail("original validation failure");
      }).pipe(Effect.scoped, Effect.exit, Effect.forkChild);
      yield* TestClock.adjust("16 seconds");
      const exit = yield* Fiber.join(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.findErrorOption(exit.cause)).toEqual(
          Option.some("original validation failure"),
        );
        expect(Result.getOrThrow(Cause.findDefect(exit.cause))).toBe(lock);
      }
      expect(removals).toBeGreaterThan(1);
    }),
);

it.effect("does not retry non-Windows errors", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const fs = FileSystem.makeNoop({
      rename: () =>
        Effect.suspend(() => {
          attempts++;
          return Effect.fail(lock);
        }),
    });
    const result = yield* makeInstallerFilesystem(fs, "darwin")
      .rename("stage", "active")
      .pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure).toBe(lock);
    expect(attempts).toBe(1);
  }),
);

it.effect("will not overwrite a destination that appears during backoff", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const fs = FileSystem.makeNoop({
      rename: () =>
        Effect.suspend(() => {
          attempts++;
          return Effect.fail(lock);
        }),
      stat: () =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "stat",
          }),
        ),
    });
    const fiber = yield* makeInstallerFilesystem(fs, "win32")
      .rename("stage", "active")
      .pipe(Effect.result, Effect.forkChild);
    yield* TestClock.adjust("1 second");
    const result = yield* Fiber.join(fiber);
    expect(result._tag).toBe("Failure");
    expect(attempts).toBe(1);
  }),
);
