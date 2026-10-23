import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import {
  LATEX_TEX_LOCATION_FILE,
  isPrivateTexFolder,
  isTexSafePath,
  LatexTexDirectory,
  latexTexDirectory,
  make as makeLatexTexDirectory,
  privateFolderLockArguments,
  resolveLatexTexDirectory,
  windowsUserSid,
} from "./latexTexDirectory.ts";

const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";

const output = (
  overrides: Partial<ProcessRunner.ProcessRunOutput> = {},
): ProcessRunner.ProcessRunOutput => ({
  stdout: "",
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
  ...overrides,
});

/** `whoami` names this account; `icacls` succeeds. */
const windowsTools = (input: ProcessRunner.ProcessRunInput) =>
  Effect.succeed(
    input.command.endsWith("whoami.exe")
      ? output({ stdout: `"desktop-1\\\\יעקב","${SID}"\r\n` })
      : output({ stdout: "Successfully processed 1 files; Failed processing 0 files" }),
  );

/**
 * A profile `latexDir` with a Hebrew name and an empty stand-in for
 * `%ProgramData%`, both in a real temporary directory. The platform and the
 * Windows tools are pinned per test: whether to move is a platform decision,
 * and the tools only exist on Windows.
 */
const harness = (
  options: {
    readonly platform?: NodeJS.Platform;
    readonly profileName?: string;
    readonly programData?: "present" | "absent" | "missing";
    readonly respond?: (
      input: ProcessRunner.ProcessRunInput,
    ) => Effect.Effect<ProcessRunner.ProcessRunOutput>;
    /** Stands in for a disk that stops answering part-way. */
    readonly wrapFileSystem?: (fileSystem: FileSystem.FileSystem) => FileSystem.FileSystem;
  } = {},
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-latex-location-" });
    const latexDir = path.join(root, options.profileName ?? "יעקב", "latex");
    const programData = path.join(root, "ProgramData");
    yield* fileSystem.makeDirectory(latexDir, { recursive: true });
    if (options.programData !== "missing") yield* fileSystem.makeDirectory(programData);
    const calls = yield* Ref.make<ReadonlyArray<ProcessRunner.ProcessRunInput>>([]);
    const respond = options.respond ?? windowsTools;
    const services = Layer.mergeAll(
      Layer.succeed(
        ProcessRunner.ProcessRunner,
        ProcessRunner.ProcessRunner.of({
          run: (input) =>
            Ref.update(calls, (previous) => [...previous, input]).pipe(
              Effect.andThen(respond(input)),
            ),
        }),
      ),
      Layer.succeed(
        FileSystem.FileSystem,
        options.wrapFileSystem === undefined ? fileSystem : options.wrapFileSystem(fileSystem),
      ),
      Layer.succeed(HostProcess.Platform, options.platform ?? "win32"),
      Layer.succeed(HostProcess.Environment, {
        SystemRoot: "C:\\Windows",
        ...(options.programData === "absent" ? {} : { PROGRAMDATA: programData }),
      }),
    );
    const resolve = resolveLatexTexDirectory(latexDir).pipe(Effect.provide(services));
    const privateFolders = fileSystem
      .readDirectory(programData)
      .pipe(Effect.map((entries) => entries.map((entry) => path.join(programData, entry))));
    const privateFoldersOrNone = fileSystem
      .exists(programData)
      .pipe(Effect.flatMap((present) => (present ? privateFolders : Effect.succeed([]))));
    const stagingLeftovers = fileSystem
      .readDirectory(latexDir)
      .pipe(Effect.map((entries) => entries.filter((entry) => entry.startsWith(".scient-latex-"))));
    return {
      latexDir,
      programData,
      calls,
      resolve,
      privateFolders: privateFoldersOrNone,
      stagingLeftovers,
    };
  });

describe("isTexSafePath", () => {
  it("accepts printable ASCII, spaces included, and nothing else", () => {
    expect(isTexSafePath("C:\\Users\\Jane Doe\\.scient-next\\userdata\\latex")).toBe(true);
    expect(isTexSafePath("C:\\Users\\José\\.scient-next")).toBe(false);
    expect(isTexSafePath("C:\\Users\\יעקב\\.scient-next")).toBe(false);
  });
});

