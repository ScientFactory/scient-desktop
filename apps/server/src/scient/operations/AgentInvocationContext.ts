import type { AgentCaller, OperationCapability } from "@scientfactory/operations";
import type { SkillRelease } from "@scientfactory/scient-skills";
import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";

export type { OperationCapability } from "@scientfactory/operations";

import type { ResolvedThreadWorkspaceBinding } from "../projectScope/WorkspaceBinding.ts";

export interface AgentSkillDescriptor {
  readonly releaseKey: string;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly origin: string;
  readonly activationScope: "project" | "user";
  readonly invocationPolicy: "automatic" | "explicit";
}

export type AgentSkillCatalogStatus = "pending" | "complete" | "incomplete";

export interface AgentSkillScope {
  readonly releases: ReadonlyMap<string, SkillRelease>;
  readonly skills: ReadonlyArray<AgentSkillDescriptor>;
  /** Discovery freshness only; exact releases and skills above remain the authority. */
  readonly catalog?: {
    readonly status: AgentSkillCatalogStatus;
    readonly digest?: string;
  };
}

/** Host-authenticated admission context, never decoded from a tool argument. */
interface AgentInvocationBase {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly capabilities: ReadonlySet<OperationCapability>;
  readonly skillScope?: AgentSkillScope;
  readonly issuedAt: number;
  /** Captured once for a workspace operation, reused at publication checks. */
  readonly workspace?: ResolvedThreadWorkspaceBinding;
}

export type AgentInvocationScope = AgentInvocationBase & AgentCaller<ProviderInstanceId>;

export class AgentInvocationContext extends Context.Service<
  AgentInvocationContext,
  AgentInvocationScope
>()("t3/scient/operations/AgentInvocationContext") {}
