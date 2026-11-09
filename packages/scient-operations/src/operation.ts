/** Existing session grants. Finer settings policy is a separate migration. */
export type OperationCapability =
  // SCIENT-FORK:START — Scient Accounts: declare the account operation grant.
  | "accounts"
  // SCIENT-FORK:END
  | "preview"
  | "documents:build"
  | "compute"
  | "skills:read"
  /** Save and read the user's own (personal) skills. */
  | "skills:write"
  | "sources:read"
  | "sources:write"
  /** Read-only access to threads in the calling thread's project. */
  | "threads:read";

/** Admission for one Scient tool: what the session must hold and what it acts on. */
export interface OperationDefinition {
  readonly id: string;
  readonly scope: "thread" | "workspace" | "skill-release";
  readonly requiredCapabilities: ReadonlyArray<OperationCapability>;
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
    if (!definition.id) throw new Error("Scient operation definitions require an ID.");
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
