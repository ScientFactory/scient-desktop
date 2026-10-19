import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { writeFileStringAtomically } from "./atomicWrite.ts";
import * as HostProcess from "./HostProcess.ts";

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

  it.effect("waits out a Windows scanner holding the target, then replaces it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const filePath = path.join(root, "settings.json");
      yield* fs.writeFileString(filePath, "before");
      const firstAttempt = yield* Deferred.make<void>();
      let attempts = 0;
      const lockedTwice = FileSystem.make({
        ...fs,
        rename: (from, to) =>
          Effect.suspend(() => {
            attempts += 1;
            return attempts <= 2
              ? Deferred.succeed(firstAttempt, undefined).pipe(
                  Effect.andThen(Effect.fail(renameError("EBUSY", to))),
                )
              : fs.rename(from, to);
          }),
      });

      const writing = yield* writeFileStringAtomically({ filePath, contents: "after" }).pipe(
        Effect.provideService(FileSystem.FileSystem, lockedTwice),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.forkChild,
      );
      yield* Deferred.await(firstAttempt);
      yield* advanceUntilDone(writing);

      assert.strictEqual(attempts, 3);
      assert.strictEqual(yield* fs.readFileString(filePath), "after");
      assert.deepStrictEqual(yield* fs.readDirectory(root), ["settings.json"]);
    }),
  );

  it.effect("gives up on a Windows lock that does not clear and keeps the old contents", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const filePath = path.join(root, "settings.json");
      yield* fs.writeFileString(filePath, "before");
      const firstAttempt = yield* Deferred.make<void>();
      let attempts = 0;
      const locked = FileSystem.make({
        ...fs,
        rename: (_from, to) =>
          Effect.suspend(() => {
            attempts += 1;
            return Deferred.succeed(firstAttempt, undefined).pipe(
              Effect.andThen(Effect.fail(renameError("EPERM", to))),
            );
          }),
      });

      const writing = yield* writeFileStringAtomically({ filePath, contents: "after" }).pipe(
        Effect.provideService(FileSystem.FileSystem, locked),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.exit,
        Effect.forkChild,
      );
      yield* Deferred.await(firstAttempt);

      assert.isTrue(Exit.isFailure(yield* advanceUntilDone(writing)));
      assert.isAbove(attempts, 1);
      assert.strictEqual(yield* fs.readFileString(filePath), "before");
      assert.deepStrictEqual(yield* fs.readDirectory(root), ["settings.json"]);
    }),
  );

  it.effect("does not replace a newer save that landed while the lock was held", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const filePath = path.join(root, "settings.json");
      yield* fs.writeFileString(filePath, "before");
      const firstAttempt = yield* Deferred.make<void>();
      let attempts = 0;
      const lockedOnce = FileSystem.make({
        ...fs,
        rename: (from, to) =>
          Effect.suspend(() => {
            attempts += 1;
            return attempts === 1
              ? Deferred.succeed(firstAttempt, undefined).pipe(
                  Effect.andThen(Effect.fail(renameError("EBUSY", to))),
                )
              : fs.rename(from, to);
          }),
      });

      const stale = yield* writeFileStringAtomically({ filePath, contents: "stale" }).pipe(
        Effect.provideService(FileSystem.FileSystem, lockedOnce),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.exit,
        Effect.forkChild,
      );
      yield* Deferred.await(firstAttempt);
      // Another process saves once the lock clears, before the waiting write retries.
      yield* writeFileStringAtomically({ filePath, contents: "newer" });

      assert.isTrue(Exit.isFailure(yield* advanceUntilDone(stale)));
      assert.strictEqual(yield* fs.readFileString(filePath), "newer");
      assert.deepStrictEqual(yield* fs.readDirectory(root), ["settings.json"]);
    }),
  );

  it.effect("fails at once on a read-only Windows target", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const filePath = path.join(root, "settings.json");
      yield* fs.writeFileString(filePath, "before");
      yield* Effect.acquireRelease(fs.chmod(filePath, 0o444), () =>
        fs.chmod(filePath, 0o644).pipe(Effect.ignore),
      );
      let attempts = 0;
      const denied = FileSystem.make({
        ...fs,
        rename: (_from, to) =>
          Effect.suspend(() => {
            attempts += 1;
            return Effect.fail(renameError("EPERM", to));
          }),
      });

      const writing = yield* writeFileStringAtomically({ filePath, contents: "after" }).pipe(
        Effect.provideService(FileSystem.FileSystem, denied),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.exit,
        Effect.forkChild,
      );
      assert.isTrue(Exit.isFailure(yield* advanceUntilDone(writing)));
      assert.strictEqual(attempts, 1);
      assert.strictEqual(yield* fs.readFileString(filePath), "before");
    }),
  );
});

// Retries stat the real target between waits, and that I/O finishes outside the
// test clock, so the clock moves one wait at a time until the write settles.
const advanceUntilDone = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    while (fiber.pollUnsafe() === undefined) {
      yield* TestClock.adjust("100 millis");
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
    }
    return yield* Fiber.join(fiber);
  });

const renameError = (code: string, path: string) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method: "rename",
    pathOrDescriptor: path,
    cause: Object.assign(new Error(`${code}, rename`), { code }),
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
