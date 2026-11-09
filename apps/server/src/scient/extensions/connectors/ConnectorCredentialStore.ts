/**
 * Connector credential port; Accounts implements it. Material must never
 * appear in logs, errors, or RPC results; see the Secrets contract in
 * docs/internals/scient-extensions.md.
 */
import { ExtensionsError, VaultSecretRef } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { McpInvocationScope } from "../../../mcp/McpInvocationContext.ts";

export type ConnectorSecretOwner =
  | { readonly type: "user" }
  | { readonly type: "connector"; readonly connectorId: string };

export type ConnectorSecretKind = "oauth-connection" | "bearer" | "header" | "basic";

export class SecretVersionConflict extends Schema.TaggedError<SecretVersionConflict>()(
  "SecretVersionConflict",
  {
    expectedVersion: Schema.Number,
    actualVersion: Schema.Number,
  },
) {}

export interface ConnectorCredentialUse {
  /** Server-derived caller identity; never request-supplied ids. */
  readonly scope: McpInvocationScope;
  /** `<serverName>/<tool>`. Never arguments, headers or bodies. */
  readonly target: string;
  readonly decision: "allowed" | "denied";
  readonly outcome?: "ok" | "error";
  readonly correlationId: string;
}

export interface ConnectorCredentialStoreShape {
  readonly put: (
    owner: ConnectorSecretOwner,
    kind: ConnectorSecretKind,
    material: Uint8Array,
    options: { readonly label: string },
  ) => Effect.Effect<VaultSecretRef, ExtensionsError>;
  readonly readOwned: (
    ref: VaultSecretRef,
    owner: ConnectorSecretOwner,
  ) => Effect.Effect<
    Option.Option<{ readonly material: Uint8Array; readonly version: number }>,
    ExtensionsError
  >;
  /** Compare-and-swap: succeeds only when the stored version is `expectedVersion`. */
  readonly replace: (
    ref: VaultSecretRef,
    material: Uint8Array,
    expectedVersion: number,
  ) => Effect.Effect<number, SecretVersionConflict | ExtensionsError>;
  readonly remove: (ref: VaultSecretRef) => Effect.Effect<void, ExtensionsError>;
  /** Non-blocking audit of a credential use. */
  readonly recordUse: (use: ConnectorCredentialUse) => Effect.Effect<void>;
}

export class ConnectorCredentialStore extends Context.Service<
  ConnectorCredentialStore,
  ConnectorCredentialStoreShape
>()("t3/scient/extensions/connectors/ConnectorCredentialStore") {}
