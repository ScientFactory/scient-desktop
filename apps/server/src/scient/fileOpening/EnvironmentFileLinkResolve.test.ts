// @effect-diagnostics nodeBuiltinImport:off - tests change the file system while a search runs.
import type * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentFilePath } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import {
  findFilesNamed,
  rankLinkCandidates,
  resolveEnvironmentFileLink,
} from "./EnvironmentFileLinkResolve.ts";

const make = EnvironmentFilePath.make;

/**
 * A workspace and a sibling folder outside it:
 *
 *   <base>/workspace/project/reviews/inside.md
 *   <base>/workspace/project/reviews/{a,b}/dup.md
 *   <base>/workspace/project/linked-notes.md -> <base>/outside/notes.md
 *   <base>/workspace/node_modules/pkg/inside.md
 *   <base>/outside/notes.md
 */
const makeFixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-link-resolve-" }),
  );
  const workspace = path.join(base, "workspace");
  const write = (relativePath: string, contents = "x\n") =>
    Effect.gen(function* () {
      const filePath = path.join(base, relativePath);
      yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fileSystem.writeFileString(filePath, contents);
    });
  yield* write("workspace/project/reviews/inside.md");
  yield* write("workspace/project/reviews/a/dup.md");
  yield* write("workspace/project/reviews/b/dup.md");
  yield* write("workspace/node_modules/pkg/inside.md");
  yield* write("outside/notes.md");
  const resolve = (linkPath: string, changedPaths?: ReadonlyArray<string>) =>
    resolveEnvironmentFileLink({
      workspaceRoot: make(workspace),
      path: make(linkPath),
      ...(changedPaths ? { changedPaths: changedPaths.map((changed) => make(changed)) } : {}),
    });
  return { base, workspace, write, resolve, fileSystem, path };
});

const TestLayer = NodeServices.layer;

