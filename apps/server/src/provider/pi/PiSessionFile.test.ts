import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import {
  allocateFreshPiSessionFile,
  cleanupFreshPiSessionFile,
  cleanupResumedPiSessionFile,
  piInstanceStateRoot,
  piStateMatchesCursor,
  validatePiResumeSessionFile,
} from "./PiSessionFile.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

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
          const cursor = { schemaVersion: 1 as const, ...fresh, sessionId: "pi-generated-id" };
          expect(piStateMatchesCursor(cursor, cursor)).toBe(true);
          expect(
            yield* Effect.result(
              allocateFreshPiSessionFile({ stateRoot: root, fileId: "session/1" }),
            ),
          ).toMatchObject({ _tag: "Failure" });
          yield* cleanupResumedPiSessionFile(cursor);
          expect(yield* fs.exists(fresh.sessionFile)).toBe(true);
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

  it.layer(NodeServices.layer)("validates resume files", (it) => {
    it.effect("reads only a bounded header, not the accumulated conversation", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "scient-pi-large-session-" });
          const root = yield* piInstanceStateRoot({ stateDir: cwd, instanceId: "pi" });
          const fresh = yield* allocateFreshPiSessionFile({ stateRoot: root, fileId: "large" });
          const cursor = { ...fresh, schemaVersion: 1 as const, sessionId: "large" };
          yield* fs.writeFileString(
            fresh.sessionFile,
            json({ type: "session", id: "large", cwd }) + "\n" + "x".repeat(1024 * 1024),
          );
          let boundedReads = 0;
          const boundedFs = FileSystem.FileSystem.of({
            ...fs,
            readFileString: () => Effect.die("Resume must not read the whole conversation"),
            stream: (file, options) => {
              expect(options?.bytesToRead).toBe(64 * 1024);
              boundedReads++;
              return fs.stream(file, options);
            },
          });
          expect(
            yield* validatePiResumeSessionFile({ stateRoot: root, cursor, cwd }).pipe(
              Effect.provideService(FileSystem.FileSystem, boundedFs),
            ),
          ).toEqual(cursor);
          expect(boundedReads).toBe(1);
          yield* fs.writeFileString(fresh.sessionFile, "x".repeat(65537));
          expect(
            yield* validatePiResumeSessionFile({ stateRoot: root, cursor, cwd }).pipe(
              Effect.result,
            ),
          ).toMatchObject({ _tag: "Failure" });
        }),
      ),
    );

    it.effect("accepts an exact header and rejects traversal and symlinks", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-resume-" });
          const cwd = path.join(stateDir, "workspace");
          yield* fs.makeDirectory(cwd);
          const root = yield* piInstanceStateRoot({ stateDir, instanceId: "pi_local" });
          yield* fs.makeDirectory(root, { recursive: true });
          const sessionFile = path.join(root, "resume.jsonl");
          yield* fs.writeFileString(
            sessionFile,
            `{"type":"session","id":"session-1","cwd":"${cwd}"}\n`,
          );
          const canonicalSessionFile = yield* fs.realPath(sessionFile);
          const cursor = {
            schemaVersion: 1 as const,
            sessionFile: canonicalSessionFile,
            sessionId: "session-1",
          };
          expect(yield* validatePiResumeSessionFile({ stateRoot: root, cursor, cwd })).toEqual(
            cursor,
          );
          for (const sessionId of ["", "  ", " session-1 "]) {
            expect(
              yield* Effect.result(
                validatePiResumeSessionFile({
                  stateRoot: root,
                  cursor: { ...cursor, sessionId },
                  cwd,
                }),
              ),
            ).toMatchObject({ _tag: "Failure" });
          }
          const cwdLink = path.join(stateDir, "workspace-link");
          yield* fs.symlink(cwd, cwdLink);
          expect(
            yield* validatePiResumeSessionFile({ stateRoot: root, cursor, cwd: cwdLink }),
          ).toEqual(cursor);
          const outside = path.join(stateDir, "outside.jsonl");
          yield* fs.symlink(sessionFile, outside);
          expect(
            yield* Effect.result(
              validatePiResumeSessionFile({
                stateRoot: root,
                cursor: { ...cursor, sessionFile: outside },
                cwd,
              }),
            ),
          ).toMatchObject({ _tag: "Failure" });
          const link = path.join(root, "link.jsonl");
          yield* fs.symlink(sessionFile, link);
          expect(
            yield* Effect.result(
              validatePiResumeSessionFile({
                stateRoot: root,
                cursor: { ...cursor, sessionFile: link },
                cwd,
              }),
            ),
          ).toMatchObject({ _tag: "Failure" });
        }),
      ),
    );
  });
});
