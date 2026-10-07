import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId } from "./baseSchemas.ts";
import { OrchestrationThreadSearchSource } from "./threadSearch.ts";

/** Scient public and MCP search results retain threads without a project. */
export const OrchestrationThreadSearchMatch = Schema.Struct({
  threadId: ThreadId,
  projectId: Schema.NullOr(ProjectId),
  source: OrchestrationThreadSearchSource,
  snippet: Schema.String.check(Schema.isMaxLength(240)),
  messageCreatedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationThreadSearchMatch = typeof OrchestrationThreadSearchMatch.Type;

export const OrchestrationSearchThreadsResult = Schema.Struct({
  matches: Schema.Array(OrchestrationThreadSearchMatch),
});
export type OrchestrationSearchThreadsResult = typeof OrchestrationSearchThreadsResult.Type;