describe("resolveEnvironmentFileLink", () => {
  it.effect("opens a link as written whenever its location exists", () =>
    Effect.gen(function* () {
      const { base, workspace, resolve, path } = yield* makeFixture;
      expect(yield* resolve("project/reviews/inside.md")).toEqual({
        _tag: "literal",
        path: path.join(workspace, "project/reviews/inside.md"),
      });
      // Outside the workspace, by `..` or absolutely: still just the file named.
      expect(yield* resolve("../outside/notes.md")).toEqual({
        _tag: "literal",
        path: path.join(base, "outside/notes.md"),
      });
      expect(yield* resolve(path.join(base, "outside/notes.md"))).toMatchObject({
        _tag: "literal",
      });
      // A folder exists too; opening it reports that it is not a file.
      expect(yield* resolve("project/reviews")).toMatchObject({ _tag: "literal" });
    }).pipe(Effect.provide(TestLayer), Effect.scoped),
  );

  it.effect("reads `~/` as the home folder of the machine that owns the files", () =>
    Effect.gen(function* () {
      const { base, workspace, write, path } = yield* makeFixture;
      const home = path.join(base, "home");
      yield* write("home/notes/today.md");
      const resolveFromHome = (linkPath: string) =>
        resolveEnvironmentFileLink(
          { workspaceRoot: make(workspace), path: make(linkPath) },
          undefined,
          home,
        );

      expect(yield* resolveFromHome("~/notes/today.md")).toEqual({
        _tag: "literal",
        path: path.join(home, "notes/today.md"),
      });
      // Nothing there: the search is for the file the home path named.
      expect(yield* resolveFromHome("~/elsewhere/inside.md")).toEqual({
        _tag: "recovered",
        path: "project/reviews/inside.md",
        missingPath: path.join(home, "elsewhere/inside.md"),
      });
      // A workspace folder really named `~` is what the path as written names.
      yield* write("workspace/~/notes/today.md");
      expect(yield* resolveFromHome("~/notes/today.md")).toEqual({
        _tag: "literal",
        path: path.join(workspace, "~/notes/today.md"),
      });
    }).pipe(Effect.provide(TestLayer), Effect.scoped),
  );

  it.effect("recovers a link written relative to the wrong directory", () =>
    Effect.gen(function* () {
      const { base, workspace, resolve, path } = yield* makeFixture;
      // Relative to a subfolder the agent was thinking in.
      expect(yield* resolve("reviews/inside.md")).toEqual({
        _tag: "recovered",
        path: "project/reviews/inside.md",
        missingPath: path.join(workspace, "reviews/inside.md"),
      });
      // Relative to a shell that was one level elsewhere.
      expect(yield* resolve("../project/reviews/inside.md")).toEqual({
        _tag: "recovered",
        path: "project/reviews/inside.md",
        missingPath: path.join(base, "project/reviews/inside.md"),
      });
      // Dependency trees are never searched, so the copy there cannot tie.
      expect(yield* resolve("inside.md")).toMatchObject({
        _tag: "recovered",
        path: "project/reviews/inside.md",
      });
    }).pipe(Effect.provide(TestLayer), Effect.scoped),
  );

  it.effect.skipIf(!symlinksSupported)(
    "finds files that exist only as symlinks, which a file index does not list",
    () =>
      Effect.gen(function* () {
        const { base, workspace, resolve, fileSystem, path } = yield* makeFixture;
        yield* fileSystem.symlink(
          path.join(base, "outside/notes.md"),
          path.join(workspace, "project/linked-notes.md"),
        );
        yield* fileSystem.symlink(
          path.join(base, "outside/gone.md"),
          path.join(workspace, "project/dangling.md"),
        );
        yield* fileSystem.symlink(
          path.join(base, "outside"),
          path.join(workspace, "project/outside-dir"),
        );

        expect(yield* resolve("linked-notes.md")).toEqual({
          _tag: "recovered",
          path: "project/linked-notes.md",
          missingPath: path.join(workspace, "linked-notes.md"),
        });
        // A dangling link is not a file, and a symlinked folder is not entered:
        // `notes.md` is reachable only through `outside-dir`, so it is not found.
        expect(yield* resolve("dangling.md")).toMatchObject({ _tag: "none" });
        expect(yield* resolve("notes.md")).toMatchObject({ _tag: "none" });
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
  );

  it.effect("offers a tie as choices, and lets only the turn's changed file break it", () =>
    Effect.gen(function* () {
      const { workspace, resolve, write, path } = yield* makeFixture;
      const missingPath = path.join(workspace, "dup.md");
      expect(yield* resolve("dup.md")).toEqual({
        _tag: "tie",
        paths: expect.arrayContaining(["project/reviews/a/dup.md", "project/reviews/b/dup.md"]),
        missingPath,
      });
      expect(yield* resolve("dup.md", ["project/reviews/b/dup.md"])).toEqual({
        _tag: "recovered",
        path: "project/reviews/b/dup.md",
        missingPath,
      });
      // Two changed files are still a tie, and a changed file that no longer
      // exists, or that matches less of the path, decides nothing.
      expect(
        yield* resolve("dup.md", ["project/reviews/a/dup.md", "project/reviews/b/dup.md"]),
      ).toMatchObject({ _tag: "tie" });
      expect(yield* resolve("dup.md", ["deleted/dup.md"])).toMatchObject({ _tag: "tie" });
      yield* write("workspace/drafts/inside.md");
      expect(yield* resolve("reviews/inside.md", ["drafts/inside.md"])).toMatchObject({
        _tag: "recovered",
        path: "project/reviews/inside.md",
      });
    }).pipe(Effect.provide(TestLayer), Effect.scoped),
  );

  it.effect("reports nothing found, and rejects a relative workspace root", () =>
    Effect.gen(function* () {
      const { workspace, resolve, path } = yield* makeFixture;
      expect(yield* resolve("reviews/missing.md")).toEqual({
        _tag: "none",
        missingPath: path.join(workspace, "reviews/missing.md"),
      });
      const error = yield* resolveEnvironmentFileLink({
        workspaceRoot: make("workspace"),
        path: make("notes.md"),
      }).pipe(Effect.flip);
      expect(error.failure).toBe("path_not_absolute");
    }).pipe(Effect.provide(TestLayer), Effect.scoped),
  );

  // chmod cannot deny the superuser, and Windows has no POSIX permission bits.
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32" || process.getuid?.() === 0)(
    "keeps a denied location as the link's file and never calls a partial search unique",
    () =>
      Effect.gen(function* () {
        const { workspace, resolve, write, fileSystem, path } = yield* makeFixture;
        // The link's own file exists but cannot be read: that is the answer.
        yield* write("workspace/locked.md");
        yield* fileSystem.chmod(path.join(workspace, "locked.md"), 0o000);
        expect(yield* resolve("locked.md")).toMatchObject({ _tag: "literal" });

        // An unreadable folder could hold a better match.
        yield* write("workspace/private/reviews/inside.md");
        yield* fileSystem.chmod(path.join(workspace, "private"), 0o000);
        const result = yield* resolve("reviews/inside.md");
        yield* fileSystem.chmod(path.join(workspace, "private"), 0o700);
        yield* fileSystem.chmod(path.join(workspace, "locked.md"), 0o600);
        expect(result).toEqual({
          _tag: "incomplete",
          paths: ["project/reviews/inside.md"],
          missingPath: path.join(workspace, "reviews/inside.md"),
        });
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
  );

  it.effect.skipIf(
    !symlinksSupported ||
      HostProcess.Platform.defaultValue() === "win32" ||
      process.getuid?.() === 0,
  )("does not call a match unique while a same-named symlink cannot be inspected", () =>
    Effect.gen(function* () {
      const { base, workspace, resolve, write, fileSystem, path } = yield* makeFixture;
      // The link's target sits in a folder that cannot be searched, so it may
      // well be a file: an equally good second candidate.
      yield* write("outside/sealed/inside.md");
      yield* fileSystem.makeDirectory(path.join(workspace, "other/reviews"), { recursive: true });
      yield* fileSystem.symlink(
        path.join(base, "outside/sealed/inside.md"),
        path.join(workspace, "other/reviews/inside.md"),
      );
      yield* fileSystem.chmod(path.join(base, "outside/sealed"), 0o000);
      const result = yield* resolve("reviews/inside.md");
      yield* fileSystem.chmod(path.join(base, "outside/sealed"), 0o700);

      expect(result).toEqual({
        _tag: "incomplete",
        paths: ["project/reviews/inside.md"],
        missingPath: path.join(workspace, "reviews/inside.md"),
      });
    }).pipe(Effect.provide(TestLayer), Effect.scoped),
  );
});

describe("findFilesNamed", () => {
  it.effect("stops at its bounds and says the search was incomplete", () =>
    Effect.gen(function* () {
      const { workspace, write } = yield* makeFixture;
      for (let index = 0; index < 12; index += 1) {
        yield* write(`workspace/many/dir${index}/same.md`);
      }
      const complete = yield* Effect.promise(() => findFilesNamed(workspace, "same.md"));
      expect(complete.complete).toBe(true);
      expect(complete.candidates).toHaveLength(12);

      const bounded = yield* Effect.promise(() =>
        findFilesNamed(workspace, "same.md", { maxDirectories: 4, deadlineMs: 60_000 }),
      );
      expect(bounded.complete).toBe(false);
      expect(bounded.candidates.length).toBeLessThan(12);
    }).pipe(Effect.provide(TestLayer), Effect.scoped),
  );
});

describe("findFilesNamed time bound", () => {
  // A clock that advances one tick each time it is read, so a test decides
  // exactly which check the deadline falls on.
  const tickingClock = () => {
    let tick = 0;
    return () => tick++;
  };
  const flatDirectory = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // The search requires a real root; the system temp directory is often a link.
    const root = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-link-bound-" }),
    );
    for (const name of ["a.md", "b.md", "c.md", "same.md"]) {
      yield* fileSystem.writeFileString(path.join(root, name), "x\n");
    }
    return { root, fileSystem, path };
  });
  const search = (root: string, deadlineMs: number) =>
    Effect.promise(() =>
      findFilesNamed(root, "same.md", { maxDirectories: 1_000, deadlineMs, now: tickingClock() }),
    );

  it.effect("stops inside one large directory, not only between directories", () =>
    Effect.gen(function* () {
      const { root } = yield* flatDirectory;
      // Start 0, directory check 1, then one tick per entry: four entries need
      // ticks 2..5, so a deadline of 3 expires while the directory is listed.
      expect((yield* search(root, 3)).complete).toBe(false);
      // Enough time for every entry and the final check.
      expect(yield* search(root, 6)).toEqual({
        candidates: [{ path: expect.stringMatching(/same\.md$/u), kind: "file" }],
        complete: true,
      });
    }).pipe(Effect.provide(TestLayer), Effect.scoped),
  );

  it.effect("is not complete when time runs out while the last directory was examined", () =>
    Effect.gen(function* () {
      const { root } = yield* flatDirectory;
      // Every entry check passes (ticks 2..5); only the final check (6) is late.
      expect(yield* search(root, 5)).toEqual({
        candidates: [{ path: expect.stringMatching(/same\.md$/u), kind: "file" }],
        complete: false,
      });
    }).pipe(Effect.provide(TestLayer), Effect.scoped),
  );

  it.effect("counts empty and unreadable directories against the bound", () =>
    Effect.gen(function* () {
      const { root, fileSystem, path } = yield* flatDirectory;
      const emptyRoot = path.join(root, "empties");
      for (let index = 0; index < 20; index += 1) {
        yield* fileSystem.makeDirectory(path.join(emptyRoot, `empty${index}`), { recursive: true });
      }
      const clock = tickingClock();
      let reads = 0;
      const result = yield* Effect.promise(() =>
        findFilesNamed(emptyRoot, "same.md", {
          maxDirectories: 1_000,
          deadlineMs: 30,
          now: () => {
            reads += 1;
            return clock();
          },
        }),
      );
      expect(result.complete).toBe(false);
      // It stopped at the deadline instead of reading all twenty empty folders:
      // 1 start + 1 root check + 20 root entries + a few directory checks.
      expect(reads).toBeLessThan(40);
    }).pipe(Effect.provide(TestLayer), Effect.scoped),
  );
});