describe("isPrivateTexFolder", () => {
  it.effect("accepts only a folder of its own name directly under ProgramData", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const programData = "/c/ProgramData";
      const check = (directory: string) => isPrivateTexFolder({ directory, programData, path });
      expect(check("/c/ProgramData/scient-latex-0123456789abcdef")).toBe(true);
      expect(check("/c/programdata/scient-latex-0123456789abcdef")).toBe(true);
      expect(check("/c/ProgramData/other/scient-latex-0123456789abcdef")).toBe(false);
      expect(check("/c/ProgramData/../Users/scient-latex-0123456789abcdef")).toBe(false);
      expect(check("/c/ProgramData/scient-latex-shared")).toBe(false);
      expect(check("/c/Users/scient-latex-0123456789abcdef")).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("windowsUserSid", () => {
  it("reads the SID from whoami's CSV line, whatever the account is called", () => {
    expect(windowsUserSid(`"desktop-1\\יעקב","${SID}"\r\n`)).toBe(SID);
    expect(windowsUserSid("ERROR: Access is denied.")).toBeNull();
  });
});

describe("privateFolderLockArguments", () => {
  it("drops inherited access and grants this account, SYSTEM and Administrators only", () => {
    expect(
      privateFolderLockArguments("C:\\ProgramData\\scient-latex-0123456789abcdef", SID),
    ).toEqual([
      "C:\\ProgramData\\scient-latex-0123456789abcdef",
      "/inheritance:r",
      "/grant:r",
      `*${SID}:(OI)(CI)F`,
      "*S-1-5-18:(OI)(CI)F",
      "*S-1-5-32-544:(OI)(CI)F",
    ]);
  });
});

describe("resolveLatexTexDirectory", () => {
  it.effect("leaves every non-Windows computer exactly as it was", () =>
    Effect.gen(function* () {
      const fixture = yield* harness({ platform: "darwin" });
      expect(yield* fixture.resolve).toBe(fixture.latexDir);
      expect(yield* Ref.get(fixture.calls)).toEqual([]);
      expect(yield* fixture.privateFolders).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves a Windows profile whose path is already ASCII exactly as it was", () =>
    Effect.gen(function* () {
      const fixture = yield* harness({ profileName: "Jane Doe" });
      expect(yield* fixture.resolve).toBe(fixture.latexDir);
      expect(yield* Ref.get(fixture.calls)).toEqual([]);
      expect(yield* fixture.privateFolders).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("locks the folder inside the profile, then moves it into ProgramData", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* harness();
      const directory = yield* fixture.resolve;
      expect(path.dirname(directory)).toBe(fixture.programData);
      expect(path.basename(directory)).toMatch(/^scient-latex-[0-9a-f]{16}$/u);
      expect(isTexSafePath(path.basename(directory))).toBe(true);
      expect(yield* fixture.privateFolders).toEqual([directory]);
      // The lock is applied where only this account can reach the folder.
      const staging = path.join(fixture.latexDir, `.${path.basename(directory)}`);
      const calls = yield* Ref.get(fixture.calls);
      expect(calls.map((call) => [call.command, call.args])).toEqual([
        ["C:\\Windows\\System32\\whoami.exe", ["/user", "/fo", "csv", "/nh"]],
        ["C:\\Windows\\System32\\icacls.exe", privateFolderLockArguments(staging, SID)],
      ]);
      expect(yield* fixture.stagingLeftovers).toEqual([]);
      const info = yield* fileSystem.stat(directory);
      const recorded = JSON.parse(
        yield* fileSystem.readFileString(path.join(fixture.latexDir, LATEX_TEX_LOCATION_FILE)),
      );
      expect(recorded).toEqual({
        schemaVersion: 1,
        directory,
        identity: `${String(info.dev)}:${String(Option.getOrThrow(info.ino))}`,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("finds the same folder on the next start without touching it again", () =>
    Effect.gen(function* () {
      const fixture = yield* harness();
      const first = yield* fixture.resolve;
      yield* Ref.set(fixture.calls, []);
      expect(yield* fixture.resolve).toBe(first);
      expect(yield* Ref.get(fixture.calls)).toEqual([]);
      expect(yield* fixture.privateFolders).toEqual([first]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("makes a new folder when the recorded one is gone", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const fixture = yield* harness();
      const first = yield* fixture.resolve;
      yield* fileSystem.remove(first, { recursive: true });
      const second = yield* fixture.resolve;
      expect(second).not.toBe(first);
      expect(yield* fixture.privateFolders).toEqual([second]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores a folder someone recreated under the recorded name", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* harness();
      const first = yield* fixture.resolve;
      // Made while the original still exists, so it is a different folder
      // even where a filesystem hands a freed inode number straight back.
      const impostor = path.join(path.dirname(fixture.programData), "impostor");
      yield* fileSystem.makeDirectory(path.join(impostor, "managed"), { recursive: true });
      yield* fileSystem.writeFileString(path.join(impostor, "managed", "managed-state.json"), "{}");
      yield* fileSystem.remove(first, { recursive: true });
      yield* fileSystem.rename(impostor, first);
      const second = yield* fixture.resolve;
      expect(second).not.toBe(first);
      expect(path.dirname(second)).toBe(fixture.programData);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores a link left at the recorded name", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* harness();
      const first = yield* fixture.resolve;
      const elsewhere = path.join(path.dirname(fixture.programData), "elsewhere");
      yield* fileSystem.rename(first, elsewhere);
      yield* fileSystem.symlink(elsewhere, first);
      // Same identity behind the link, which is exactly why a link is refused.
      const second = yield* fixture.resolve;
      expect(second).not.toBe(first);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("never adopts a recorded folder it could not have made", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* harness();
      const elsewhere = path.join(
        path.dirname(fixture.programData),
        "scient-latex-0123456789abcdef",
      );
      yield* fileSystem.makeDirectory(elsewhere);
      const info = yield* fileSystem.stat(elsewhere);
      yield* fileSystem.writeFileString(
        path.join(fixture.latexDir, LATEX_TEX_LOCATION_FILE),
        JSON.stringify({
          schemaVersion: 1,
          directory: elsewhere,
          identity: `${String(info.dev)}:${String(Option.getOrThrow(info.ino))}`,
        }),
      );
      const directory = yield* fixture.resolve;
      expect(directory).not.toBe(elsewhere);
      expect(path.dirname(directory)).toBe(fixture.programData);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("stays in the profile, leaving nothing behind, when the folder cannot be locked", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* harness({
        respond: (input) =>
          input.command.endsWith("icacls.exe")
            ? Effect.succeed(
                output({ code: ChildProcessSpawner.ExitCode(5), stderr: "Access is denied." }),
              )
            : windowsTools(input),
      });
      expect(yield* fixture.resolve).toBe(fixture.latexDir);
      expect(yield* fixture.privateFolders).toEqual([]);
      expect(yield* fixture.stagingLeftovers).toEqual([]);
      expect(yield* fileSystem.exists(path.join(fixture.latexDir, LATEX_TEX_LOCATION_FILE))).toBe(
        false,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("stays in the profile when whoami cannot name the account", () =>
    Effect.gen(function* () {
      const fixture = yield* harness({
        respond: (input) =>
          input.command.endsWith("whoami.exe")
            ? Effect.succeed(output({ stdout: "INFO: no user information." }))
            : windowsTools(input),
      });
      expect(yield* fixture.resolve).toBe(fixture.latexDir);
      expect(yield* fixture.privateFolders).toEqual([]);
      expect(yield* fixture.stagingLeftovers).toEqual([]);
      expect((yield* Ref.get(fixture.calls)).map((call) => call.command)).toEqual([
        "C:\\Windows\\System32\\whoami.exe",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("stays in the profile when the locked folder cannot be moved there", () =>
    Effect.gen(function* () {
      // As on a profile kept on another drive: the move is refused.
      const fixture = yield* harness({ programData: "missing" });
      expect(yield* fixture.resolve).toBe(fixture.latexDir);
      expect(yield* fixture.stagingLeftovers).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("lets the server start when cleaning up a failed attempt hangs", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const stalled = yield* Deferred.make<void>();
      let diskStuck = true;
      const fixture = yield* harness({
        respond: (input) =>
          diskStuck && input.command.endsWith("icacls.exe")
            ? Effect.succeed(
                output({ code: ChildProcessSpawner.ExitCode(5), stderr: "Access is denied." }),
              )
            : windowsTools(input),
        wrapFileSystem: (real) => ({
          ...real,
          remove: (target, options) =>
            diskStuck && target.includes(".scient-latex-")
              ? Deferred.succeed(stalled, undefined).pipe(Effect.andThen(Effect.never))
              : real.remove(target, options),
        }),
      });
      const running = yield* Effect.forkChild(fixture.resolve);
      yield* Deferred.await(stalled);
      yield* TestClock.adjust("31 seconds");
      expect(yield* Fiber.join(running)).toBe(fixture.latexDir);
      expect(yield* fixture.stagingLeftovers).toHaveLength(1);

      // The next start sweeps what that attempt left in the profile.
      diskStuck = false;
      expect(path.dirname(yield* fixture.resolve)).toBe(fixture.programData);
      expect(yield* fixture.stagingLeftovers).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("follows a record published after the wait ran out, from the next start", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stalled = yield* Deferred.make<void>();
      let diskStuck = true;
      const fixture = yield* harness({
        wrapFileSystem: (real) => ({
          ...real,
          rename: (from, to) =>
            diskStuck && to.endsWith(LATEX_TEX_LOCATION_FILE)
              ? real
                  .rename(from, to)
                  .pipe(
                    Effect.andThen(Deferred.succeed(stalled, undefined)),
                    Effect.andThen(Effect.never),
                  )
              : real.rename(from, to),
        }),
      });
      const running = yield* Effect.forkChild(fixture.resolve);
      yield* Deferred.await(stalled);
      yield* TestClock.adjust("31 seconds");
      // This start never heard back, so it keeps the profile folder.
      expect(yield* Fiber.join(running)).toBe(fixture.latexDir);

      diskStuck = false;
      const recorded = JSON.parse(
        yield* fileSystem.readFileString(path.join(fixture.latexDir, LATEX_TEX_LOCATION_FILE)),
      );
      expect(yield* fixture.resolve).toBe(recorded.directory);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("lets the server start even when a tool hangs beyond interruption", () =>
    Effect.gen(function* () {
      const stalled = yield* Deferred.make<void>();
      const fixture = yield* harness({
        respond: (input) =>
          input.command.endsWith("icacls.exe")
            ? Deferred.succeed(stalled, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.uninterruptible,
              )
            : windowsTools(input),
      });
      const running = yield* Effect.forkChild(fixture.resolve);
      yield* Deferred.await(stalled);
      yield* TestClock.adjust("31 seconds");
      expect(yield* Fiber.join(running)).toBe(fixture.latexDir);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("lets the server start when writing the record hangs, and clears it next time", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stalled = yield* Deferred.make<void>();
      let diskStuck = true;
      const fixture = yield* harness({
        wrapFileSystem: (real) => ({
          ...real,
          writeFileString: (target, data, options) =>
            diskStuck && path.basename(target).startsWith(".scient-latex-")
              ? real
                  .writeFileString(target, data, options)
                  .pipe(
                    Effect.andThen(Deferred.succeed(stalled, undefined)),
                    Effect.andThen(Effect.never),
                  )
              : real.writeFileString(target, data, options),
        }),
      });
      const running = yield* Effect.forkChild(fixture.resolve);
      yield* Deferred.await(stalled);
      yield* TestClock.adjust("31 seconds");
      expect(yield* Fiber.join(running)).toBe(fixture.latexDir);
      expect(yield* fileSystem.exists(path.join(fixture.latexDir, LATEX_TEX_LOCATION_FILE))).toBe(
        false,
      );
      expect(yield* fixture.stagingLeftovers).toHaveLength(1);

      diskStuck = false;
      const directory = yield* fixture.resolve;
      expect(path.dirname(directory)).toBe(fixture.programData);
      expect(yield* fixture.stagingLeftovers).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("stays in the profile on a computer without a ProgramData folder", () =>
    Effect.gen(function* () {
      const fixture = yield* harness({ programData: "absent" });
      expect(yield* fixture.resolve).toBe(fixture.latexDir);
      expect(yield* Ref.get(fixture.calls)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("layer", () => {
  it.effect("names the TeX folder for the services it is provided to, and nothing else", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-latex-layer-" });
      const baseDir = path.join(root, "יעקב");
      const programData = path.join(root, "ProgramData");
      yield* fileSystem.makeDirectory(programData);
      const config = ServerConfig.layerTest(root, baseDir);
      const read = Effect.all([
        latexTexDirectory,
        ServerConfig.ServerConfig.use((service) => Effect.succeed(service.latexDir)),
      ]);

      const [unprovided, latexDir] = yield* read.pipe(Effect.provide(config));
      expect(unprovided).toBe(latexDir);

      const [texDirectory, unchanged] = yield* read.pipe(
        Effect.provide(
          Layer.effect(LatexTexDirectory, makeLatexTexDirectory).pipe(
            Layer.provideMerge(config),
            Layer.provide(
              Layer.succeed(
                ProcessRunner.ProcessRunner,
                ProcessRunner.ProcessRunner.of({ run: windowsTools }),
              ),
            ),
            Layer.provide(Layer.succeed(HostProcess.Platform, "win32")),
            Layer.provide(Layer.succeed(HostProcess.Environment, { ProgramData: programData })),
          ),
        ),
      );
      expect(path.dirname(texDirectory)).toBe(programData);
      // Evidence, SyncTeX indexes and the record stay where they were.
      expect(unchanged).toBe(latexDir);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
