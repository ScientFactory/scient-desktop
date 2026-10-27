import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { discoverScientAgentSkills } from "./ScientAgentSkills.ts";

it.effect("lists the native effective skills with scope and omits Scient-managed releases", () =>
  Effect.gen(function* () {
    const skills = yield* discoverScientAgentSkills((args) => {
      assert.deepEqual(args, ["skill", "list", "--json"]);
      return Effect.succeed(
        JSON.stringify({
          skills: [
            {
              name: "native",
              description: "Native skill",
              filePath: "/agent/skills/native/SKILL.md",
              source: "native:user",
              hide: true,
            },
            {
              name: "plugin",
              description: "Plugin skill",
              filePath: "/plugins/review/SKILL.md",
              source: "claude-plugins:user",
            },
            {
              name: "project",
              description: "Project skill",
              filePath: "/project/.scient-agent/skills/test/SKILL.md",
              source: "native:project",
            },
            {
              name: "managed",
              description: "Scient release",
              filePath: "scient://skills/release",
              source: "native:user",
            },
            {
              name: "project-managed",
              description: "Scient project",
              filePath: "/project/.scient/skills/test/SKILL.md",
              source: "native:project",
            },
          ],
        }),
      );
    });
    assert.deepEqual(
      skills.map((skill) => [skill.name, skill.scope]),
      [
        ["native", "user"],
        ["plugin", "user"],
        ["project", "project"],
      ],
    );
    assert.equal(skills[0]?.userInvocationOnly, true);
    assert.equal(skills[1]?.canSetEnabled, undefined);
  }),
);

it.effect("keeps a failed or unsupported native listing from breaking provider discovery", () =>
  Effect.gen(function* () {
    assert.deepEqual(
      yield* discoverScientAgentSkills(() => Effect.fail({ message: "Unsupported" })),
      [],
    );
    assert.deepEqual(
      yield* discoverScientAgentSkills(() => Effect.succeed('{"skills":[{"name":"bad"}]}')),
      [],
    );
  }),
);
