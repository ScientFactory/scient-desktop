import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentFilePath } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

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
  it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32" || process.getuid?.() === 0)(
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
      expect(complete.paths).toHaveLength(12);

      const bounded = yield* Effect.promise(() =>
        findFilesNamed(workspace, "same.md", { maxDirectories: 4, deadlineMs: 60_000 }),
      );
      expect(bounded.complete).toBe(false);
      expect(bounded.paths.length).toBeLessThan(12);
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
