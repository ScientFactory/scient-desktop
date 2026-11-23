import {
  hasOperationCapabilities,
  type OperationCapability,
  type OperationDefinition,
} from "@scientfactory/operations";
import { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import type { ProjectService } from "../../../project/ProjectService.ts";
import { verifiedFor } from "../../../scient/operations/AgentWorkspaceScope.ts";
import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import type { ScientSourcesProject } from "../../../scient/sources/SourcesBackend.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";
import { scientCapabilitiesForMcp } from "../../ScientMcpInvocation.ts";
import { ScientSourcesLibraryToolkit, ScientSourcesToolError } from "./tools.ts";

/**
 * What a client connected through Copy MCP URL may use: the Sources tools. Annotations,
 * references and systematic reviews mix project files with Library records and stay out.
 */
const OUTSIDE_TOOLS: ReadonlySet<string> = new Set(Object.keys(ScientSourcesLibraryToolkit.tools));

/** An outside client's call: its approved grants and the project it named, if any. */
export interface ScientSourcesOutsideCall {
  readonly capabilities: ReadonlySet<OperationCapability>;
  readonly project: ScientSourcesProject | null;
}

/** Unset for thread callers, which keep their verified thread checkout. */
export const ScientSourcesOutsideCall = Context.Reference<ScientSourcesOutsideCall | null>(
  "scient/mcp/sources/ScientSourcesOutsideCall",
  { defaultValue: () => null },
);

/**
 * The one rule listing and calling share. Undefined unless a client signed in from outside, with
 * no thread and no peer link, calls a Sources tool; then its grants, or why its mode refuses it.
 */
export function outsideCall(
  scope: McpInvocationScope,
  toolName: string,
  operation: OperationDefinition,
):
  | { readonly grants: ReadonlySet<OperationCapability> }
  | { readonly refused: string }
  | undefined {
  if (scope.thread !== undefined || scope.client === undefined || scope.client.linked === true) {
    return undefined;
  }
  if (!OUTSIDE_TOOLS.has(toolName)) return undefined;
  const grants = scientCapabilitiesForMcp(scope.capabilities);
  return hasOperationCapabilities(operation, grants)
    ? { grants }
    : {
        refused:
          "This tool changes the Library, and this MCP client was approved for read-only access.",
      };
}

const PROJECT_INPUT = "projectId";
const projectInputSchema = {
  type: "string",
  description:
    "The project to act on, from scient_project_list. Required except for whole-Library calls: scient_sources_list with scope library, recentChanges or libraryCopies, and scient_sources_organize's whole-Library actions (back up, restore, put back, cancel a restore, add from another Library and undo that).",
};

/** The outside variant of a listed tool: the same schema with `projectId`, which calls take out. */
export function withProjectInput<T>(tool: T): T {
  if (!Predicate.isObject(tool) || !Predicate.isObject(tool.inputSchema)) return tool;
  const properties = Predicate.isObject(tool.inputSchema.properties)
    ? tool.inputSchema.properties
    : {};
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: { ...properties, [PROJECT_INPUT]: projectInputSchema },
    },
  };
}

const failure = (code: "project-required" | "project-changed", message: string) =>
  new ScientSourcesToolError({ code, message });

const decodeProjectId = Schema.decodeUnknownOption(ProjectId);

/** The registered project's verified checkout on this server, never a path the client sent. */
const resolveOutsideProject = Effect.fn("ScientSourcesOutside.resolveProject")(function* (
  scope: McpInvocationScope,
  projects: ProjectService["Service"],
  requested: unknown,
  readOnly: boolean,
) {
  const projectId = decodeProjectId(requested);
  const project = Option.isNone(projectId)
    ? Option.none()
    : yield* projects.getById(projectId.value).pipe(Effect.orElseSucceed(() => Option.none()));
  if (Option.isNone(project)) {
    return yield* failure(
      "project-required",
      "No project has this projectId. scient_project_list lists them.",
    );
  }
  const resolver = yield* WorkspaceBindingResolver;
  const resolved = yield* resolver
    .resolveWorkspaceRoot(project.value.workspaceRoot, readOnly ? { readOnly: true } : undefined)
    .pipe(Effect.option);
  if (
    Option.isNone(resolved) ||
    resolved.value.binding.hostProjectId !== project.value.id ||
    !verifiedFor(resolved.value.binding, scope.environmentId)
  ) {
    return yield* failure("project-changed", "Scient could not verify this project's folder.");
  }
  return {
    projectId: resolved.value.binding.hostProjectId,
    root: resolved.value.binding.canonicalRoot,
  } satisfies ScientSourcesProject;
});

/** Runs an outside client's call: `projectId` is taken out, the rest decodes as the tool's own. */
export const callAsOutsideClient = Effect.fn("ScientSourcesOutside.call")(function* <A, E, R>(
  input: {
    readonly scope: McpInvocationScope;
    readonly grants: ReadonlySet<OperationCapability>;
    readonly projects: ProjectService["Service"];
    readonly payload: unknown;
  },
  handle: (payload: unknown) => Effect.Effect<A, E, R>,
) {
  const { [PROJECT_INPUT]: requested, ...rest } = Predicate.isObject(input.payload)
    ? input.payload
    : {};
  const readOnly = !input.grants.has("sources:write");
  const project =
    requested === undefined
      ? null
      : yield* resolveOutsideProject(input.scope, input.projects, requested, readOnly);
  return yield* handle(Predicate.isObject(input.payload) ? rest : input.payload).pipe(
    Effect.provideService(ScientSourcesOutsideCall, {
      capabilities: input.grants,
      project,
    }),
  );
});
