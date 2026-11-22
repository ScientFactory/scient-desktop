// SCIENT-FORK:START account-deletion — whole file.
import { and, count, eq, isNull, sql, type SQL } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlError from "effect/sql/SqlError";

import * as RelayDb from "../db.ts";
import {
  relayAgentActivityRows,
  relayDeliveryAttempts,
  relayEnvironmentCredentials,
  relayEnvironmentLinks,
  relayLiveActivities,
  relayManagedEndpointAllocations,
  relayManagedTunnelLimits,
  relayMobileDevices,
} from "../persistence/schema.ts";

export class AccountRecordsPersistenceError extends Schema.TaggedError<AccountRecordsPersistenceError>()(
  "AccountRecordsPersistenceError",
  {
    operation: Schema.Literals(["list-environments", "delete"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Account record '${this.operation}' failed`;
  }
}

export class AccountManagedEndpointsRemain extends Schema.TaggedError<AccountManagedEndpointsRemain>()(
  "AccountManagedEndpointsRemain",
  { count: Schema.Number },
) {
  override get message(): string {
    return `${this.count} managed endpoint allocations still belong to the account`;
  }
}

/**
 * Statements that remove every relay row a user owns, in dependency order. Rows keyed by an
 * environment key are kept while another account still links that key.
 */
export const accountRecordDeletions = (userId: string): ReadonlyArray<SQL> => {
  const ownedEnvironmentKey = (
    table: typeof relayAgentActivityRows | typeof relayEnvironmentCredentials,
  ) => sql`
    exists (
      select 1 from ${relayEnvironmentLinks} owned
      where owned.user_id = ${userId}
        and owned.environment_id = ${table.environmentId}
        and owned.environment_public_key = ${table.environmentPublicKey}
    )
    and not exists (
      select 1 from ${relayEnvironmentLinks} other
      where other.user_id <> ${userId}
        and other.revoked_at is null
        and other.environment_id = ${table.environmentId}
        and other.environment_public_key = ${table.environmentPublicKey}
    )`;
  return [
    sql`delete from ${relayAgentActivityRows} where ${ownedEnvironmentKey(relayAgentActivityRows)}`,
    sql`delete from ${relayEnvironmentCredentials} where ${ownedEnvironmentKey(relayEnvironmentCredentials)}`,
    sql`delete from ${relayDeliveryAttempts}
      where ${relayDeliveryAttempts.userId} = ${userId}
        or (
          ${relayDeliveryAttempts.userId} is null
          and ${relayDeliveryAttempts.deviceId} in (
            select device_id from ${relayMobileDevices} where user_id = ${userId}
          )
        )`,
    sql`delete from ${relayLiveActivities} where ${relayLiveActivities.userId} = ${userId}`,
    sql`delete from ${relayMobileDevices} where ${relayMobileDevices.userId} = ${userId}`,
    sql`delete from ${relayEnvironmentLinks} where ${relayEnvironmentLinks.userId} = ${userId}`,
    sql`delete from ${relayManagedTunnelLimits} where ${relayManagedTunnelLimits.userId} = ${userId}`,
  ];
};

export class AccountRecords extends Context.Service<
  AccountRecords,
  {
    /** Environments with an active link or a managed endpoint allocation. */
    readonly listEnvironmentIds: (input: {
      readonly userId: string;
    }) => Effect.Effect<ReadonlyArray<string>, AccountRecordsPersistenceError>;
    /** Refuses while a managed endpoint remains, so its tunnel is never orphaned. */
    readonly deleteForUser: (input: {
      readonly userId: string;
    }) => Effect.Effect<void, AccountRecordsPersistenceError | AccountManagedEndpointsRemain>;
  }
>()("t3code-relay/account/AccountRecords") {}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  const deleteFailed = (cause: unknown) =>
    new AccountRecordsPersistenceError({ operation: "delete", cause });

  return AccountRecords.of({
    listEnvironmentIds: Effect.fn("relay.account_records.list_environment_ids")(function* (input) {
      const listed = Effect.all([
        db
          .select({ environmentId: relayEnvironmentLinks.environmentId })
          .from(relayEnvironmentLinks)
          .where(
            and(
              eq(relayEnvironmentLinks.userId, input.userId),
              isNull(relayEnvironmentLinks.revokedAt),
            ),
          ),
        db
          .select({ environmentId: relayManagedEndpointAllocations.environmentId })
          .from(relayManagedEndpointAllocations)
          .where(eq(relayManagedEndpointAllocations.userId, input.userId)),
      ]);
      const [links, allocations] = yield* listed.pipe(
        Effect.mapError(
          (cause) => new AccountRecordsPersistenceError({ operation: "list-environments", cause }),
        ),
      );
      return [...new Set([...links, ...allocations].map((row) => row.environmentId))];
    }),
    deleteForUser: Effect.fn("relay.account_records.delete_for_user")(function* (input) {
      const remove = Effect.gen(function* () {
        const [remaining] = yield* db
          .select({ count: count() })
          .from(relayManagedEndpointAllocations)
          .where(eq(relayManagedEndpointAllocations.userId, input.userId))
          .pipe(Effect.mapError(deleteFailed));
        if (remaining && remaining.count > 0) {
          return yield* new AccountManagedEndpointsRemain({ count: remaining.count });
        }
        for (const statement of accountRecordDeletions(input.userId)) {
          yield* db.execute(statement).pipe(Effect.mapError(deleteFailed));
        }
      });
      // Statements map their own errors; a SqlError left here comes from the transaction itself.
      return yield* db.$client
        .withTransaction(remove)
        .pipe(
          Effect.mapError((cause) => (SqlError.isSqlError(cause) ? deleteFailed(cause) : cause)),
        );
    }),
  });
});

export const layer = Layer.effect(AccountRecords, make);
// SCIENT-FORK:END account-deletion
