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

export class ClerkUserLookupFailed extends Schema.TaggedError<ClerkUserLookupFailed>()(
  "ClerkUserLookupFailed",
  {
    instance: Schema.Literals(["primary", "legacy"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not read the user from the ${this.instance} Clerk instance`;
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
    /** The user's Apple account IDs (`sub`) from their Sign in with Apple connections. */
    readonly appleSubjects: (input: {
      readonly userId: string;
      readonly token: string;
    }) => Effect.Effect<ReadonlyArray<string>, ClerkUserLookupFailed>;
  }
>()("t3code-relay/account/ClerkUsers") {}

const APPLE_PROVIDERS = new Set(["oauth_apple", "apple"]);

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

  // The user's Apple IDs, or null when this instance has no such user.
  const appleSubjectsFrom = Effect.fn("relay.clerk_users.apple_subjects_from")(function* (
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
          const user = await client.users.getUser(userId);
          return user.externalAccounts
            .filter((account) => APPLE_PROVIDERS.has(account.provider))
            .map((account) => account.providerUserId)
            .filter((subject) => subject.length > 0);
        } catch (error) {
          if (isClerkAPIResponseError(error) && error.status === 404) return null;
          throw error;
        }
      },
      catch: (cause) => new ClerkUserLookupFailed({ instance: instance.name, cause }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: CLERK_REQUEST_TIMEOUT,
        orElse: () =>
          Effect.fail(new ClerkUserLookupFailed({ instance: instance.name, cause: "timed out" })),
      }),
    );
  });

  return ClerkUsers.of({
    appleSubjects: Effect.fn("relay.clerk_users.apple_subjects")(function* (input) {
      for (const instance of ClerkInstances.clerkInstancesForBearer(config, input.token)) {
        const subjects = yield* appleSubjectsFrom(instance, input.userId);
        if (subjects !== null) return subjects;
      }
      return [];
    }),
    deleteUser: Effect.fn("relay.clerk_users.delete_user")(function* (input) {
      for (const instance of ClerkInstances.clerkInstancesForBearer(config, input.token)) {
        if (yield* deleteFrom(instance, input.userId)) return;
      }
    }),
  });
});

export const layer = Layer.effect(ClerkUsers, make);
// SCIENT-FORK:END account-deletion
