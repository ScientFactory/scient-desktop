import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

import {
  hasCursorSkillMention,
  makeCursorMachineSkillCatalog,
  probeCursorSkills,
  rewriteCursorSkillMentions,
} from "./skills.ts";

const runNode = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) => effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise);

describe("Cursor skills", () => {
  it("discovers recursive project skills with project precedence", async () =>
    await runNode(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const userHome = yield* fileSystem
          .makeTempDirectoryScoped({
            directory: NodeOS.tmpdir(),
            prefix: "cursor-skills-home-",
          })
          .pipe(Effect.flatMap((directory) => fileSystem.realPath(directory)));
        const workspace = yield* fileSystem
          .makeTempDirectoryScoped({
            directory: NodeOS.tmpdir(),
            prefix: "cursor-skills-workspace-",
          })
          .pipe(Effect.flatMap((directory) => fileSystem.realPath(directory)));
        const writeSkill = Effect.fn("writeCursorSkill")(function* (
          root: string,
          name: string,
          contents: string,
        ) {
          const skillDirectory = path.join(root, name);
          yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
          yield* fileSystem.writeFileString(path.join(skillDirectory, "SKILL.md"), contents);
        });

        yield* writeSkill(
          path.join(userHome, ".cursor", "skills"),
          "review",
          "---\ndescription: user review\n---\n",
        );
        yield* writeSkill(
          path.join(workspace, ".agents", "skills", "nested"),
          "review",
          "---\nname: Review changes\ndescription: project review\n---\n",
        );
        yield* writeSkill(
          path.join(workspace, ".cursor", "skills"),
          "internal",
          "---\nuser-invocable: false\n---\n",
        );
        yield* writeSkill(
          path.join(workspace, ".cursor", "skills"),
          "oversized",
          "x".repeat(1_000_001),
        );

        const skills = yield* probeCursorSkills(workspace, { HOME: userHome });
        expect(skills).toEqual([
          {
            name: "internal",
            path: path.join(workspace, ".cursor", "skills", "internal", "SKILL.md"),
            scope: "project",
            enabled: true,
            userInvocable: false,
          },
          {
            name: "review",
            displayName: "Review changes",
            description: "project review",
            path: path.join(workspace, ".agents", "skills", "nested", "review", "SKILL.md"),
            scope: "project",
            enabled: true,
          },
        ]);
        yield* fileSystem.makeDirectory(path.join(userHome, ".codex"), { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(userHome, ".codex", "skills"),
          "not a directory",
        );
        expect(
          (yield* probeCursorSkills(workspace, { HOME: userHome }).pipe(Effect.result))._tag,
        ).toBe("Failure");
      }),
    ));

  it.skipIf(!symlinksSupported)(
    "treats a symlinked skill outside the root as a package boundary",
    async () =>
      await runNode(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const userHome = yield* fileSystem.makeTempDirectoryScoped({
            directory: NodeOS.tmpdir(),
            prefix: "cursor-skills-home-",
          });
          const workspace = yield* fileSystem
            .makeTempDirectoryScoped({
              directory: NodeOS.tmpdir(),
              prefix: "cursor-skills-workspace-",
            })
            .pipe(Effect.flatMap((directory) => fileSystem.realPath(directory)));
          const library = yield* fileSystem.makeTempDirectoryScoped({
            directory: NodeOS.tmpdir(),
            prefix: "cursor-skills-library-",
          });
          const writeSkill = Effect.fn("writeCursorSkill")(function* (
            directory: string,
            contents: string,
          ) {
            yield* fileSystem.makeDirectory(directory, { recursive: true });
            yield* fileSystem.writeFileString(path.join(directory, "SKILL.md"), contents);
          });

          // A skill package managed in a config repo and installed by symlink.
          // Its own SKILL.md must be discovered under the link name, but nothing
          // below the target may be walked.
          yield* writeSkill(path.join(library, "shared-review"), "---\ndescription: shared\n---\n");
          yield* writeSkill(path.join(library, "shared-review", "hidden"), "---\n---\n");
          const root = path.join(workspace, ".cursor", "skills");
          yield* fileSystem.makeDirectory(root, { recursive: true });
          yield* fileSystem.symlink(path.join(library, "shared-review"), path.join(root, "review"));

          const skills = yield* probeCursorSkills(workspace, { HOME: userHome });
          expect(skills).toEqual([
            {
              name: "review",
              description: "shared",
              path: path.join(root, "review", "SKILL.md"),
              scope: "project",
              enabled: true,
            },
          ]);
          expect(
            (yield* probeCursorSkills(workspace, { HOME: userHome }).pipe(Effect.result))._tag,
          ).toBe("Success");
        }),
      ),
  );

  it("rewrites only discovered skill mentions into Cursor slash invocations", () => {
    expect(hasCursorSkillMention("use $Review_Pr:V2 here")).toBe(true);
    expect(hasCursorSkillMention("please $review this")).toBe(true);
    expect(
      rewriteCursorSkillMentions("use $review, keep $HOME and 5$review", new Set(["review"])),
    ).toBe("use $review, keep $HOME and 5$review");
    expect(rewriteCursorSkillMentions("please $review this", new Set(["review"]))).toBe(
      "please /review this",
    );
  });
  it("detects and invokes digit-leading Cursor skills without rewriting money", () => {
    const names = new Set(["2spec", "20k", "100M", "1e6"]);
    expect(hasCursorSkillMention("use $2spec here")).toBe(true);
    expect(hasCursorSkillMention("use $2spec here")).toBe(true);
    expect(rewriteCursorSkillMentions("use $2spec here", names)).toBe("use /2spec here");
    expect(rewriteCursorSkillMentions("use $2spec here", new Set())).toBe("use $2spec here");
    for (const text of [
      "pay $20 tomorrow",
      "budget $20k here",
      "cost $100M total",
      "limit $1e6 here",
    ]) {
      expect(hasCursorSkillMention(text)).toBe(false);
      expect(rewriteCursorSkillMentions(text, names)).toBe(text);
    }
  });
});

