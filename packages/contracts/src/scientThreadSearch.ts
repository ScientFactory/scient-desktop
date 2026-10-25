import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";
import { OrchestrationThreadSearchMatch as UpstreamThreadSearchMatch } from "./threadSearch.ts";

/**
 * Scient public and MCP search results retain threads without a project. Every
 * other field follows upstream's match, including the ranking fields it adds.
 */
export const OrchestrationThreadSearchMatch = Schema.Struct({
  ...UpstreamThreadSearchMatch.fields,
  projectId: Schema.NullOr(ProjectId),
});
export type OrchestrationThreadSearchMatch = typeof OrchestrationThreadSearchMatch.Type;

export const OrchestrationSearchThreadsResult = Schema.Struct({
  matches: Schema.Array(OrchestrationThreadSearchMatch),
});
export type OrchestrationSearchThreadsResult = typeof OrchestrationSearchThreadsResult.Type;
