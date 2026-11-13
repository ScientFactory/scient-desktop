import {
  ScientReferenceCheckReport,
  ScientReferenceFix,
  ScientReferenceResolution,
} from "@scientfactory/scient-sources";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import { ScientOperation } from "../../ScientOperationTool.ts";
import { ScientSourcesToolError } from "../sources/tools.ts";

const dependencies = [AgentInvocationContext.AgentInvocationContext, WorkspaceBindingResolver];
const FindingIds = Schema.Array(Schema.String.check(Schema.isNonEmpty())).pipe(
  Schema.check(Schema.isMaxLength(500)),
);

const ScientReferencesCheckTool = Tool.make("scient_references_check", {
  description:
    "Check references at doi.org and PubMed: a project .md, .tex or .bib file (with the bibliographies it names), or the Library. Finds identifiers that do not resolve or name another work, retractions and corrections, preprints since published, details that differ from the registry, missing fields and cited/listed mismatches. Checks records, not whether a source supports the text. Apply fixes with scient_references_resolve. complete false: some were not checked.",
  parameters: Schema.Struct({
    path: Schema.optionalKey(
      Schema.String.pipe(Schema.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096))).annotate({
        description: "Project-relative; omit for the Library.",
      }),
    ),
  }),
  success: ScientReferenceCheckReport,
  failure: ScientSourcesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Check references")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true)
  .annotate(ScientOperation, {
    id: "references.check",
    scope: "workspace",
    requiredCapabilities: ["sources:read"],
  });

const ScientReferencesResolveTool = Tool.make("scient_references_resolve", {
  description:
    "Act on scient_references_check findings when the user asks: apply writes fix objects (unchanged) to the .bib file or Library source, refused as stale if it changed since the check; ignore hides findingIds from later checks; restore shows them again.",
  parameters: Schema.Struct({
    apply: Schema.optionalKey(
      Schema.Array(ScientReferenceFix).pipe(Schema.check(Schema.isMaxLength(200))),
    ),
    ignore: Schema.optionalKey(FindingIds),
    restore: Schema.optionalKey(FindingIds),
  }),
  success: ScientReferenceResolution,
  failure: ScientSourcesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Fix or ignore reference findings")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(ScientOperation, {
    id: "references.resolve",
    scope: "workspace",
    requiredCapabilities: ["sources:read", "sources:write"],
  });

export const ScientReferencesToolkit = Toolkit.make(
  ScientReferencesCheckTool,
  ScientReferencesResolveTool,
);
