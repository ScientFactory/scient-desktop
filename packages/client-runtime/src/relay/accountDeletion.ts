// SCIENT-FORK:START account-deletion — whole file.
import {
  RelayApi,
  type RelayAppleSignInRevocationRequest,
  RelayProtectedError,
} from "@t3tools/contracts/relay";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import type { AtomRegistry } from "effect/reactivity";

import * as ManagedRelay from "./managedRelay.ts";
import { managedRelaySessionAtom } from "./managedRelayState.ts";

const isRelayProtectedError = Schema.is(RelayProtectedError);

export class ManagedRelayAccountDeletionError extends Schema.TaggedError<ManagedRelayAccountDeletionError>()(
  "ManagedRelayAccountDeletionError",
  {
    reason: Schema.Literals(["signed-out", "request-failed", "timed-out"]),
    traceId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "signed-out":
        return "Sign in to Scient Connect before deleting your account.";
      case "timed-out":
        return "Deleting your account took too long. Check your connection and try again.";
      case "request-failed":
        return "Could not delete your Scient account. Try again.";
    }
  }
}

/**
 * Deletes the signed-in account on the relay. The caller signs out locally afterwards.
 *
 * With `appleSignInRevocation` (a fresh Sign in with Apple authorization code), the relay first
 * revokes the account's Apple tokens. A failed revocation never blocks deletion; the result's
 * `appleSignInRevoked` is false then, so the caller can tell the person to remove it by hand.
 */
export const deleteManagedRelayAccount = Effect.fn(
  "clientRuntime.managedRelaySession.deleteAccount",
)(function* (
  registry: AtomRegistry.AtomRegistry,
  input: {
    readonly accountId: string;
    readonly appleSignInRevocation?: RelayAppleSignInRevocationRequest;
  },
) {
  const session = registry.get(managedRelaySessionAtom);
  if (!session || session.accountId !== input.accountId) {
    return yield* new ManagedRelayAccountDeletionError({ reason: "signed-out" });
  }
  const clerkToken = yield* session
    .readClerkToken()
    .pipe(
      Effect.mapError(
        (cause) => new ManagedRelayAccountDeletionError({ reason: "signed-out", cause }),
      ),
    );
  if (!clerkToken) {
    return yield* new ManagedRelayAccountDeletionError({ reason: "signed-out" });
  }
  const relay = yield* ManagedRelay.ManagedRelayClient;
  const client = yield* HttpApiClient.make(RelayApi, { baseUrl: relay.relayUrl });
  const appleSignInRevoked = input.appleSignInRevocation
    ? yield* client.account
        .revokeAppleSignIn({
          headers: { authorization: `Bearer ${clerkToken}` },
          payload: input.appleSignInRevocation,
        })
        .pipe(
          withRelayClientTracing,
          Effect.timeout(Duration.millis(ManagedRelay.MANAGED_RELAY_REQUEST_TIMEOUT_MS)),
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logWarning("Sign in with Apple revocation failed; deleting the account anyway", {
              error,
            }).pipe(Effect.as(false)),
          ),
        )
    : undefined;
  yield* client.account.deleteAccount({ headers: { authorization: `Bearer ${clerkToken}` } }).pipe(
    withRelayClientTracing,
    Effect.mapError(
      (cause) =>
        new ManagedRelayAccountDeletionError({
          reason: "request-failed",
          cause,
          ...(isRelayProtectedError(cause) ? { traceId: cause.traceId } : {}),
        }),
    ),
    Effect.timeoutOrElse({
      duration: Duration.millis(ManagedRelay.MANAGED_RELAY_REQUEST_TIMEOUT_MS),
      orElse: () => Effect.fail(new ManagedRelayAccountDeletionError({ reason: "timed-out" })),
    }),
  );
  return { appleSignInRevoked };
});
// SCIENT-FORK:END account-deletion
