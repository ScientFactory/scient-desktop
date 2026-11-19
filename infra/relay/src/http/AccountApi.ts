// SCIENT-FORK:START account-deletion — whole file.
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { RelayApi, RelayClientPrincipal, RelayInternalError } from "@t3tools/contracts/relay";

import * as AccountDeletion from "../account/AccountDeletion.ts";
import * as AppleSignInRevocation from "../account/AppleSignInRevocation.ts";
import * as ClerkUsers from "../account/ClerkUsers.ts";

const internalReason = (
  stage: AccountDeletion.AccountDeletionFailed["stage"],
): RelayInternalError["reason"] =>
  stage === "list-environments" || stage === "delete-records"
    ? "persistence_failed"
    : "upstream_unavailable";

const failWithTrace = (reason: RelayInternalError["reason"]) =>
  Effect.currentParentSpan.pipe(
    Effect.map((span) => span.traceId),
    Effect.orElseSucceed(() => "unavailable"),
    Effect.flatMap((traceId) =>
      Effect.fail(new RelayInternalError({ code: "internal_error", reason, traceId })),
    ),
  );

export const layerAccountApi = HttpApiBuilder.group(
  RelayApi,
  "account",
  Effect.fnUntraced(function* (handlers) {
    const deletion = yield* AccountDeletion.AccountDeletion;
    const appleSignIn = yield* AppleSignInRevocation.AppleSignInRevocation;
    const clerkUsers = yield* ClerkUsers.ClerkUsers;
    return handlers
      .handle(
        "revokeAppleSignIn",
        Effect.fn("relay.api.account.revokeAppleSignIn")(function* ({ payload }) {
          const { userId, token } = yield* RelayClientPrincipal;
          yield* clerkUsers.appleSubjects({ userId, token }).pipe(
            Effect.flatMap((expectedSubjects) =>
              appleSignIn.revoke({ ...payload, expectedSubjects }),
            ),
            Effect.tapError((error) =>
              Effect.logWarning(
                "Sign in with Apple revocation failed",
                error._tag === "AppleSignInRevocationFailed"
                  ? {
                      stage: error.stage,
                      status: error.status,
                      appleError: error.appleError,
                      cause: error.cause,
                    }
                  : { stage: "read-clerk-user", cause: error.cause },
              ),
            ),
            Effect.catchTags({
              AppleSignInRevocationFailed: () => failWithTrace("upstream_unavailable"),
              ClerkUserLookupFailed: () => failWithTrace("upstream_unavailable"),
            }),
          );
          return { ok: true };
        }),
      )
      .handle(
        "deleteAccount",
        Effect.fn("relay.api.account.deleteAccount")(function* () {
          const { userId, token } = yield* RelayClientPrincipal;
          yield* deletion.deleteAccount({ userId, token }).pipe(
            Effect.tapError((error) =>
              Effect.logError("Account deletion failed", {
                stage: error.stage,
                cause: error.cause,
              }),
            ),
            Effect.catchTags({
              AccountDeletionFailed: (error) => failWithTrace(internalReason(error.stage)),
            }),
          );
          return { ok: true };
        }),
      );
  }),
);
// SCIENT-FORK:END account-deletion
