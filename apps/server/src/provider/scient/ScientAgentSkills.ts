import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const SkillListing = Schema.fromJsonString(
  Schema.Struct({
    skills: Schema.Array(
      Schema.Struct({
        name: Schema.NonEmptyString,
        description: Schema.String,
        filePath: Schema.NonEmptyString,
        source: Schema.String,
        hide: Schema.optional(Schema.Boolean),
      }),
    ),
  }),
);

export const discoverScientAgentSkills = Effect.fn("discoverScientAgentSkills")(
  function* (
    run: (args: ReadonlyArray<string>) => Effect.Effect<string, { readonly message: string }>,
  ) {
    const listing = yield* run(["skill", "list", "--json"]).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(SkillListing)),
    );
    return listing.skills
      .filter(
        (skill) =>
          !skill.filePath.startsWith("scient://skills/") &&
          !skill.filePath.replaceAll("\\", "/").includes("/.scient/skills/"),
      )
      .map((skill): ServerProviderSkill => ({
        name: skill.name,
        description: skill.description,
        path: skill.filePath,
        scope: skill.source.endsWith(":project") ? "project" : "user",
        enabled: true,
        enabledReadOnlyReason: "Managed by Scient Agent",
        ...(skill.hide ? { userInvocationOnly: true } : {}),
      }));
  },
  Effect.catch((cause) =>
    Effect.logWarning("Scient Agent skill discovery failed.", { cause }).pipe(
      Effect.as([] as ReadonlyArray<ServerProviderSkill>),
    ),
  ),
);
