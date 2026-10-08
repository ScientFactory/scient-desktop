/**
 * Migration runner with an inline loader.
 *
 * Uses Migrator.make with fromRecord to define migrations inline.
 * All migrations are statically imported - no dynamic file system loading.
 *
 * `runMigrations` is called by the SQLite persistence layer at startup, so the
 * schema is always up to date before the application starts.
 */

import * as Migrator from "effect/sql/Migrator";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { reconcileV2PreviewMigration } from "./reconcileV2PreviewMigration.ts";

// Import all migrations statically
import Migration0001 from "./Migrations/001_OrchestrationEvents.ts";
import Migration0002 from "./Migrations/002_OrchestrationCommandReceipts.ts";
import Migration0003 from "./Migrations/003_CheckpointDiffBlobs.ts";
import Migration0004 from "./Migrations/004_ProviderSessionRuntime.ts";
import Migration0005 from "./Migrations/005_Projections.ts";
import Migration0006 from "./Migrations/006_ProjectionThreadSessionRuntimeModeColumns.ts";
import Migration0007 from "./Migrations/007_ProjectionThreadMessageAttachments.ts";
import Migration0008 from "./Migrations/008_ProjectionThreadActivitySequence.ts";
import Migration0009 from "./Migrations/009_ProviderSessionRuntimeMode.ts";
import Migration0010 from "./Migrations/010_ProjectionThreadsRuntimeMode.ts";
import Migration0011 from "./Migrations/011_OrchestrationThreadCreatedRuntimeMode.ts";
import Migration0012 from "./Migrations/012_ProjectionThreadsInteractionMode.ts";
import Migration0013 from "./Migrations/013_ProjectionThreadProposedPlans.ts";
import Migration0014 from "./Migrations/014_ProjectionThreadProposedPlanImplementation.ts";
import Migration0015 from "./Migrations/015_ProjectionTurnsSourceProposedPlan.ts";
import Migration0016 from "./Migrations/016_CanonicalizeModelSelections.ts";
import Migration0017 from "./Migrations/017_ProjectionThreadsArchivedAt.ts";
import Migration0018 from "./Migrations/018_ProjectionThreadsArchivedAtIndex.ts";
import Migration0019 from "./Migrations/019_ProjectionSnapshotLookupIndexes.ts";
import Migration0020 from "./Migrations/020_AuthAccessManagement.ts";
import Migration0021 from "./Migrations/021_AuthSessionClientMetadata.ts";
import Migration0022 from "./Migrations/022_AuthSessionLastConnectedAt.ts";
import Migration0023 from "./Migrations/023_ProjectionThreadShellSummary.ts";
import Migration0024 from "./Migrations/024_BackfillProjectionThreadShellSummary.ts";
import Migration0025 from "./Migrations/025_CleanupInvalidProjectionPendingApprovals.ts";
import Migration0026 from "./Migrations/026_CanonicalizeModelSelectionOptions.ts";
import Migration0027 from "./Migrations/027_ProviderSessionRuntimeInstanceId.ts";
import Migration0028 from "./Migrations/028_ProjectionThreadSessionInstanceId.ts";
import Migration0029 from "./Migrations/029_ProjectionThreadDetailOrderingIndexes.ts";
import Migration0030 from "./Migrations/030_ProjectionThreadShellArchiveIndexes.ts";
import Migration0031 from "./Migrations/031_AuthAuthorizationScopes.ts";
import Migration0032 from "./Migrations/032_AuthPairingProofKeyThumbprint.ts";
import Migration0033 from "./Migrations/033_ProjectionThreadsSettled.ts";
import Migration0034 from "./Migrations/034_ProjectionThreadsSnoozed.ts";
import Migration0035 from "./Migrations/035_ProjectionThreadTitleRegeneration.ts";
import Migration0036 from "./Migrations/036_ProjectionThreadsPinned.ts";
import Migration0037 from "./Migrations/037_ProjectionTurnsKeysetIndex.ts";
import Migration0038 from "./Migrations/038_ProjectionThreadsPinOrderKey.ts";
import Migration0039 from "./Migrations/039_ProjectionProjectsDefaultThreadEnvMode.ts";
import Migration0040 from "./Migrations/040_ProjectionProjectFaviconPath.ts";
import Migration0041 from "./Migrations/041_ProjectlessThreads.ts";
import Migration0042 from "./Migrations/042_AuthSessionClientConnection.ts";
import Migration0043 from "./Migrations/043_RetireProjectlessThreads.ts";
import Migration0044 from "./Migrations/044_ProjectionThreadLinkedPullRequest.ts";
import Migration0045 from "./Migrations/045_ProjectionThreadsUnsettledAt.ts";
import Migration0046 from "./Migrations/046_ClearAutomaticProjectModelDefaults.ts";
import Migration0047 from "./Migrations/047_ProjectionProjectsAutoPull.ts";
import Migration0048 from "./Migrations/048_RepairAutomaticSettlementTimestamps.ts";
import Migration0049 from "./Migrations/049_ProjectionProjectIcon.ts";
import Migration0051 from "./Migrations/051_ProjectionThreadBranchPullRequest.ts";
import Migration0052 from "./Migrations/052_ProjectionThreadsActiveOrderKey.ts";
import Migration0053 from "./Migrations/053_ProjectionThreadPullRequests.ts";
import Migration0054 from "./Migrations/054_ProjectionThreadMessageContext.ts";
import Migration0055 from "./Migrations/055_ProjectionThreadTitleState.ts";
import Migration0056 from "./Migrations/056_PullRequestFilesViewed.ts";
// T3's migration 54 is renumbered to 57 because Scient's migration IDs are immutable.
import Migration0057 from "./Migrations/057_ProjectionThreadsAutoSettleDisabledAt.ts";
// SCIENT-FORK:START
import Migration0058 from "./Migrations/058_ProjectionThreadSections.ts";
// SCIENT-FORK:END
// T3's migration 55 is renumbered to 059 because Scient already shipped 055 and 056.
// A recorded migration ID is immutable; the runner compares ids only.
import Migration0059 from "./Migrations/059_OrchestrationV2.ts";
// T3's migration 56 follows Scient's immutable migration sequence at the next free ID.
import Migration0060 from "./Migrations/060_RemoveRedundantProjectionIndexes.ts";
// Incoming migrations follow Scient's immutable shipped ledger.
import Migration0061 from "./Migrations/061_ScheduledTaskWebhooks.ts";
import Migration0062 from "./Migrations/062_WebhookRelayDeliveries.ts";
import Migration0063 from "./Migrations/063_McpAppModelContext.ts";
// Incoming migrations follow Scient's immutable shipped ledger.

