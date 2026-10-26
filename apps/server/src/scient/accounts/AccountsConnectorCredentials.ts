// @effect-diagnostics nodeBuiltinImport:off -- Opaque credential references use the operating system CSPRNG.
import * as NodeCrypto from "node:crypto";
import { ExtensionsError, VaultSecretRef } from "@t3tools/contracts";
import { Effect, Layer, Option, Redacted, Schema, Semaphore } from "effect";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import {
  ConnectorCredentialStore,
  SecretVersionConflict,
  type ConnectorSecretOwner,
} from "../extensions/connectors/ConnectorCredentialStore.ts";
import { AccountVault } from "./AccountVault.ts";

const Envelope = Schema.Struct({
  format: Schema.Literal(1),
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  kind: Schema.Literals(["oauth-connection", "bearer", "header", "basic"]),
  label: Schema.String,
  owner: Schema.Union([
    Schema.Struct({ type: Schema.Literal("user") }),
    Schema.Struct({ type: Schema.Literal("connector"), connectorId: Schema.String }),
  ]),
  material: Schema.String.check(
    Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  ),
});
type Envelope = typeof Envelope.Type;
const envelopeJson = Schema.fromJsonString(Envelope);
const encodeEnvelope = Schema.encodeEffect(envelopeJson);
const decodeEnvelope = Schema.decodeUnknownEffect(envelopeJson);
const refPattern = /^connector-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const unavailable = () =>
  new ExtensionsError({
    reason: "state-unavailable",
    message: "Connector credentials are unavailable.",
  });

export const layer = Layer.effect(
  ConnectorCredentialStore,
  Effect.gen(function* () {
    const store = yield* ServerSecretStore;
    const vault = yield* AccountVault;
    const writes = yield* Semaphore.make(1);
    const serialized = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      writes.withPermits(1)(Effect.uninterruptible(effect));
    const write = Effect.fn("AccountsConnectorCredentials.write")(function* (
      ref: VaultSecretRef,
      envelope: Envelope,
      create = false,
    ) {
      const encoded = yield* encodeEnvelope(envelope).pipe(Effect.mapError(unavailable));
      const bytes = yield* vault
        .encrypt(ref, Redacted.make(new TextEncoder().encode(encoded)))
        .pipe(Effect.mapError(unavailable));
      yield* (create ? store.create(ref, bytes) : store.set(ref, bytes)).pipe(
        Effect.mapError(unavailable),
      );
    });
    const read = Effect.fn("AccountsConnectorCredentials.read")(function* (ref: VaultSecretRef) {
      if (!refPattern.test(ref)) return Option.none<Envelope>();
      const stored = yield* store.get(ref).pipe(Effect.mapError(unavailable));
      if (Option.isNone(stored)) return Option.none<Envelope>();
      const legacy = stored.value[0] === 123;
      const bytes = legacy
        ? Redacted.make(stored.value)
        : yield* vault.decrypt(ref, stored.value).pipe(Effect.mapError(unavailable));
      const envelope = yield* decodeEnvelope(new TextDecoder().decode(Redacted.value(bytes))).pipe(
        Effect.mapError(unavailable),
      );
      if (legacy) yield* write(ref, envelope);
      return Option.some(envelope);
    });
    const ownerMatches = (stored: ConnectorSecretOwner, owner: ConnectorSecretOwner) =>
      stored.type === "connector" &&
      owner.type === "connector" &&
      stored.connectorId === owner.connectorId;
    return ConnectorCredentialStore.of({
      put: Effect.fn("AccountsConnectorCredentials.put")((owner, kind, material, options) =>
        serialized(
          Effect.gen(function* () {
            if (owner.type !== "connector")
              return yield* new ExtensionsError({
                reason: "unsupported",
                message: "User credentials cannot be bound to connectors yet.",
              });
            const ref = VaultSecretRef.make(`connector-${NodeCrypto.randomUUID()}`);
            yield* write(
              ref,
              {
                format: 1,
                version: 1,
                owner,
                kind,
                label: options.label,
                material: Buffer.from(material).toString("base64"),
              },
              true,
            );
            return ref;
          }),
        ),
      ),
      readOwned: Effect.fn("AccountsConnectorCredentials.readOwned")((ref, owner) =>
        serialized(
          Effect.gen(function* () {
            const stored = yield* read(ref);
            return Option.isNone(stored) || !ownerMatches(stored.value.owner, owner)
              ? Option.none()
              : Option.some({
                  material: Uint8Array.from(Buffer.from(stored.value.material, "base64")),
                  version: stored.value.version,
                });
          }),
        ),
      ),
      replace: Effect.fn("AccountsConnectorCredentials.replace")((ref, material, expectedVersion) =>
        serialized(
          Effect.gen(function* () {
            const stored = yield* read(ref);
            if (Option.isNone(stored))
              return yield* new ExtensionsError({
                reason: "not-found",
                message: "The connector credential no longer exists.",
              });
            if (stored.value.version !== expectedVersion)
              return yield* new SecretVersionConflict({
                expectedVersion,
                actualVersion: stored.value.version,
              });
            const version = expectedVersion + 1;
            yield* write(ref, {
              ...stored.value,
              version,
              material: Buffer.from(material).toString("base64"),
            });
            return version;
          }),
        ),
      ),
      remove: Effect.fn("AccountsConnectorCredentials.remove")((ref) =>
        refPattern.test(ref)
          ? serialized(store.remove(ref).pipe(Effect.mapError(unavailable)))
          : Effect.void,
      ),
      recordUse: Effect.fn("AccountsConnectorCredentials.recordUse")((use) =>
        Effect.logInfo("connector credential used", {
          target: use.target,
          decision: use.decision,
          outcome: use.outcome,
          correlationId: use.correlationId,
          threadId: use.scope.thread?.threadId,
          providerSessionId: use.scope.thread?.providerSessionId,
          providerInstanceId: use.scope.thread?.providerInstanceId,
        }),
      ),
    });
  }),
);
