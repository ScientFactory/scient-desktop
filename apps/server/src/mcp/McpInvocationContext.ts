import {
  type EnvironmentId,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import type { SkillRelease } from "@scientfactory/scient-skills";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export type McpCapability =
  | "preview"
  | "documents:build"
  | "skills:read"
  | "sources:read"
  | "sources:write";

export interface McpScientSkillDescriptor {
  readonly releaseKey: string;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly origin: string;
  readonly activationScope: "project" | "user";
  readonly invocationPolicy: "automatic" | "explicit";
}

export interface McpScientSkillScope {
  /** Exact immutable snapshots authorized for this turn. */
  readonly releases: ReadonlyMap<string, SkillRelease>;
  readonly skills: ReadonlyArray<McpScientSkillDescriptor>;
}

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly skillScope?: McpScientSkillScope;
  readonly issuedAt: number;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

export const requireMcpCapability = Effect.fn("mcp.requireCapability")(function* (
  capability: "preview",
) {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has(capability)) {
    return yield* new PreviewAutomationUnavailableError({
      capability,
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
  }
  return invocation;
});