/**
 * Migration loader with all migrations defined inline.
 *
 * Key format: "{id}_{name}" where:
 * - id: numeric migration ID (determines execution order)
 * - name: descriptive name for the migration
 *
 * Uses Migrator.fromRecord which parses the key format and
 * returns migrations sorted by ID.
 */
export const migrationEntries = [
  [1, "OrchestrationEvents", Migration0001],
  [2, "OrchestrationCommandReceipts", Migration0002],
  [3, "CheckpointDiffBlobs", Migration0003],
  [4, "ProviderSessionRuntime", Migration0004],
  [5, "Projections", Migration0005],
  [6, "ProjectionThreadSessionRuntimeModeColumns", Migration0006],
  [7, "ProjectionThreadMessageAttachments", Migration0007],
  [8, "ProjectionThreadActivitySequence", Migration0008],
  [9, "ProviderSessionRuntimeMode", Migration0009],
  [10, "ProjectionThreadsRuntimeMode", Migration0010],
  [11, "OrchestrationThreadCreatedRuntimeMode", Migration0011],
  [12, "ProjectionThreadsInteractionMode", Migration0012],
  [13, "ProjectionThreadProposedPlans", Migration0013],
  [14, "ProjectionThreadProposedPlanImplementation", Migration0014],
  [15, "ProjectionTurnsSourceProposedPlan", Migration0015],
  [16, "CanonicalizeModelSelections", Migration0016],
  [17, "ProjectionThreadsArchivedAt", Migration0017],
  [18, "ProjectionThreadsArchivedAtIndex", Migration0018],
  [19, "ProjectionSnapshotLookupIndexes", Migration0019],
  [20, "AuthAccessManagement", Migration0020],
  [21, "AuthSessionClientMetadata", Migration0021],
  [22, "AuthSessionLastConnectedAt", Migration0022],
  [23, "ProjectionThreadShellSummary", Migration0023],
  [24, "BackfillProjectionThreadShellSummary", Migration0024],
  [25, "CleanupInvalidProjectionPendingApprovals", Migration0025],
  [26, "CanonicalizeModelSelectionOptions", Migration0026],
  [27, "ProviderSessionRuntimeInstanceId", Migration0027],
  [28, "ProjectionThreadSessionInstanceId", Migration0028],
  [29, "ProjectionThreadDetailOrderingIndexes", Migration0029],
  [30, "ProjectionThreadShellArchiveIndexes", Migration0030],
  [31, "AuthAuthorizationScopes", Migration0031],
  [32, "AuthPairingProofKeyThumbprint", Migration0032],
  [33, "ProjectionThreadsSettled", Migration0033],
  [34, "ProjectionThreadsSnoozed", Migration0034],
  [35, "ProjectionThreadTitleRegeneration", Migration0035],
  [36, "ProjectionThreadsPinned", Migration0036],
  [37, "ProjectionTurnsKeysetIndex", Migration0037],
  [38, "ProjectionThreadsPinOrderKey", Migration0038],
  [39, "ProjectionProjectsDefaultThreadEnvMode", Migration0039],
  [40, "ProjectionProjectFaviconPath", Migration0040],
  [41, "ProjectlessThreads", Migration0041],
  [42, "AuthSessionClientConnection", Migration0042],
  [43, "RetireProjectlessThreads", Migration0043],
  [44, "ProjectionThreadLinkedPullRequest", Migration0044],
  [45, "ProjectionThreadsUnsettledAt", Migration0045],
  [46, "ClearAutomaticProjectModelDefaults", Migration0046],
  [47, "ProjectionProjectsAutoPull", Migration0047],
  [48, "RepairAutomaticSettlementTimestamps", Migration0048],
  [49, "ProjectionProjectIcon", Migration0049],
  // 50 was used by the retired development-only ProjectionSessionErrorReason.
  // Never reuse recorded IDs: the runner advances past the highest recorded ID.
  [51, "ProjectionThreadBranchPullRequest", Migration0051],
  [52, "ProjectionThreadsActiveOrderKey", Migration0052],
  // T3's migration 50 follows Scient's immutable history at the next free ID.
  [53, "ProjectionThreadPullRequests", Migration0053],
  // T3's migration 51 follows Scient's immutable migration sequence.
  [54, "ProjectionThreadMessageContext", Migration0054],
  // T3's migration 52 follows Scient's immutable migration sequence.
  [55, "ProjectionThreadTitleState", Migration0055],
  // T3's migration 53 follows Scient's immutable migration sequence.
  [56, "PullRequestFilesViewed", Migration0056],
  // T3's migration 54 follows Scient's immutable migration sequence.
  [57, "ProjectionThreadsAutoSettleDisabledAt", Migration0057],
  // SCIENT-FORK:START — durable thread section membership.
  [58, "ProjectionThreadSections", Migration0058],
  // SCIENT-FORK:END
  // T3's migration 55 lands at the next free ID. Scient already recorded 055 and
  // 056, and a recorded ID is immutable: reusing one would silently skip this
  // migration on every existing database.
  [59, "OrchestrationV2", Migration0059],
  // T3's migration 56 follows Scient's immutable migration sequence.
  [60, "RemoveRedundantProjectionIndexes", Migration0060],
  [61, "ScheduledTaskWebhooks", Migration0061],
  [62, "WebhookRelayDeliveries", Migration0062],
  [63, "McpAppModelContext", Migration0063],
] as const;

