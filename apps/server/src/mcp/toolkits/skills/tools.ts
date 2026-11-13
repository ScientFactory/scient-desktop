import { isTrimmedUnadvertised } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { ScientOperation, type OperationDefinition } from "../../ScientOperationTool.ts";

import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";

const NonEmptyString = Schema.String.check(isTrimmedUnadvertised(), Schema.isMinLength(1));
/** Skills per page: `limit` defaults to the first and is capped at the second. */
export const SKILL_PAGE_SIZE = { default: 20, max: 50 } as const;
// Optional fields retain the existing {} call while keeping MCP inputs objects. A larger
// `limit` is capped rather than refused: agents ask for 100 to see every skill at once.
export const ScientSkillListInput = Schema.Struct({
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
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
      "invalid-skill",
    ]),
    message: NonEmptyString,
  },
) {}

const skillOperation = (id: string): OperationDefinition => ({
  id,
  scope: "skill-release",
  requiredCapabilities: ["skills:read"],
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
  description: `List the Scient skills available this turn, or search their names and descriptions by keyword; a miss returns a browse page. Your provider's own skills are not included. Results are summaries: load a skill with scient_skill_load before you follow it. Unless scope.includesAllSkills is true, results are partial, and a pending or incomplete scope does not mean there are none. A page holds up to ${SKILL_PAGE_SIZE.max} skills, ${SKILL_PAGE_SIZE.default} by default; continue with nextOffset.`,
  parameters: ScientSkillListInput,
  success: Schema.Struct({
    skills: Schema.Array(
      Schema.Struct({
        name: NonEmptyString,
        description: NonEmptyString,
        origin: NonEmptyString,
        invocationPolicy: Schema.Literals(["automatic", "explicit"]),
      }),
    ).pipe(Schema.check(Schema.isMaxLength(SKILL_PAGE_SIZE.max))),
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

/** The user's own skills are not tied to this turn's skill scope. */
const personalSkillOperation = (id: string): OperationDefinition => ({
  id,
  scope: "thread",
  requiredCapabilities: ["skills:write"],
});

const SkillFile = Schema.Struct({
  path: NonEmptyString.check(Schema.isMaxLength(512)),
  content: Schema.String.check(Schema.isMaxLength(1024 * 1024)),
});

const ScientSkillSaveTool = Tool.make("scient_skill_save", {
  description:
    "Save a skill for the user, available in every project and to every agent from their next message. Send SKILL.md (frontmatter `name` equal to `name`, and a `description` of what it does and when to use it) plus any text files it needs. A new skill is on at once; saving over one of the user's skills keeps the earlier version, and the user can undo from the skill's row in Settings. Scient checks it and says what to fix. For a skill that belongs to one project, write `.scient/skills/<name>/SKILL.md` instead.",
  parameters: Schema.Struct({
    name: SkillName,
    files: Schema.Array(SkillFile).pipe(
      Schema.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    ),
  }),
  success: Schema.Struct({
    name: NonEmptyString,
    status: Schema.Literals(["created", "updated"]),
    active: Schema.Boolean,
    message: NonEmptyString,
  }),
  failure: ScientSkillToolError,
  dependencies,
})
  .annotate(Tool.Title, "Save a skill for the user")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, personalSkillOperation("skills.personal.save"));

const ScientSkillReadTool = Tool.make("scient_skill_read", {
  description:
    "Read every file of one of the user's own skills (one they added, or one saved for them), to improve it and save it back with scient_skill_save.",
  parameters: Schema.Struct({ name: SkillName }),
  success: Schema.Struct({
    name: NonEmptyString,
    files: Schema.Array(
      Schema.Struct({
        path: NonEmptyString,
        encoding: Schema.Literals(["base64", "utf8"]),
        content: Schema.String,
      }),
    ),
  }),
  failure: ScientSkillToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read one of the user's skills")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, personalSkillOperation("skills.personal.read"));

export const ScientSkillsToolkit = Toolkit.make(
  ScientSkillsListTool,
  ScientSkillLoadTool,
  ScientSkillReadResourceTool,
  ScientSkillSaveTool,
  ScientSkillReadTool,
);