describe("resolveEnvironmentFileLink while the workspace changes", () => {
  // Lists a directory for real, then runs a change the first time `directory`
  // is listed: the moment between the search seeing an entry and using it.
  const changingAfterListing = (directory: string, change: () => Promise<void>) => {
    let armed = true;
    return async (listed: string) => {
      const entries = await NodeFSP.readdir(listed, { withFileTypes: true });
      if (armed && listed === directory) {
        armed = false;
        await change();
      }
      return entries;
    };
  };
  const limits = (readDirectory: (directory: string) => Promise<ReadonlyArray<NodeFS.Dirent>>) => ({
    maxDirectories: 1_000,
    deadlineMs: 10_000,
    readDirectory,
  });

  it.effect.skipIf(!symlinksSupported)(
    "opens what is at the link's own location, even a link whose target is gone",
    () =>
      Effect.gen(function* () {
        const { workspace, resolve, write, fileSystem, path } = yield* makeFixture;
        yield* write("workspace/other/victim.md");
        yield* fileSystem.symlink(
          path.join(workspace, "absent.md"),
          path.join(workspace, "victim.md"),
        );
        expect(yield* resolve("victim.md")).toEqual({
          _tag: "literal",
          path: path.join(workspace, "victim.md"),
        });
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
  );

  it.effect.skipIf(!symlinksSupported)(
    "does not follow a folder swapped for a link out of the workspace during the search",
    () =>
      Effect.gen(function* () {
        const { base, workspace, write, path } = yield* makeFixture;
        yield* write("workspace/queued/keep.md");
        yield* write("outside/victim.md");
        const queued = path.join(workspace, "queued");
        const result = yield* resolveEnvironmentFileLink(
          { workspaceRoot: make(workspace), path: make("missing/victim.md") },
          limits(
            changingAfterListing(workspace, async () => {
              await NodeFSP.rm(queued, { recursive: true });
              await NodeFSP.symlink(path.join(base, "outside"), queued);
            }),
          ),
        );
        // The outside file is never offered, and the search admits it did not
        // examine everything.
        expect(result).toEqual({
          _tag: "incomplete",
          paths: [],
          missingPath: path.join(workspace, "missing/victim.md"),
        });
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
  );

  it.effect.skipIf(!symlinksSupported || HostProcess.Platform.defaultValue() === "win32")(
    "does not return a candidate that changed after it was seen",
    () =>
      Effect.gen(function* () {
        for (const replacement of ["deleted", "directory", "link"] as const) {
          const { base, workspace, write, path } = yield* makeFixture;
          yield* write("workspace/candidate/victim.md");
          yield* write("outside/other.md");
          const candidate = path.join(workspace, "candidate/victim.md");
          const result = yield* resolveEnvironmentFileLink(
            { workspaceRoot: make(workspace), path: make("missing/victim.md") },
            limits(
              changingAfterListing(path.dirname(candidate), async () => {
                await NodeFSP.unlink(candidate);
                if (replacement === "directory") await NodeFSP.mkdir(candidate);
                if (replacement === "link") {
                  await NodeFSP.symlink(path.join(base, "outside/other.md"), candidate);
                }
              }),
            ),
          );
          expect(result, replacement).toEqual({
            _tag: "incomplete",
            paths: [],
            missingPath: path.join(workspace, "missing/victim.md"),
          });
        }
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
  );

  it.effect("answers within its bound when a directory listing never returns", () =>
    Effect.gen(function* () {
      const { workspace, path } = yield* makeFixture;
      const started = yield* Clock.currentTimeMillis;
      const result = yield* resolveEnvironmentFileLink(
        { workspaceRoot: make(workspace), path: make("missing/inside.md") },
        { maxDirectories: 1_000, deadlineMs: 150, readDirectory: () => new Promise(() => {}) },
      );
      expect(result).toEqual({
        _tag: "incomplete",
        paths: [],
        missingPath: path.join(workspace, "missing/inside.md"),
      });
      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(2_000);
    }).pipe(Effect.provide(TestLayer), Effect.scoped, TestClock.withLive),
  );

  it.effect.skipIf(!symlinksSupported)(
    "breaks a tie with a changed file when the workspace root is itself a link",
    () =>
      Effect.gen(function* () {
        const { base, workspace, fileSystem, path } = yield* makeFixture;
        const alias = path.join(base, "alias");
        yield* fileSystem.symlink(workspace, alias);
        const viaAlias = (changedPaths: ReadonlyArray<string>) =>
          resolveEnvironmentFileLink({
            workspaceRoot: make(alias),
            path: make("dup.md"),
            changedPaths: changedPaths.map((changed) => make(changed)),
          });
        const expected = {
          _tag: "recovered",
          path: "project/reviews/b/dup.md",
          missingPath: path.join(alias, "dup.md"),
        };
        // A folder whose name merely starts with two dots is inside the workspace.
        yield* fileSystem.makeDirectory(path.join(workspace, "..notes"), { recursive: true });
        yield* fileSystem.writeFileString(path.join(workspace, "..notes/dup.md"), "x\n");
        expect(
          yield* resolveEnvironmentFileLink({
            workspaceRoot: make(alias),
            path: make("zz/dup.md"),
            changedPaths: [make("..notes/dup.md")],
          }),
        ).toMatchObject({ _tag: "recovered", path: "..notes/dup.md" });
        yield* fileSystem.remove(path.join(workspace, "..notes"), { recursive: true });
        // Relative to the workspace, by its alias, or by its real path.
        expect(yield* viaAlias(["project/reviews/b/dup.md"])).toEqual(expected);
        expect(yield* viaAlias([path.join(alias, "project/reviews/b/dup.md")])).toEqual(expected);
        expect(yield* viaAlias([path.join(workspace, "project/reviews/b/dup.md")])).toEqual(
          expected,
        );
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
  );
});

describe("rankLinkCandidates", () => {
  const none = new Set<string>();

  it("prefers the candidate sharing the longest path ending", () => {
    expect(
      rankLinkCandidates(
        "/elsewhere/reviews/notes.md",
        ["/w/drafts/notes.md", "/w/archive/reviews/notes.md"],
        none,
      ),
    ).toEqual(["/w/archive/reviews/notes.md"]);
  });

  it("needs the exact file name and returns every equally good candidate", () => {
    expect(rankLinkCandidates("/w/Notes.md", ["/w/a/notes.md"], none)).toEqual([]);
    expect(rankLinkCandidates("/w/dup.md", ["/w/a/dup.md", "/w/b/dup.md"], none)).toEqual([
      "/w/a/dup.md",
      "/w/b/dup.md",
    ]);
  });
});
