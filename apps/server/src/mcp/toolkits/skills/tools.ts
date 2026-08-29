import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

const NonEmptyString = Schema.Trimmed.check(Schema.isMinLength(1));
// Effect models an empty Struct as the broad `{}` TypeScript type, so its JSON
// Schema accepts both objects and arrays. MCP tool inputs must be objects; an
// invalid definition can make a client discard the server's entire tool list.
const EmptyToolInput = Schema.Record(Schema.String, Schema.Never);
const SkillName = Schema.Trimmed.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
);
const Digest = Schema.String.pipe(Schema.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/u)));
const dependencies = [McpInvocationContext.McpInvocationContext];

export class ScientSkillToolError extends Schema.TaggedErrorClass<ScientSkillToolError>()(
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
    "List exact Scient-managed skill releases selected for this session and whether each may be chosen automatically or only when explicitly named. Provider-native skills remain separate. Skills never grant tools, credentials, or permissions.",
  parameters: EmptyToolInput,
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

export const ScientSkillLoadTool = Tool.make("scient_skill_load", {
  description:
    "Load one selected Scient skill by the exact Agent Skills name shown in the private turn index or returned by scient_skills_list. Scient resolves that name only within this turn's exact release scope. Loading returns verified instructions and resource metadata; it does not execute anything or widen authority.",
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
  .annotate(Tool.OpenWorld, false);

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
  .annotate(Tool.OpenWorld, false);

export const ScientSkillsToolkit = Toolkit.make(
  ScientSkillsListTool,
  ScientSkillLoadTool,
  ScientSkillReadResourceTool,
);
