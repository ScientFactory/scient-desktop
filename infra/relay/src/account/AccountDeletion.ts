// SCIENT-FORK:START account-deletion — whole file.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as ManagedEndpointProvider from "../environments/ManagedEndpointProvider.ts";
import * as HookInbox from "../hooks/HookInbox.ts";
import { unlinkEnvironmentRecord } from "../http/Api.ts";
import * as T3ChatAccounts from "../t3chat/T3ChatAccounts.ts";
import * as AccountRecords from "./AccountRecords.ts";
import * as ClerkUsers from "./ClerkUsers.ts";

// Cloudflare calls dominate; a few at once keeps a multi-computer account inside the request deadline.
const ENVIRONMENT_UNLINK_CONCURRENCY = 4;

export class AccountDeletionFailed extends Schema.TaggedError<AccountDeletionFailed>()(
  "AccountDeletionFailed",
  {
    stage: Schema.Literals([
      "list-environments",
      "unlink-environment",
      "delete-records",
      "unlink-t3chat",
      "delete-clerk-user",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Account deletion failed at '${this.stage}'`;
  }
}

export class AccountDeletion extends Context.Service<
  AccountDeletion,
  {
    /**
     * Removes relay records and managed endpoints, then the Clerk user. Each step tolerates
     * earlier partial runs, and the Clerk user goes last so a failed run can be retried with
     * the same sign-in.
     */
    readonly deleteAccount: (input: {
      readonly userId: string;
      readonly token: string;
    }) => Effect.Effect<void, AccountDeletionFailed>;
  }
>()("t3code-relay/account/AccountDeletion") {}

export const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const records = yield* AccountRecords.AccountRecords;
  const clerkUsers = yield* ClerkUsers.ClerkUsers;
  const t3Chat = yield* T3ChatAccounts.T3ChatAccounts;
  const unlinkServices = yield* Effect.context<
    | EnvironmentLinks.EnvironmentLinks
    | EnvironmentCredentials.EnvironmentCredentials
    | ManagedEndpointProvider.ManagedEndpointProvider
    | HookInbox.HookInbox
    | RelayDb.RelayTransactions
  >();
  const fail = (stage: AccountDeletionFailed["stage"]) => (cause: unknown) =>
    new AccountDeletionFailed({ stage, cause });

  return AccountDeletion.of({
    deleteAccount: Effect.fn("relay.account_deletion.delete_account")(function* (input) {
      const environmentIds = yield* records
        .listEnvironmentIds({ userId: input.userId })
        .pipe(Effect.mapError(fail("list-environments")));
      yield* Effect.annotateCurrentSpan({
        "relay.account.environment_count": environmentIds.length,
      });

      yield* Effect.forEach(
        environmentIds,
        (environmentId) =>
          unlinkEnvironmentRecord({
            userId: input.userId,
            environmentId,
            managedEndpointNamespace: config.managedEndpointNamespace,
          }).pipe(
            Effect.provideContext(unlinkServices),
            Effect.mapError(fail("unlink-environment")),
          ),
        { concurrency: ENVIRONMENT_UNLINK_CONCURRENCY, discard: true },
      );

      yield* records
        .deleteForUser({ userId: input.userId })
        .pipe(Effect.mapError(fail("delete-records")));

      if (t3Chat.available) {
        yield* t3Chat.unlink({ userId: input.userId }).pipe(Effect.mapError(fail("unlink-t3chat")));
      }

      yield* clerkUsers.deleteUser(input).pipe(Effect.mapError(fail("delete-clerk-user")));
    }),
  });
});

export const layer = Layer.effect(AccountDeletion, make);
// SCIENT-FORK:END account-deletion
