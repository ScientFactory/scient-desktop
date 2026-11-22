import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { discoverAntigravitySkills } from "./AntigravitySkills.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.layer(NodeServices.layer)("discoverAntigravitySkills (Scient)", (it) => {
  it.effect("hides a global plugin's skills once `agy plugin disable` turns it off", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-agy-skills-" });
      const userHome = path.join(root, "home");
      const profileDirectory = path.join(root, "profile");
      const userConfig = path.join(userHome, ".gemini", "config");
      for (const name of ["science", "gmail"]) {
        const plugin = path.join(userConfig, "plugins", name);
        yield* fs.makeDirectory(path.join(plugin, "skills", "use"), { recursive: true });
        yield* fs.writeFileString(path.join(plugin, "plugin.json"), encodeJson({ name }));
        yield* fs.writeFileString(
          path.join(plugin, "skills", "use", "SKILL.md"),
          `---\nname: use\ndescription: Use ${name}.\n---\n`,
        );
      }
      // A paired runtime's stale projection of the same plugin does not bring it back.
      const projected = path.join(profileDirectory, "config", "plugins", "gmail");
      yield* fs.makeDirectory(path.join(projected, "skills", "use"), { recursive: true });
      yield* fs.writeFileString(path.join(projected, "plugin.json"), encodeJson({ name: "gmail" }));
      yield* fs.writeFileString(
        path.join(projected, "skills", "use", "SKILL.md"),
        "---\nname: use\ndescription: Use gmail.\n---\n",
      );
      const names = () =>
        discoverAntigravitySkills({ userHome, profileDirectory }).pipe(
          Effect.map((skills) => skills.map((skill) => skill.name)),
        );

      expect(yield* names()).toEqual(["gmail:use", "science:use"]);
      yield* fs.writeFileString(
        path.join(userConfig, "config.json"),
        encodeJson({ plugins: { gmail: { enabled: false }, science: { enabled: true } } }),
      );
      expect(yield* names()).toEqual(["science:use"]);
      // Switches that cannot be read leave plugins out rather than guessing they are on.
      yield* fs.writeFileString(
        path.join(userConfig, "config.json"),
        `{"pad":"${"x".repeat(1_000_000)}"}`,
      );
      expect(yield* names()).toEqual([]);
    }),
  );
});
