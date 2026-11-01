/**
 * Keep credential envelopes under connector-<uuid>.bin for vault migration. Material must never
 * appear in logs, errors, or RPC results; see the Secrets contract in
 * docs/internals/scient-extensions.md.
 */
import { ExtensionsError, VaultSecretRef } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
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

const REF_PATTERN = /^connector-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const Envelope = Schema.Struct({
  format: Schema.Literal(1),
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  kind: Schema.Literals(["oauth-connection", "bearer", "header", "basic"]),
  label: Schema.String,
  owner: Schema.Union([
    Schema.Struct({ type: Schema.Literal("user") }),
    Schema.Struct({ type: Schema.Literal("connector"), connectorId: Schema.String }),
  ]),
  /** Base64 material. */
  material: Schema.String,
});
type Envelope = typeof Envelope.Type;
const EnvelopeJson = Schema.fromJsonString(Envelope);
const decodeEnvelope = Schema.decodeUnknownExit(EnvelopeJson);
const encodeEnvelope = Schema.encodeSync(EnvelopeJson);

const unavailable = (message: string) =>
  new ExtensionsError({ reason: "state-unavailable", message });

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const writes = yield* Semaphore.make(1);

  const readEnvelope = Effect.fn("ConnectorCredentialStore.readEnvelope")(function* (
    ref: VaultSecretRef,
  ) {
    if (!REF_PATTERN.test(ref)) return Option.none<Envelope>();
    const bytes = yield* secrets
      .get(ref)
      .pipe(Effect.mapError(() => unavailable("Connector credentials could not be read.")));
    if (Option.isNone(bytes)) return Option.none<Envelope>();
    const decoded = decodeEnvelope(new TextDecoder().decode(bytes.value));
    if (Exit.isFailure(decoded)) {
      return yield* unavailable("A stored connector credential is unreadable.");
    }
    return Option.some(decoded.value);
  });

  const writeEnvelope = (ref: VaultSecretRef, envelope: Envelope, create: boolean) => {
    const bytes = new TextEncoder().encode(encodeEnvelope(envelope));
    return (create ? secrets.create(ref, bytes) : secrets.set(ref, bytes)).pipe(
      Effect.mapError(() => unavailable("Connector credentials could not be saved.")),
    );
  };

  const ownerMatches = (stored: Envelope["owner"], owner: ConnectorSecretOwner) =>
    stored.type === "connector" &&
    owner.type === "connector" &&
    stored.connectorId === owner.connectorId;

  return ConnectorCredentialStore.of({
    put: Effect.fn("ConnectorCredentialStore.put")(function* (owner, kind, material, options) {
      if (owner.type !== "connector") {
        return yield* new ExtensionsError({
          reason: "unsupported",
          message: "User secrets require the Secrets vault, which is not available yet.",
        });
      }
      const uuid = yield* crypto
        .randomUUIDv4()
        .pipe(Effect.mapError(() => unavailable("Connector credentials could not be saved.")));
      const ref = VaultSecretRef.make(`connector-${uuid}`);
      yield* writeEnvelope(
        ref,
        {
          format: 1,
          version: 1,
          kind,
          label: options.label,
          owner,
          material: Buffer.from(material).toString("base64"),
        },
        true,
      );
      return ref;
    }),
    readOwned: Effect.fn("ConnectorCredentialStore.readOwned")(function* (ref, owner) {
      const envelope = yield* readEnvelope(ref);
      if (Option.isNone(envelope) || !ownerMatches(envelope.value.owner, owner)) {
        return Option.none();
      }
      return Option.some({
        material: Uint8Array.from(Buffer.from(envelope.value.material, "base64")),
        version: envelope.value.version,
      });
    }),
    replace: Effect.fn("ConnectorCredentialStore.replace")(
      function (ref, material, expectedVersion) {
        return writes.withPermits(1)(
          Effect.gen(function* () {
            const envelope = yield* readEnvelope(ref);
            if (Option.isNone(envelope)) {
              return yield* new ExtensionsError({
                reason: "not-found",
                message: "The connector credential no longer exists.",
              });
            }
            if (envelope.value.version !== expectedVersion) {
              return yield* new SecretVersionConflict({
                expectedVersion,
                actualVersion: envelope.value.version,
              });
            }
            const version = envelope.value.version + 1;
            yield* writeEnvelope(
              ref,
              { ...envelope.value, version, material: Buffer.from(material).toString("base64") },
              false,
            );
            return version;
          }),
        );
      },
    ),
    // Serialized with `replace`, so a replace that read the entry before the
    // removal cannot write it back afterwards.
    remove: Effect.fn("ConnectorCredentialStore.remove")(function (ref) {
      return REF_PATTERN.test(ref)
        ? writes.withPermits(1)(
            secrets
              .remove(ref)
              .pipe(
                Effect.mapError(() => unavailable("A connector credential could not be removed.")),
              ),
          )
        : Effect.void;
    }),
    recordUse: Effect.fn("ConnectorCredentialStore.recordUse")(function (use) {
      return Effect.logInfo("connector credential used", {
        target: use.target,
        decision: use.decision,
        outcome: use.outcome,
        correlationId: use.correlationId,
        threadId: use.scope.thread?.threadId,
        providerSessionId: use.scope.thread?.providerSessionId,
        providerInstanceId: use.scope.thread?.providerInstanceId,
      });
    }),
  });
});

export const layer = Layer.effect(ConnectorCredentialStore, make);
