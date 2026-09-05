import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import { writeFileStringAtomically } from "./atomicWrite.ts";

describe("durable atomic text replacement", () => {
  it.effect("flushes contents before rename, retains mode and cleans temporary files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
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
        process.platform === "win32"
          ? ["file sync", "rename"]
          : ["file sync", "rename", "directory sync"],
      );
      if (process.platform !== "win32") expect((yield* fs.stat(target)).mode & 0o777).toBe(0o600);
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
});
