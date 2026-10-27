import * as Schema from "effect/Schema";

import { ProjectId } from "../baseSchemas.ts";

/**
 * Reference to material held by Accounts or the Secrets vault. Connector-owned
 * refs are random; Accounts token refs name an opaque account id. Distinct from
 * the one-use request_secret `SecretRef`.
 */
export const VaultSecretRef = Schema.String.pipe(Schema.brand("VaultSecretRef"));
export type VaultSecretRef = typeof VaultSecretRef.Type;

/**
 * Where a secret or connector is available. Shared by Secrets and Extensions.
 * A session receives a grant when it is all-projects or lists the thread's project;
 * an empty `projectIds` list means no project.
 */
export const GrantScope = Schema.Union([
  Schema.Struct({ type: Schema.Literal("all-projects") }),
  Schema.Struct({ type: Schema.Literal("projects"), projectIds: Schema.Array(ProjectId) }),
]);
export type GrantScope = typeof GrantScope.Type;
