// SCIENT-FORK:START account-deletion — whole file.
import { createClerkClient } from "@clerk/backend";
import { isClerkAPIResponseError } from "@clerk/backend/errors";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as ClerkInstances from "../auth/ClerkInstances.ts";
import * as RelayConfiguration from "../Config.ts";

const CLERK_REQUEST_TIMEOUT = "5 seconds";

export class ClerkUserDeletionFailed extends Schema.TaggedError<ClerkUserDeletionFailed>()(
  "ClerkUserDeletionFailed",
  {
    instance: Schema.Literals(["primary", "legacy"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not delete the user from the ${this.instance} Clerk instance`;
  }
}

export class ClerkUsers extends Context.Service<
  ClerkUsers,
  {
    /** Deletes the user from the instance that issued `token`; an already-deleted user succeeds. */
    readonly deleteUser: (input: {
      readonly userId: string;
      readonly token: string;
    }) => Effect.Effect<void, ClerkUserDeletionFailed>;
  }
>()("t3code-relay/account/ClerkUsers") {}

export const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;

  // True when deleted, false when this instance has no such user.
  const deleteFrom = Effect.fn("relay.clerk_users.delete_from")(function* (
    instance: ClerkInstances.ClerkInstance,
    userId: string,
  ) {
    yield* Effect.annotateCurrentSpan({ "relay.auth.clerk_instance": instance.name });
    return yield* Effect.tryPromise({
      try: async () => {
        const client = createClerkClient({
          secretKey: Redacted.value(instance.secretKey),
          publishableKey: instance.publishableKey,
        });
        try {
          await client.users.deleteUser(userId);
          return true;
        } catch (error) {
          if (isClerkAPIResponseError(error) && error.status === 404) return false;
          throw error;
        }
      },
      catch: (cause) => new ClerkUserDeletionFailed({ instance: instance.name, cause }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: CLERK_REQUEST_TIMEOUT,
        orElse: () =>
          Effect.fail(new ClerkUserDeletionFailed({ instance: instance.name, cause: "timed out" })),
      }),
    );
  });

  return ClerkUsers.of({
    deleteUser: Effect.fn("relay.clerk_users.delete_user")(function* (input) {
      for (const instance of ClerkInstances.clerkInstancesForBearer(config, input.token)) {
        if (yield* deleteFrom(instance, input.userId)) return;
      }
    }),
  });
});

export const layer = Layer.effect(ClerkUsers, make);
// SCIENT-FORK:END account-deletion
