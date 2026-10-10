import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
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

  it.effect("retries a transient Windows destination lock without exposing a partial file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const target = `${directory}/document.md`;
      yield* fs.writeFileString(target, "original");
      const locked = PlatformError.systemError({
        _tag: "Unknown",
        module: "FileSystem",
        method: "rename",
        cause: Object.assign(new Error("destination is temporarily locked"), { code: "EPERM" }),
      });
      let attempts = 0;
      const firstRename = yield* Deferred.make<void>();
      const observed = FileSystem.make({
        ...fs,
        rename: (from, to) => {
          attempts += 1;
          return Deferred.succeed(firstRename, undefined).pipe(
            Effect.andThen(attempts < 3 ? Effect.fail(locked) : fs.rename(from, to)),
          );
        },
      });
      const writing = yield* writeFileStringAtomically({
        filePath: target,
        contents: "replacement",
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, observed),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.forkChild,
      );
      yield* Deferred.await(firstRename);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(writing);
      expect(attempts).toBe(3);
      expect(yield* fs.readFileString(target)).toBe("replacement");
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

  it.effect("bounds retries when a Windows destination lock does not clear", () =>
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
        cause: Object.assign(new Error("destination remains locked"), { code: "EACCES" }),
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
        Effect.exit,
        Effect.forkChild,
      );
      yield* Deferred.await(firstRename);
      yield* TestClock.adjust("6 seconds");
      const outcome = yield* Fiber.join(writing);
      expect(outcome._tag).toBe("Failure");
      expect(attempts).toBeGreaterThan(1);
      expect(yield* fs.readFileString(target)).toBe("original");
      expect(yield* fs.readDirectory(directory)).toEqual(["document.md"]);
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

it.layer(NodeServices.layer)("writeFileStringAtomically", (it) => {
  it.effect("keeps a symlinked file linked and rewrites its destination", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const destination = path.join(root, "dotfiles", "settings.json");
      const link = path.join(root, "home", "settings.json");
      yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
      yield* fs.makeDirectory(path.dirname(link), { recursive: true });
      yield* fs.writeFileString(destination, "before");
      yield* fs.symlink(destination, link);

      yield* writeFileStringAtomically({ filePath: link, contents: "after" });

      assert.strictEqual(yield* fs.readLink(link), destination);
      assert.strictEqual(yield* fs.readFileString(destination), "after");
    }),
  );

  it.effect("keeps a dangling symlink linked and creates its destination", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const destination = path.join(root, "dotfiles", "settings.json");
      const link = path.join(root, "home", "settings.json");
      yield* fs.makeDirectory(path.dirname(link), { recursive: true });
      yield* fs.symlink(destination, link);

      yield* writeFileStringAtomically({ filePath: link, contents: "fresh" });

      assert.strictEqual(yield* fs.readLink(link), destination);
      assert.strictEqual(yield* fs.readFileString(destination), "fresh");
    }),
  );

  it.effect("fails on a symlink cycle without replacing either link", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const first = path.join(root, "first.json");
      const second = path.join(root, "second.json");
      yield* fs.symlink(second, first);
      yield* fs.symlink(first, second);

      const result = yield* Effect.exit(
        writeFileStringAtomically({ filePath: first, contents: "after" }),
      );

      assert.isTrue(Exit.isFailure(result));
      assert.strictEqual(yield* fs.readLink(first), second);
      assert.strictEqual(yield* fs.readLink(second), first);
    }),
  );

  it.effect("resolves a relative link through a symlinked parent directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const destination = path.join(root, "dotfiles", "config", "settings.json");
      const linkedState = path.join(root, "dotfiles", "state");
      const home = path.join(root, "home");
      const link = path.join(home, "state", "settings.json");
      yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
      yield* fs.makeDirectory(linkedState, { recursive: true });
      yield* fs.makeDirectory(home, { recursive: true });
      yield* fs.symlink(linkedState, path.join(home, "state"));
      yield* fs.writeFileString(destination, "before");
      yield* fs.symlink("../config/settings.json", link);

      yield* writeFileStringAtomically({ filePath: link, contents: "after" });

      assert.strictEqual(yield* fs.readLink(link), "../config/settings.json");
      assert.strictEqual(yield* fs.readFileString(destination), "after");
    }),
  );

  it.effect("creates a missing file and its directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const filePath = path.join(root, "nested", "settings.json");

      yield* writeFileStringAtomically({ filePath, contents: "fresh" });

      assert.strictEqual(yield* fs.readFileString(filePath), "fresh");
    }),
  );
});

it.effect("surfaces an unreadable link instead of writing over it", () =>
  Effect.gen(function* () {
    const readLinkFailure = PlatformError.systemError({
      _tag: "Unknown",
      module: "FileSystem",
      method: "readLink",
      pathOrDescriptor: "/home/settings.json",
    });

    const result = yield* Effect.exit(
      writeFileStringAtomically({ filePath: "/home/settings.json", contents: "after" }),
    );

    assert.deepStrictEqual(result, Exit.fail(readLinkFailure));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Path.layer,
        FileSystem.layerNoop({
          readLink: () =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "FileSystem",
                method: "readLink",
                pathOrDescriptor: "/home/settings.json",
              }),
            ),
          rename: () => Effect.die("an unreadable link must not be replaced"),
        }),
      ),
    ),
  ),
);

it.effect("succeeds when the write lands but its temp directory cannot be removed", () =>
  Effect.gen(function* () {
    const renamed: Array<string> = [];
    const removed: Array<string> = [];
    const fileSystem = FileSystem.layerNoop({
      // The target does not exist yet, so it is written in place.
      readLink: (path) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "FileSystem",
            method: "readLink",
            pathOrDescriptor: path,
          }),
        ),
      makeDirectory: () => Effect.void,
      makeTempDirectory: () => Effect.succeed("/home/settings.json.abc123"),
      writeFileString: () => Effect.void,
      rename: (_from, to) => Effect.sync(() => void renamed.push(to)),
      remove: (path) =>
        Effect.sync(() => void removed.push(path)).pipe(
          Effect.andThen(
            Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "remove",
                pathOrDescriptor: path,
              }),
            ),
          ),
        ),
    });

    const result = yield* Effect.exit(
      writeFileStringAtomically({ filePath: "/home/settings.json", contents: "after" }).pipe(
        Effect.provide(Layer.mergeAll(Path.layer, fileSystem)),
      ),
    );

    assert.deepStrictEqual(result, Exit.succeed(undefined));
    assert.deepStrictEqual(renamed, ["/home/settings.json"]);
    assert.deepStrictEqual(removed, ["/home/settings.json.abc123"]);
  }),
);
