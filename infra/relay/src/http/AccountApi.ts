// SCIENT-FORK:START account-deletion — whole file.
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { RelayApi, RelayClientPrincipal, RelayInternalError } from "@t3tools/contracts/relay";

import * as AccountDeletion from "../account/AccountDeletion.ts";

const internalReason = (
  stage: AccountDeletion.AccountDeletionFailed["stage"],
): RelayInternalError["reason"] =>
  stage === "list-environments" || stage === "delete-records"
    ? "persistence_failed"
    : "upstream_unavailable";

export const layerAccountApi = HttpApiBuilder.group(
  RelayApi,
  "account",
  Effect.fnUntraced(function* (handlers) {
    const deletion = yield* AccountDeletion.AccountDeletion;
    return handlers.handle(
      "deleteAccount",
      Effect.fn("relay.api.account.deleteAccount")(function* () {
        const { userId, token } = yield* RelayClientPrincipal;
        yield* deletion.deleteAccount({ userId, token }).pipe(
          Effect.tapError((error) =>
            Effect.logError("Account deletion failed", { stage: error.stage, cause: error.cause }),
          ),
          Effect.catchTags({
            AccountDeletionFailed: (error) =>
              Effect.currentParentSpan.pipe(
                Effect.map((span) => span.traceId),
                Effect.orElseSucceed(() => "unavailable"),
                Effect.flatMap((traceId) =>
                  Effect.fail(
                    new RelayInternalError({
                      code: "internal_error",
                      reason: internalReason(error.stage),
                      traceId,
                    }),
                  ),
                ),
              ),
          }),
        );
        return { ok: true };
      }),
    );
  }),
);
// SCIENT-FORK:END account-deletion
