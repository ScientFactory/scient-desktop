import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import {
  allocateFreshPiSessionFile,
  cleanupFreshPiSessionFile,
  piInstanceStateRoot,
} from "./sessionFile.ts";

describe("PiSessionFile", () => {
  it.layer(NodeServices.layer)("allocates private, exclusive per-instance session files", (it) => {
    it.effect("keeps instance IDs from becoming directory traversal segments", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const stateDir = path.resolve("synthetic-pi-state");
        for (const instanceId of [".", "..", "", " pi "]) {
          expect(yield* Effect.result(piInstanceStateRoot({ stateDir, instanceId }))).toMatchObject(
            {
              _tag: "Failure",
            },
          );
        }
        expect(yield* piInstanceStateRoot({ stateDir, instanceId: "../other" })).toBe(
          path.join(stateDir, "providers", "pi", "..%2Fother", "sessions"),
        );
      }),
    );

    it.effect("allocates and only cleans fresh files", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-session-" });
          const root = yield* piInstanceStateRoot({ stateDir, instanceId: "pi_local" });
          const fresh = yield* allocateFreshPiSessionFile({
            stateRoot: root,
            fileId: "session/1",
          });
          expect(fresh.sessionFile).toBe(path.join(yield* fs.realPath(root), "session%2F1.jsonl"));
          expect((yield* fs.stat(root)).mode & 0o777).toBe(0o700);
          expect((yield* fs.stat(fresh.sessionFile)).mode & 0o777).toBe(0o600);
          expect(
            yield* Effect.result(
              allocateFreshPiSessionFile({ stateRoot: root, fileId: "session/1" }),
            ),
          ).toMatchObject({ _tag: "Failure" });
          yield* cleanupFreshPiSessionFile(fresh);
          expect(yield* fs.exists(fresh.sessionFile)).toBe(false);
        }),
      ),
    );

    it.effect("removes a newly written file when its chmod fails", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-session-chmod-" });
          const root = yield* piInstanceStateRoot({ stateDir, instanceId: "pi_local" });
          yield* fs.makeDirectory(root, { recursive: true });
          const sessionFile = path.join(yield* fs.realPath(root), "chmod-failure.jsonl");
          const chmodFailure = PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "chmod",
            pathOrDescriptor: sessionFile,
          });
          const failingFileSystem = FileSystem.FileSystem.of({
            ...fs,
            chmod: (target, mode) =>
              String(target) === sessionFile ? Effect.fail(chmodFailure) : fs.chmod(target, mode),
          });

          const failure = yield* allocateFreshPiSessionFile({
            stateRoot: root,
            fileId: "chmod-failure",
          }).pipe(Effect.provideService(FileSystem.FileSystem, failingFileSystem), Effect.flip);

          expect(failure).toBe(chmodFailure);
          expect(yield* fs.exists(sessionFile)).toBe(false);
        }),
      ),
    );

    it.effect("removes a newly written file when chmod is interrupted", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-session-chmod-" });
          const root = yield* piInstanceStateRoot({ stateDir, instanceId: "pi_local" });
          yield* fs.makeDirectory(root, { recursive: true });
          const sessionFile = path.join(yield* fs.realPath(root), "chmod-interrupt.jsonl");
          const chmodEntered = yield* Deferred.make<void>();
          const blockingFileSystem = FileSystem.FileSystem.of({
            ...fs,
            chmod: (target, mode) =>
              String(target) === sessionFile
                ? Deferred.succeed(chmodEntered, undefined).pipe(Effect.andThen(Effect.never))
                : fs.chmod(target, mode),
          });
          const allocation = yield* allocateFreshPiSessionFile({
            stateRoot: root,
            fileId: "chmod-interrupt",
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, blockingFileSystem),
            Effect.forkChild,
          );
          yield* Deferred.await(chmodEntered);
          yield* Fiber.interrupt(allocation);
          const exit = yield* Fiber.await(allocation);

          expect(exit._tag).toBe("Failure");
          if (exit._tag === "Failure")
            expect(exit.cause.reasons.every(Cause.isInterruptReason)).toBe(true);
          expect(yield* fs.exists(sessionFile)).toBe(false);
        }),
      ),
    );
  });
});
