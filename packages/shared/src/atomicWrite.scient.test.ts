import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Fiber from "effect/Fiber";
import * as HostProcess from "./HostProcess.ts";
import { describe, expect, it } from "@effect/vitest";
import { writeFileStringAtomically } from "./atomicWrite.ts";

describe("durable atomic text replacement", () => {
  it.effect("flushes contents before rename, retains mode and cleans temporary files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const platform = yield* HostProcess.Platform;
      const directory = yield* fs.makeTempDirectoryScoped();
      const target = `${directory}/document.md`;
      const operations: string[] = [];
      const observed = FileSystem.make({
        ...fs,
        open: (path, options) =>
          fs.open(path, options).pipe(
            Effect.map((file) => ({
              ...file,
              sync: Effect.sync(() => {
                operations.push(path === directory ? "directory sync" : "file sync");
              }).pipe(Effect.andThen(file.sync)),
            })),
          ),
        rename: (from, to) =>
          Effect.sync(() => {
            operations.push("rename");
          }).pipe(Effect.andThen(fs.rename(from, to))),
      });
      yield* writeFileStringAtomically({
        filePath: target,
        durable: true,
        contents: "שלום 😀\n",
        mode: 0o600,
      }).pipe(Effect.provideService(FileSystem.FileSystem, observed));
      expect(yield* fs.readFileString(target)).toBe("שלום 😀\n");
      expect(operations).toEqual(
        platform === "win32" ? ["file sync", "rename"] : ["file sync", "rename", "directory sync"],
      );
      if (platform !== "win32") expect((yield* fs.stat(target)).mode & 0o777).toBe(0o600);
      expect(yield* fs.readDirectory(directory)).toEqual(["document.md"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not replace the existing file when the temporary file cannot flush", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const target = `${directory}/document.md`;
      yield* fs.writeFileString(target, "original");
      const error = PlatformError.systemError({
        _tag: "Unknown",
        module: "FileSystem",
        method: "sync",
        cause: new Error("synthetic I/O failure"),
      });
      const failing = FileSystem.make({
        ...fs,
        open: (path, options) =>
          fs
            .open(path, options)
            .pipe(Effect.map((file) => ({ ...file, sync: Effect.fail(error) }))),
      });
      const outcome = yield* writeFileStringAtomically({
        filePath: target,
        durable: true,
        contents: "replacement",
      }).pipe(Effect.provideService(FileSystem.FileSystem, failing), Effect.exit);
      expect(outcome._tag).toBe("Failure");
      expect(yield* fs.readFileString(target)).toBe("original");
      expect(yield* fs.readDirectory(directory)).toEqual(["document.md"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not retry a permanent rename error or a transient error off Windows", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const denied = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "rename",
        cause: Object.assign(new Error("denied"), { code: "EPERM" }),
      });
      for (const [platform, error] of [
        ["linux", denied],
        [
          "win32",
          PlatformError.systemError({
            _tag: "Unknown",
            module: "FileSystem",
            method: "rename",
            cause: Object.assign(new Error("different volume"), { code: "EXDEV" }),
          }),
        ],
      ] as const) {
        let attempts = 0;
        const failing = FileSystem.make({
          ...fs,
          rename: () => {
            attempts += 1;
            return Effect.fail(error);
          },
        });
        const outcome = yield* writeFileStringAtomically({
          filePath: `${directory}/${platform}.md`,
          contents: "replacement",
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, failing),
          Effect.provideService(HostProcess.Platform, platform),
          Effect.exit,
        );
        expect(outcome._tag).toBe("Failure");
        expect(attempts).toBe(1);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("remains cancellable while a transient Windows lock is backing off", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const target = `${directory}/document.md`;
      yield* fs.writeFileString(target, "original");
      const firstRename = yield* Deferred.make<void>();
      let attempts = 0;
      const locked = PlatformError.systemError({
        _tag: "Unknown",
        module: "FileSystem",
        method: "rename",
        cause: Object.assign(new Error("destination is temporarily locked"), { code: "EBUSY" }),
      });
      const failing = FileSystem.make({
        ...fs,
        rename: () => {
          attempts += 1;
          return Deferred.succeed(firstRename, undefined).pipe(Effect.andThen(Effect.fail(locked)));
        },
      });
      const writing = yield* writeFileStringAtomically({
        filePath: target,
        contents: "replacement",
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, failing),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.forkChild,
      );
      yield* Deferred.await(firstRename);
      yield* Fiber.interrupt(writing);
      expect(attempts).toBe(1);
      expect(yield* fs.readFileString(target)).toBe("original");
      expect(yield* fs.readDirectory(directory)).toEqual(["document.md"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