export const migrationManifest = migrationEntries.map(([id, name]) => [id, name] as const);

const makeMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      migrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

/**
 * Migrator run function - no schema dumping needed
 * Uses the base Migrator.make without platform dependencies
 */
const run = Migrator.make({});

export interface RunMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

/**
 * Reject a ledger this build cannot safely continue from.
 *
 * The migrator keys on `migration_id` alone: a database whose ledger was
 * written by a fork, a preview or the local V2 shadow keeps that id and
 * silently skips this build's migration at it, reporting success over a short
 * schema. Validation is by migration id, never by position — Scient deliberately
 * retired migration 50, so a legitimate ledger may contain an id this build no
 * longer defines.
 */
const validateLedger = Effect.fn("validateLedger")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return; // Fresh database: nothing recorded yet.
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  if (rows.length === 0) return;

  const latest = migrationEntries[migrationEntries.length - 1]!;
  let previousRecordedId = 0;
  for (const row of rows) {
    if (row.migration_id <= previousRecordedId) {
      return yield* new Migrator.MigrationError({
        kind: "BadState",
        message:
          `Migration ledger is not in increasing id order: ${row.migration_id} ("${row.name}") ` +
          `follows ${previousRecordedId}. The ledger was modified; refusing to continue.`,
      });
    }
    if (row.migration_id > latest[0]) {
      return yield* new Migrator.MigrationError({
        kind: "BadState",
        message:
          `Migration ledger records ${row.migration_id} ("${row.name}"), beyond the latest known ` +
          `${latest[0]} ("${latest[1]}"). The database was migrated by a newer or different ` +
          `build; refusing to run this build's migrations against it.`,
      });
    }
    // One ascending pass finds this row's migration and simultaneously rejects a
    // gap: any migration this build defines between the previously recorded id
    // and this one was never recorded, so an id-ordered migrator would skip it
    // forever. That is the silent short-schema failure, and it must refuse.
    let expectedName: string | undefined;
    for (const [id, name] of migrationEntries) {
      if (id === row.migration_id) {
        expectedName = name;
        break;
      }
      if (id > previousRecordedId && id < row.migration_id) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message:
            `Migration ledger skips ${id} ("${name}"), which this build defines, between recorded ` +
            `${previousRecordedId} and ${row.migration_id}. That migration would never run; ` +
            `refusing to continue.`,
        });
      }
    }
    previousRecordedId = row.migration_id;
    // Retired ids are tolerated: an older build recorded them and this build
    // intentionally no longer defines them.
    if (expectedName === undefined) continue;
    if (row.name !== expectedName) {
      return yield* new Migrator.MigrationError({
        kind: "BadState",
        message:
          `Migration ledger records ${row.migration_id} as "${row.name}" but this build names it ` +
          `"${expectedName}". The ledger was written by a different build; this build's migration ` +
          `at that id would be silently skipped, so refusing to continue.`,
      });
    }
  }
});