const writeMachineSkill = Effect.fn("writeMachineSkill")(function* (
  directory: string,
  frontmatter: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(directory, { recursive: true });
  const skillPath = path.join(directory, "SKILL.md");
  yield* fileSystem.writeFileString(skillPath, `---\n${frontmatter}\n---\n# Skill\n`);
  return yield* fileSystem.realPath(skillPath);
});

effectIt.layer(NodeServices.layer)("Cursor machine skill catalog", (it) => {
  it.effect("discovers global compatibility roots and provider-managed built-ins", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const userHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-cursor-skills-" });
      const cursorPath = yield* writeMachineSkill(
        path.join(userHome, ".cursor", "skills", "cursor-skill"),
        "description: Cursor skill.",
      );
      const codexPath = yield* writeMachineSkill(
        path.join(userHome, ".codex", "skills", "codex-skill"),
        "description: Codex compatibility skill.",
      );
      const builtinPath = yield* writeMachineSkill(
        path.join(userHome, ".cursor", "skills-cursor", "builtin-skill"),
        "name: Built-in skill\ndescription: Cursor built-in.\nmetadata:\n  surfaces: [cli]",
      );
      yield* writeMachineSkill(
        path.join(userHome, ".cursor", "skills-cursor", "ide-only"),
        "description: IDE-only.\nmetadata:\n  surfaces: [ide]",
      );

      assert.deepEqual(yield* probeCursorSkills(undefined, { HOME: userHome }), [
        {
          name: "builtin-skill",
          displayName: "Built-in skill",
          description: "Cursor built-in.",
          path: builtinPath,
          scope: "app",
          enabled: true,
        },
        {
          name: "codex-skill",
          description: "Codex compatibility skill.",
          path: codexPath,
          scope: "user",
          enabled: true,
        },
        {
          name: "cursor-skill",
          description: "Cursor skill.",
          path: cursorPath,
          scope: "user",
          enabled: true,
        },
      ]);
    }),
  );

  it.effect("keeps workspace and personal skills ahead of same-name built-ins", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cursor-skill-precedence-",
      });
      const userHome = path.join(temporaryDirectory, "home");
      const cwd = path.join(temporaryDirectory, "workspace");
      const projectPath = yield* writeMachineSkill(
        path.join(cwd, ".cursor", "skills", "review"),
        "description: Project review.",
      );
      yield* writeMachineSkill(
        path.join(userHome, ".cursor", "skills", "review"),
        "description: Personal review.",
      );
      yield* writeMachineSkill(
        path.join(userHome, ".cursor", "skills-cursor", "review"),
        "description: Built-in review.\nmetadata:\n  surfaces: [cli]",
      );

      assert.deepEqual(yield* probeCursorSkills(cwd, { HOME: userHome }), [
        {
          name: "review",
          description: "Project review.",
          path: projectPath,
          scope: "project",
          enabled: true,
        },
      ]);
    }),
  );

  it.effect("rejects a file read failure and keeps the last complete machine catalog", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const userHome = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cursor-read-failure-",
      });
      const skillPath = yield* writeMachineSkill(
        path.join(userHome, ".cursor", "skills", "review"),
        "description: Review skill.",
      );
      let failureReason: "PermissionDenied" | "NotFound" | undefined;
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        readFileString: (filePath, options) =>
          failureReason && filePath === skillPath
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: failureReason,
                  module: "FileSystem",
                  method: "readFileString",
                  pathOrDescriptor: filePath,
                }),
              )
            : fileSystem.readFileString(filePath, options),
      });
      const catalog = yield* makeCursorMachineSkillCatalog({ HOME: userHome });
      const read = catalog.pipe(Effect.provideService(FileSystem.FileSystem, failingFileSystem));
      const initial = yield* read;
      assert.equal(initial.length, 1);

      failureReason = "PermissionDenied";
      assert.deepEqual(yield* read, initial);
      const freshCatalog = yield* makeCursorMachineSkillCatalog({ HOME: userHome });
      const failed = yield* freshCatalog.pipe(
        Effect.provideService(FileSystem.FileSystem, failingFileSystem),
        Effect.result,
      );
      assert.equal(failed._tag, "Failure");

      failureReason = "NotFound";
      assert.deepEqual(yield* read, initial);
      failureReason = undefined;
      assert.deepEqual(
        yield* freshCatalog.pipe(Effect.provideService(FileSystem.FileSystem, failingFileSystem)),
        initial,
      );
    }),
  );
});
