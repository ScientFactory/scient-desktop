import type * as Schema from "effect/Schema";

/** Caller identity is host-issued; it is not a credential or a tool argument. */
export type AgentCaller<ExternalProviderId extends string = string> =
  | {
      readonly providerSessionId: string;
      readonly providerInstanceId: ExternalProviderId;
      readonly nativeSessionId?: never;
    }
  | {
      readonly nativeSessionId: string;
      readonly providerSessionId?: never;
      readonly providerInstanceId?: never;
    };

/** Existing session grants. Finer settings policy is a separate migration. */
export type OperationCapability =
  | "preview"
  | "documents:build"
  | "skills:read"
  | "sources:read"
  | "sources:write";

/** Behavior and ownership, independent of MCP names or provider runtimes. */
export interface OperationDefinition {
  readonly id: string;
  readonly version: number;
  readonly family: string;
  readonly title: string;
  readonly description: string;
  readonly input: Schema.Top;
  readonly output: Schema.Top;
  readonly failure: Schema.Top;
  readonly scope: "thread" | "workspace" | "skill-release";
  readonly requiredCapabilities: ReadonlyArray<OperationCapability>;
  readonly effects: {
    readonly readOnly: boolean;
    readonly destructive: boolean;
    readonly idempotent: boolean;
    readonly openWorld: boolean;
  };
  /** Descriptive only; never evidence of a host-confirmed approval. */
  readonly approval: "session-grant" | "explicit-user-request-guidance";
  readonly documentation: string;
}

export function hasOperationCapabilities(
  operation: OperationDefinition,
  capabilities: ReadonlySet<OperationCapability>,
): boolean {
  return operation.requiredCapabilities.every((capability) => capabilities.has(capability));
}

/** Static composition fails at startup for ambiguous operation identities. */
export function makeOperationRegistry(definitions: ReadonlyArray<OperationDefinition>) {
  const operations = new Map<string, OperationDefinition>();
  for (const definition of definitions) {
    if (!definition.id || !Number.isSafeInteger(definition.version) || definition.version < 1) {
      throw new Error("Scient operation definitions require an ID and positive integer version.");
    }
    if (operations.has(definition.id)) {
      throw new Error(`Duplicate Scient operation: ${definition.id}`);
    }
    operations.set(definition.id, definition);
  }
  return {
    get: (id: string): OperationDefinition | undefined => operations.get(id),
    list: (): ReadonlyArray<OperationDefinition> => [...operations.values()],
  };
}