/**
 * Run all pending migrations.
 *
 * Creates the migrations tracking table (effect_sql_migrations) if it doesn't exist,
 * then runs any migrations with ID greater than the latest recorded migration.
 *
 * Returns array of [id, name] tuples for migrations that were run.
 *
 * @returns Effect containing array of executed migrations
 */
export const runMigrations = Effect.fn("runMigrations")(function* ({
  toMigrationInclusive,
}: RunMigrationsOptions = {}) {
  const previewMigrations =
    // Only worth attempting once the caller intends to migrate past the
    // orchestration schema. 59 is T3's migration 55 at Scient's next free id.
    toMigrationInclusive === undefined || toMigrationInclusive >= 59
      ? yield* reconcileV2PreviewMigration()
      : [];
  // After the preview lift, so a repaired ledger is judged as this build sees it.
  yield* validateLedger();
  const executedMigrations = [
    ...previewMigrations,
    ...(yield* run({ loader: makeMigrationLoader(toMigrationInclusive) })),
  ];
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Database schema is current")
    : Effect.log("Migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));

  // The migrator keys on migration_id: a database that recorded a different
  // migration under a shared id (local or fork builds) keeps that id and
  // silently skips this build's migration at it. Surface the divergence so the
  // skipped schema change is diagnosable.
  const sql = yield* SqlClient.SqlClient;
  const recorded = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations`;
  const manifestNames = new Map<number, string>(migrationEntries.map(([id, name]) => [id, name]));
  const divergent = recorded.flatMap((row) => {
    const expected = manifestNames.get(row.migration_id);
    if (expected === undefined) {
      return [`${row.migration_id}:${row.name} (unknown to this build)`];
    }
    return expected === row.name
      ? []
      : [`${row.migration_id}:${row.name} (this build: ${expected})`];
  });
  if (divergent.length > 0) {
    yield* Effect.logWarning(
      "Database migration history diverges from this build; recorded migration ids are skipped, not reconciled by name.",
    ).pipe(Effect.annotateLogs({ divergent }));
  }
  return executedMigrations;
});
