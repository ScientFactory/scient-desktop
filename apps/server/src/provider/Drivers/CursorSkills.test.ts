import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverCursorSkills } from "./CursorSkills.ts";

const writeSkill = Effect.fn("writeCursorSkill")(function* (
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

it.layer(NodeServices.layer)("discoverCursorSkills", (it) => {
  it.effect("discovers global compatibility roots and provider-managed built-ins", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const userHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-cursor-skills-" });
      const cursorPath = yield* writeSkill(
        path.join(userHome, ".cursor", "skills", "cursor-skill"),
        "description: Cursor skill.",
      );
      const codexPath = yield* writeSkill(
        path.join(userHome, ".codex", "skills", "codex-skill"),
        "description: Codex compatibility skill.",
      );
      const builtinPath = yield* writeSkill(
        path.join(userHome, ".cursor", "skills-cursor", "builtin-skill"),
        "name: Built-in skill\ndescription: Cursor built-in.\nmetadata:\n  surfaces: [cli]",
      );
      yield* writeSkill(
        path.join(userHome, ".cursor", "skills-cursor", "ide-only"),
        "description: IDE-only.\nmetadata:\n  surfaces: [ide]",
      );

      assert.deepEqual(yield* discoverCursorSkills(undefined, { HOME: userHome }), [
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
      const projectPath = yield* writeSkill(
        path.join(cwd, ".cursor", "skills", "review"),
        "description: Project review.",
      );
      yield* writeSkill(
        path.join(userHome, ".cursor", "skills", "review"),
        "description: Personal review.",
      );
      yield* writeSkill(
        path.join(userHome, ".cursor", "skills-cursor", "review"),
        "description: Built-in review.\nmetadata:\n  surfaces: [cli]",
      );

      assert.deepEqual(yield* discoverCursorSkills(cwd, { HOME: userHome }), [
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
});
