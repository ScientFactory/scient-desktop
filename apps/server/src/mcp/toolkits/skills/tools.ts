import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import { ScientOperation, type OperationMetadata } from "../../ScientOperationTool.ts";

import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";

const NonEmptyString = Schema.Trimmed.check(Schema.isMinLength(1));
// Optional fields retain the existing {} call while keeping MCP inputs objects.
export const ScientSkillListInput = Schema.Struct({
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type ScientSkillListInput = typeof ScientSkillListInput.Type;
const SkillName = Schema.Trimmed.check(
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
    "Discover Scient-managed guidance in this turn's authorized scope; provider-native skills are separate. Omit query to browse, or search short keywords in names/descriptions. A keyword miss returns a labeled browse page; search never restricts loading. Results are summaries only: load applicable instructions with scient_skill_load before following them. Check the current-turn marker first; if absent, list before inferring availability. A complete empty scope needs no list call. The scope digest changes with visible releases, selections, or invocation policy; it is freshness metadata, not authority. Reuse visible full-catalog summaries only when complete, the digest matches, and they suffice; otherwise list for the task. Query and paged results are partial unless scope.includesAllSkills is true. Rediscover after context loss or uncertainty. Pending or incomplete scope is not evidence that no skills are available. Default page size 20, maximum 50; use nextOffset for more results.",
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
    "Read the instructions for an available Scient skill by its exact name, from the user's Scient selection or scient_skills_list. An explicit selection can be loaded directly without searching. Returns the complete instructions and a resource index; read supporting files with scient_skill_read_resource as needed. Resolves only within this turn's exact release scope; does not execute anything or grant tools or permissions.",
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
    "Read one verified resource from a selected Scient skill by its exact Agent Skills name. Relative traversal and files outside the turn-scoped immutable release are unavailable.",
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
