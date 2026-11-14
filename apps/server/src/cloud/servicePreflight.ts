import packageJson from "../../package.json" with { type: "json" };
import { BUILD_MIGRATION_HEAD, recordedMigrations } from "../persistence/databaseMigrationHead.ts";
// SCIENT-FORK:START — preflight applies the same ledger check as Scient's startup.
import { migrationManifest } from "../persistence/Migrations.ts";
import { scientMigrationLedgerProblem } from "../persistence/scientMigrationLedger.ts";
// SCIENT-FORK:END
import { reconciledV2PreviewHistory } from "../persistence/reconcileV2PreviewMigration.ts";
import {
  isSupportedLauncherProtocol,
  SERVICE_LAUNCHER_PROTOCOL,
  type SupportedLauncherProtocol,
} from "./serviceProtocol.ts";

export type ServicePreflightResult =
  | {
      readonly status: "ready";
      readonly version: string;
      /** The launcher protocol the server named; it accepts no other in reply. */
      readonly launcherProtocol: SupportedLauncherProtocol;
    }
  | {
      readonly status: "blocked";
      readonly version: string;
      readonly reason: string;
    };

export function runServicePreflight(input: {
  readonly databasePath: string;
  readonly launcherProtocol: number;
  readonly version?: string;
}): ServicePreflightResult {
  const version = input.version ?? packageJson.version;
  const { launcherProtocol } = input;
  if (!isSupportedLauncherProtocol(launcherProtocol)) {
    return {
      status: "blocked",
      version,
      reason: [
        // SCIENT-FORK:START — diagnostics identify the matching Scient installation.
        `The installed Scient service launcher speaks protocol ${launcherProtocol}, but Scient ${version} requires protocol ${SERVICE_LAUNCHER_PROTOCOL}.`,
        // SCIENT-FORK:END
        "On the server machine, use the matching Scient installation to update the launcher for this profile. Check that installation's version and absolute executable path before repairing the service.",
        "Updating the desktop app does not update this CLI; service repair uses the CLI and profile that run it.",
      ].join(" "),
    };
  }

  const recorded = recordedMigrations(input.databasePath);
  // SCIENT-FORK:START — diagnostics name the Scient release.
  if (recorded === null) {
    return {
      status: "blocked",
      version,
      reason: `Could not read this database to confirm Scient ${version} supports it.`,
    };
  }
  const newer = recorded
    .filter(({ id }) => id > BUILD_MIGRATION_HEAD)
    .map(({ id, name }) => `${id}_${name}`);
  if (newer.length > 0) {
    return {
      status: "blocked",
      version,
      reason: `This database has migrations that Scient ${version} does not know: ${newer.join(", ")}. A newer build wrote them, and running Scient ${version} on this database is not safe. Stay on the newer release, or wait for a release that includes these migrations.`,
    };
  }
  // SCIENT-FORK:END

  // Startup reconciles V2 preview ids before it checks the history, so check what it will see.
  const reconciled = reconciledV2PreviewHistory(recorded);
  const incompatible =
    reconciled === null
      ? "an unexpected V2 preview history."
      : // SCIENT-FORK: Scient's startup validates the whole ledger, not only T3's V2 ids.
        scientMigrationLedgerProblem(reconciled, migrationManifest);
  if (incompatible !== undefined) {
    return {
      status: "blocked",
      version,
      reason: `This database has incompatible migration history: ${incompatible} Start the build that wrote it, or report this migration history so an upgrade path can be added.`,
    };
  }

  return { status: "ready", version, launcherProtocol };
}

export function decodeServicePreflightResult(
  value: unknown,
  launcherProtocol: SupportedLauncherProtocol,
): ServicePreflightResult | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.status === "ready" &&
    record.launcherProtocol === launcherProtocol &&
    typeof record.version === "string"
  ) {
    return { status: "ready", version: record.version, launcherProtocol };
  }
  if (
    record.status === "blocked" &&
    typeof record.version === "string" &&
    typeof record.reason === "string"
  ) {
    return { status: "blocked", version: record.version, reason: record.reason };
  }
  return undefined;
}
