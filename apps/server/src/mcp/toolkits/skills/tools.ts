import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ScientSkillRegistry from "../../../scient/skills/ScientSkillRegistry.ts";

const NonEmptyString = Schema.Trimmed.check(Schema.isMinLength(1));
const Digest = Schema.String.pipe(Schema.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/u)));
const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ScientSkillRegistry.ScientSkillRegistry,
];

export class ScientSkillToolError extends Schema.TaggedErrorClass<ScientSkillToolError>()(
  "ScientSkillToolError",
  {
    code: Schema.Literals(["capability-unavailable", "not-found", "resource-unavailable"]),
    message: NonEmptyString,
  },
) {}

export const ScientSkillSummary = Schema.Struct({
  releaseKey: NonEmptyString,
  id: NonEmptyString,
  version: NonEmptyString,
  digest: Digest,
  origin: NonEmptyString,
  name: NonEmptyString,
  description: NonEmptyString,
  activationScope: Schema.Literals(["project", "user"]),
  role: Schema.Literals(["constructive", "orientation", "review"]),
});

export const ScientSkillResource = Schema.Struct({
  path: NonEmptyString,
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  kind: Schema.Literals(["asset", "reference", "script", "other"]),
});

export const ScientSkillsListTool = Tool.make("scient_skills_list", {
  description:
    "List exact Scient-managed skill releases selected for this session. Provider-native skills remain separate. Skills provide instructions and resources but never grant tools, credentials, or permissions.",
  parameters: Schema.Struct({}),
  success: Schema.Struct({
    skills: Schema.Array(ScientSkillSummary).pipe(Schema.check(Schema.isMaxLength(500))),
  }),
  failure: ScientSkillToolError,
  dependencies,
})
  .annotate(Tool.Title, "List Scient skills")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ScientSkillActivateTool = Tool.make("scient_skill_activate", {
  description:
    "Load one selected Scient skill by the exact releaseKey returned by scient_skills_list. Activation returns verified instructions and resource metadata; it does not execute anything or widen authority.",
  parameters: Schema.Struct({ releaseKey: NonEmptyString }),
  success: Schema.Struct({
    skill: ScientSkillSummary,
    instructions: Schema.String.pipe(Schema.check(Schema.isMaxLength(256 * 1024))),
    resources: Schema.Array(ScientSkillResource).pipe(Schema.check(Schema.isMaxLength(200))),
  }),
  failure: ScientSkillToolError,
  dependencies,
})
  .annotate(Tool.Title, "Activate a Scient skill")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ScientSkillReadResourceTool = Tool.make("scient_skill_read_resource", {
  description:
    "Read one verified resource from an activated Scient skill. Relative traversal and files outside the immutable release are unavailable.",
  parameters: Schema.Struct({ releaseKey: NonEmptyString, path: NonEmptyString }),
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
  .annotate(Tool.OpenWorld, false);

export const ScientSkillsToolkit = Toolkit.make(
  ScientSkillsListTool,
  ScientSkillActivateTool,
  ScientSkillReadResourceTool,
);
