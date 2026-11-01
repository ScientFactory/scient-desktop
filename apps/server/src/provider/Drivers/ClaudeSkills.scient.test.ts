import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { discoverClaudeSkills, mergeClaudeReportedSkills } from "./ClaudeSkills.ts";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { makeProviderRegistryMock } from "../testUtils/providerRegistryMock.ts";
import { makeProviderSkillManagement } from "../../scient/skills/ProviderSkillManagement.ts";

it.effect(
  "resolves nested synced Claude reports and plugin files to readable cards without escaping the skill root",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const home = path.join(root, "claude");
      const skillFolder = path.join(home, "skills", "synced", "bucket", "docs");
      yield* fs.makeDirectory(skillFolder, { recursive: true });
      yield* fs.writeFileString(
        path.join(skillFolder, "SKILL.md"),
        "---\nname: docs\ndescription: Write docs\n---\n# Documents",
      );
      const outside = path.join(root, "outside");
      yield* fs.makeDirectory(outside);
      yield* fs.writeFileString(path.join(outside, "SKILL.md"), "# Outside");
      yield* fs.symlink(outside, path.join(home, "skills", "escape"));
      yield* fs.symlink(path.join(home, "skills"), path.join(home, "skills", "cycle"));
      const plugin = path.join(home, "plugins", "cache", "shop", "writing", "1");
      yield* fs.makeDirectory(path.join(plugin, "skills", "review"), { recursive: true });
      yield* fs.writeFileString(
        path.join(plugin, "skills", "review", "SKILL.md"),
        "# Plugin review",
      );
      yield* fs.writeFileString(
        path.join(home, "plugins", "installed_plugins.json"),
        JSON.stringify({ plugins: { "writing@shop": [{ scope: "user", installPath: plugin }] } }),
      );
      yield* fs.writeFileString(
        path.join(home, "settings.json"),
        JSON.stringify({ enabledPlugins: { "writing@shop": true } }),
      );
      const discovered = yield* discoverClaudeSkills({ homePath: home }, undefined, {});
      assert.deepEqual(
        discovered.map((skill) => skill.name),
        ["docs", "writing:review"],
      );
      const skills = mergeClaudeReportedSkills(discovered, [
        { name: "docs" },
        { name: "writing:review" },
        { name: "simplify" },
      ]);
      const instanceId = ProviderInstanceId.make("claude");
      const management = makeProviderSkillManagement(
        makeProviderRegistryMock([
          {
            instanceId,
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
            installed: true,
            version: "1",
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "2026-10-27T00:00:00Z",
            models: [],
            slashCommands: [],
            skills,
          },
        ]),
      );
      for (const [name, text] of [
        ["docs", "# Documents"],
        ["writing:review", "# Plugin review"],
      ]) {
        const skill = skills.find((skill) => skill.name === name)!;
        assert.equal((yield* management.readDocument({ instanceId, ...skill })).instructions, text);
      }
      const bundled = skills.find((skill) => skill.name === "simplify")!;
      assert.deepEqual(yield* management.readDocument({ instanceId, ...bundled }), {
        instructions: "",
        unavailableReason: "Bundled with Claude Code; its full text isn't available.",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
);
