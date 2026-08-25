import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverAntigravitySkills } from "./AntigravitySkills.ts";

const writeSkill = Effect.fn(function* (
  skillsDirectory: string,
  directoryName: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDirectory = path.join(skillsDirectory, directoryName);
  yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
  yield* fileSystem.writeFileString(path.join(skillDirectory, "SKILL.md"), contents);
});

it.layer(NodeServices.layer)("discoverAntigravitySkills", (it) => {
  it.effect("reports bundled and personal skills with provider precedence", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "scient-antigravity-skills-",
      });
      const bundledSkills = path.join(
        homeDirectory,
        ".gemini",
        "antigravity-cli",
        "builtin",
        "skills",
      );
      const personalSkills = path.join(homeDirectory, ".gemini", "config", "skills");

      yield* writeSkill(
        bundledSkills,
        "guide",
        ["---", "name: guide", "description: Bundled guide.", "---", "", "# Guide"].join("\n"),
      );
      yield* writeSkill(
        bundledSkills,
        "compose",
        ["---", "name: compose", "description: Bundled composer.", "---"].join("\n"),
      );
      yield* writeSkill(
        personalSkills,
        "guide",
        ["---", "name: guide", "description: Personal guide.", "---", "", "# Guide"].join("\n"),
      );
      yield* writeSkill(
        personalSkills,
        "review",
        ["---", "name: review", "description: Review the workspace.", "---"].join("\n"),
      );

      const skills = yield* discoverAntigravitySkills({ HOME: homeDirectory });

      assert.deepEqual(skills, [
        {
          name: "compose",
          description: "Bundled composer.",
          path: path.join(bundledSkills, "compose", "SKILL.md"),
          scope: "app",
          enabled: true,
        },
        {
          name: "guide",
          description: "Personal guide.",
          path: path.join(personalSkills, "guide", "SKILL.md"),
          scope: "user",
          enabled: true,
        },
        {
          name: "review",
          description: "Review the workspace.",
          path: path.join(personalSkills, "review", "SKILL.md"),
          scope: "user",
          enabled: true,
        },
      ]);
    }),
  );

  it.effect("skips entries Antigravity cannot load", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "scient-antigravity-skills-",
      });
      const bundledSkills = path.join(
        homeDirectory,
        ".gemini",
        "antigravity-cli",
        "builtin",
        "skills",
      );

      yield* writeSkill(bundledSkills, "missing-frontmatter", "# Missing frontmatter");
      yield* writeSkill(bundledSkills, "broken", "---\nname: [broken\n---\n");

      assert.deepEqual(yield* discoverAntigravitySkills({ HOME: homeDirectory }), []);
    }),
  );
});
