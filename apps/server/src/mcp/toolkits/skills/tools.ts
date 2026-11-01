import { isTrimmedUnadvertised } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { ScientOperation, type OperationMetadata } from "../../ScientOperationTool.ts";

import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";

const NonEmptyString = Schema.String.check(isTrimmedUnadvertised(), Schema.isMinLength(1));
// Optional fields retain the existing {} call while keeping MCP inputs objects.
export const ScientSkillListInput = Schema.Struct({
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type ScientSkillListInput = typeof ScientSkillListInput.Type;
const SkillName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
);
const Digest = Schema.String.pipe(Schema.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/u)));
const dependencies = [AgentInvocationContext.AgentInvocationContext];

export class ScientSkillToolError extends Schema.TaggedError<ScientSkillToolError>()(
  "ScientSkillToolError",
  {
    code: Schema.Literals([
      "ambiguous-name",
      "capability-unavailable",
      "not-found",
      "resource-unavailable",
    ]),
    message: NonEmptyString,
  },
) {}

const skillOperation = (id: string): OperationMetadata => ({
  id,
  family: "skills",
  scope: "skill-release",
  requiredCapabilities: ["skills:read"],
  approval: "session-grant",
  documentation: "docs/internals/scient-skills.md",
});

export const ScientSkillSummary = Schema.Struct({
  releaseKey: NonEmptyString,
  id: NonEmptyString,
  version: NonEmptyString,
  digest: Digest,
  origin: NonEmptyString,
  name: NonEmptyString,
  description: NonEmptyString,
  activationScope: Schema.Literals(["project", "user"]),
  supportedScopes: Schema.Array(Schema.Literals(["project", "user"])),
  invocationPolicy: Schema.Literals(["automatic", "explicit"]),
});

export const ScientSkillResource = Schema.Struct({
  path: NonEmptyString,
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  kind: Schema.Literals(["asset", "reference", "script", "other"]),
});

export const ScientSkillsListTool = Tool.make("scient_skills_list", {
  description:
    "List the Scient skills available this turn, or search their names and descriptions by keyword; a miss returns a browse page. Your provider's own skills are not included. Results are summaries: load a skill with scient_skill_load before you follow it. Unless scope.includesAllSkills is true, results are partial, and a pending or incomplete scope does not mean there are none. A full list you already saw stays current while scope.digest is unchanged. Page size 20 by default, up to 50; continue with nextOffset.",
  parameters: ScientSkillListInput,
  success: Schema.Struct({
    skills: Schema.Array(
      Schema.Struct({
        name: NonEmptyString,
        description: NonEmptyString,
        origin: NonEmptyString,
        invocationPolicy: Schema.Literals(["automatic", "explicit"]),
      }),
    ).pipe(Schema.check(Schema.isMaxLength(50))),
    total: Schema.Int,
    nextOffset: Schema.NullOr(Schema.Int),
    scope: Schema.Struct({
      status: Schema.Literals(["pending", "complete", "incomplete"]),
      digest: Schema.optional(Digest),
      includesAllSkills: Schema.Boolean,
    }),
    hint: Schema.optional(NonEmptyString),
  }),
  failure: ScientSkillToolError,
  dependencies,
})
  .annotate(Tool.Title, "List Scient skills")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, skillOperation("skills.list"));

export const ScientSkillLoadTool = Tool.make("scient_skill_load", {
  description:
    "Load a Scient skill's instructions by its exact name, from the user's selection or scient_skills_list. Returns the instructions and a list of the skill's files; read one with scient_skill_read_resource. Loading runs nothing and grants no tools or permissions.",
  parameters: Schema.Struct({ name: SkillName }),
  success: Schema.Struct({
    skill: ScientSkillSummary,
    instructions: Schema.String.pipe(Schema.check(Schema.isMaxLength(256 * 1024))),
    resources: Schema.Array(ScientSkillResource).pipe(Schema.check(Schema.isMaxLength(200))),
  }),
  failure: ScientSkillToolError,
  dependencies,
})
  .annotate(Tool.Title, "Load a Scient skill")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, skillOperation("skills.load"));

export const ScientSkillReadResourceTool = Tool.make("scient_skill_read_resource", {
  description:
    "Read one file of a Scient skill, by the skill's exact name and a path from scient_skill_load's file list.",
  parameters: Schema.Struct({ name: SkillName, path: NonEmptyString }),
  success: Schema.Struct({
    path: NonEmptyString,
    encoding: Schema.Literals(["base64", "utf8"]),
    content: Schema.String,
  }),
  failure: ScientSkillToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read a Scient skill resource")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, skillOperation("skills.resource.read"));

export const ScientSkillsToolkit = Toolkit.make(
  ScientSkillsListTool,
  ScientSkillLoadTool,
  ScientSkillReadResourceTool,
);
