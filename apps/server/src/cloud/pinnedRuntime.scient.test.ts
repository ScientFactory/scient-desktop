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
    method: "readLink",
    pathOrDescriptor: path,
  });

// Above any pid_max (Linux's is at most 2^22), so no process has it; this test's own is alive.
const EXITED_PID = "2147483646";
const LIVE_PID = String(process.pid);

/**
 * The real file system, with a Linux `/proc` of one readable process and one whose
 * executable reads once, then nothing else of it does: one that exited, or one still
 * running whose /proc entry is gone too (as hidepid hides it).
 */
const withProc = (real: FileSystem.FileSystem, next: "exits" | "stays unreadable") => {
  let executableReads = 0;
  const pid = next === "exits" ? EXITED_PID : LIVE_PID;
  const unreadable = (path: string) => Effect.fail(missing(path));
  return FileSystem.FileSystem.of({
    ...real,
    readDirectory: (path, options) =>
      path === "/proc" ? Effect.succeed(["1", "self", pid]) : real.readDirectory(path, options),
    readLink: (path) => {
      if (path === "/proc/1/exe") return Effect.succeed("/usr/lib/systemd/systemd");
      if (path === "/proc/1/cwd") return Effect.succeed("/");
      if (path === `/proc/${pid}/exe`) {
        executableReads += 1;
        return executableReads === 1 ? Effect.succeed("/usr/bin/sleep") : unreadable(path);
      }
      if (path === `/proc/${pid}/cwd`) return unreadable(path);
      return real.readLink(path);
    },
    stat: (path) => (path === `/proc/${pid}` ? unreadable(path) : real.stat(path)),
    readFileString: (path, encoding) => {
      if (path === "/proc/1/cmdline") return Effect.succeed("/usr/lib/systemd/systemd\0");
      if (path === `/proc/${pid}/cmdline`) return unreadable(path);
      return real.readFileString(path, encoding);
    },
  });
};

it.layer(NodeServices.layer)("prunePinnedRuntimes on Linux", (it) => {
  const prune = (next: "exits" | "stays unreadable") =>
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
      return yield* prunePinnedRuntimes({ baseDir, keep: ["2.0.0"] }).pipe(
        Effect.provideService(FileSystem.FileSystem, withProc(real, next)),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Environment, { T3CODE_INSTALL_BIN_DIR: baseDir }),
        Effect.provide(ProcessRunner.layer),
      );
    });

  it.effect("still prunes when a process exits while the process list is read", () =>
    Effect.gen(function* () {
      assert.deepEqual((yield* prune("exits")).toSorted(), ["1.0.0", "1.1.0"]);
    }),
  );

  it.effect("prunes nothing while a running process cannot be read", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* prune("stays unreadable"), []);
    }),
  );
});
