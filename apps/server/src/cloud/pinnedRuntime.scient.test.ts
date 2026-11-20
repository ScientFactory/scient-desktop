import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";

import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ProcessRunner from "../processRunner.ts";
import { prunePinnedRuntimes } from "./pinnedRuntime.ts";

const missing = (path: string) =>
  PlatformError.systemError({
    _tag: "NotFound",
    module: "FileSystem",
    method: "readFile",
    pathOrDescriptor: path,
  });

/** What process 7 does after the first pass met it with only its executable readable. */
type Next =
  | "exits"
  | "stays unreadable"
  | "loses its executable, threads running on"
  | "reads, running 1.0.0";

/**
 * The real file system, with a Linux `/proc` of a readable process 1 and a process 7 whose
 * executable reads but whose arguments do not, on the first pass over `/proc`.
 */
const withProc = (real: FileSystem.FileSystem, next: Next, runtime: string) => {
  let pass = 0;
  const unreadable = () => pass === 1 || next !== "reads, running 1.0.0";
  return FileSystem.FileSystem.of({
    ...real,
    readDirectory: (path, options) => {
      if (path !== "/proc") return real.readDirectory(path, options);
      pass += 1;
      return Effect.succeed(pass > 1 && next === "exits" ? ["1", "self"] : ["1", "self", "7"]);
    },
    readLink: (path) => {
      if (path === "/proc/1/exe") return Effect.succeed("/usr/lib/systemd/systemd");
      if (path === "/proc/1/cwd") return Effect.succeed("/");
      if (path === "/proc/7/cwd") return Effect.succeed("/");
      if (path === "/proc/7/exe") {
        return pass > 1 && next === "loses its executable, threads running on"
          ? Effect.fail(missing(path))
          : Effect.succeed("/usr/bin/node");
      }
      return real.readLink(path);
    },
    readFileString: (path, encoding) => {
      if (path === "/proc/1/cmdline") return Effect.succeed("/usr/lib/systemd/systemd\0");
      if (path === "/proc/7/cmdline") {
        return unreadable() ? Effect.fail(missing(path)) : Effect.succeed(`node\0${runtime}\0`);
      }
      return real.readFileString(path, encoding);
    },
  });
};

it.layer(NodeServices.layer)("prunePinnedRuntimes on Linux", (it) => {
  const prune = (next: Next) =>
    Effect.gen(function* () {
      const real = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* real.makeTempDirectoryScoped({ prefix: "t3-pinned-proc-" });
      yield* TestClock.setTime(Duration.toMillis(Duration.days(1)));
      for (const version of ["1.0.0", "1.1.0"]) {
        const directory = path.join(baseDir, "runtime", "versions", version);
        yield* real.makeDirectory(directory, { recursive: true });
        yield* real.writeFileString(path.join(directory, "t3"), "");
        const sentinel = path.join(directory, ".install-complete");
        yield* real.writeFileString(sentinel, `${version}\n`);
        yield* real.utimes(sentinel, 0, 0);
      }
      const runtime = path.join(baseDir, "runtime", "versions", "1.0.0", "t3");
      const removed = yield* prunePinnedRuntimes({ baseDir, keep: ["2.0.0"] }).pipe(
        Effect.provideService(FileSystem.FileSystem, withProc(real, next, runtime)),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Environment, { T3CODE_INSTALL_BIN_DIR: baseDir }),
        Effect.provide(ProcessRunner.layer),
      );
      return removed.toSorted();
    });

  it.effect("still prunes when a process exits while the process list is read", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* prune("exits"), ["1.0.0", "1.1.0"]);
    }),
  );

  it.effect("keeps the runtime a process runs once a second pass reads it", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* prune("reads, running 1.0.0"), ["1.1.0"]);
    }),
  );

  it.effect("prunes nothing while a running process cannot be read", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* prune("stays unreadable"), []);
      // Its main thread gone, its executable no longer reads, but it is still listed.
      assert.deepEqual(yield* prune("loses its executable, threads running on"), []);
    }),
  );
});
