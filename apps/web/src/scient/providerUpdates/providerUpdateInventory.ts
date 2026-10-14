import {
  PROVIDER_DISPLAY_NAMES,
  type EnvironmentId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

import {
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
} from "~/components/ProviderUpdateLaunchNotification.logic";
import {
  collectManagedRuntimeUpdateCandidates,
  managedRuntimeUpdateTargets,
  type ManagedRuntimeUpdateOutcome,
} from "../providerConnection/ManagedRuntimeUpdateNotification.logic";

/**
 * One provider runtime to update on one machine. `managed` runtimes are
 * Scient's private copies, updated through its lifecycle actions; `system`
 * runtimes are other installations with a one-click update command. Each
 * runtime appears once per machine, however many instances share it.
 */
export interface ProviderUpdateItem {
  readonly kind: "managed" | "system";
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly driver: ProviderDriverKind;
  /** The instance whose update updates the shared runtime. */
  readonly instanceId: ProviderInstanceId;
  readonly installedVersion: string | null;
  readonly offeredVersion: string | null;
}

export interface ProviderUpdateMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly items: ReadonlyArray<ProviderUpdateItem>;
}

export interface ProviderUpdateEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
  readonly providers: ReadonlyArray<ServerProvider>;
}

/** Every connected machine's runtimes with an update this app can run in one click. */
export function collectProviderUpdateMachines(
  environments: ReadonlyArray<ProviderUpdateEnvironment>,
): ProviderUpdateMachine[] {
  return environments.flatMap((environment) => {
    if (!environment.connected) return [];
    const managedCandidates = collectManagedRuntimeUpdateCandidates([environment]);
    const managed = managedRuntimeUpdateTargets(managedCandidates).map(
      (target): ProviderUpdateItem => ({
        kind: "managed",
        environmentId: environment.environmentId,
        machineLabel: environment.label,
        driver: target.driver,
        instanceId: target.instanceId,
        installedVersion:
          managedCandidates.find(({ provider }) => provider.driver === target.driver)
            ?.installedVersion ?? null,
        offeredVersion: target.availableVersion,
      }),
    );
    // A runtime Scient updates is never also sent to its system update command.
    const managedDrivers = new Set(managed.map((item) => item.driver));
    const system = collectProviderUpdateCandidates(environment.providers)
      .filter(
        (candidate) =>
          !managedDrivers.has(candidate.driver) &&
          canOneClickUpdateProviderCandidate(candidate, environment.providers),
      )
      .map((candidate): ProviderUpdateItem => ({
        kind: "system",
        environmentId: environment.environmentId,
        machineLabel: environment.label,
        driver: candidate.driver,
        instanceId: candidate.instanceId,
        installedVersion: candidate.version ?? null,
        offeredVersion: candidate.versionAdvisory.latestVersion,
      }));
    const items = [...managed, ...system];
    return items.length > 0
      ? [{ environmentId: environment.environmentId, label: environment.label, items }]
      : [];
  });
}

/** "Codex 0.48.0 → 0.50.1 · managed by Scient". */
export function describeProviderUpdateItem(item: ProviderUpdateItem): string {
  const name = PROVIDER_DISPLAY_NAMES[item.driver] ?? item.driver;
  const versions =
    item.installedVersion && item.offeredVersion
      ? ` ${item.installedVersion} → ${item.offeredVersion}`
      : item.offeredVersion
        ? ` → ${item.offeredVersion}`
        : "";
  return `${name}${versions} · ${item.kind === "managed" ? "managed by Scient" : "system install"}`;
}

export type ProviderUpdateOutcome =
  | Exclude<ManagedRuntimeUpdateOutcome, { readonly status: "pending" }>
  /** The request was interrupted before the server answered; nothing to report. */
  | { readonly status: "interrupted" };

export interface ProviderUpdateResult {
  readonly item: ProviderUpdateItem;
  readonly outcome: ProviderUpdateOutcome;
}

/** A system update's answer: done only when the server verified the new version. */
export function systemProviderUpdateOutcome(
  item: Pick<ProviderUpdateItem, "instanceId">,
  result: AtomCommandResult<{ readonly providers: ReadonlyArray<ServerProvider> }, unknown>,
): ProviderUpdateOutcome {
  if (isAtomCommandInterrupted(result)) return { status: "interrupted" };
  if (result._tag === "Failure") {
    const error = squashAtomCommandFailure(result);
    return {
      status: "failed",
      message: error instanceof Error ? error.message : "Provider update failed.",
    };
  }
  const provider = result.value.providers.find(
    (candidate) => candidate.instanceId === item.instanceId,
  );
  return provider?.updateState?.status === "succeeded"
    ? { status: "succeeded", version: provider.version ?? null }
    : {
        status: "failed",
        message: provider?.updateState?.message ?? "Provider update did not finish.",
      };
}

/**
 * Runs every update and resolves once each has a final result. System updates
 * go out together; each server queues the ones that share an installer.
 * Managed updates start one at a time, as each machine serializes its runtime
 * manager, and finish when their new runtime is active, which waits for the
 * provider's running work.
 */
export async function runProviderUpdates(
  machines: ReadonlyArray<ProviderUpdateMachine>,
  run: {
    readonly updateSystem: (item: ProviderUpdateItem) => Promise<ProviderUpdateOutcome>;
    /** Starts a managed update; its promise is the update's final result. */
    readonly startManaged: (
      item: ProviderUpdateItem,
    ) => Promise<{ readonly finished: Promise<ProviderUpdateOutcome> }>;
  },
): Promise<ProviderUpdateResult[]> {
  const items = machines.flatMap((machine) => machine.items);
  const settle = (item: ProviderUpdateItem, outcome: Promise<ProviderUpdateOutcome>) =>
    outcome.then(
      (resolved): ProviderUpdateResult => ({ item, outcome: resolved }),
      (error: unknown): ProviderUpdateResult => ({
        item,
        outcome: {
          status: "failed",
          message: error instanceof Error ? error.message : "Provider update failed.",
        },
      }),
    );
  const system = items
    .filter((item) => item.kind === "system")
    .map((item) => settle(item, run.updateSystem(item)));
  const managed: Array<Promise<ProviderUpdateResult>> = [];
  for (const item of items.filter((candidate) => candidate.kind === "managed")) {
    // Wrapped, so awaiting the start does not also await the update's end.
    const { finished } = await run.startManaged(item).catch((error: unknown) => ({
      finished: Promise.reject<ProviderUpdateOutcome>(error),
    }));
    managed.push(settle(item, finished));
  }
  return Promise.all([...system, ...managed]);
}

/**
 * One notice for a finished run, or null when every request was interrupted.
 * Each update that did not succeed gets its own line, so a failure on one
 * machine is not hidden by the others.
 */
export function getProviderUpdateResultsToastView(results: ReadonlyArray<ProviderUpdateResult>): {
  readonly type: "success" | "warning" | "error";
  readonly title: string;
  readonly description: string;
} | null {
  const settled = results.filter(({ outcome }) => outcome.status !== "interrupted");
  if (settled.length === 0) return null;
  const lines = settled.flatMap(({ item, outcome }) => {
    const label = `${item.machineLabel} · ${PROVIDER_DISPLAY_NAMES[item.driver] ?? item.driver}`;
    return outcome.status === "failed"
      ? [`${label}: ${outcome.message}`]
      : outcome.status === "cancelled"
        ? [`${label}: Cancelled.`]
        : [];
  });
  const failed = settled.filter(({ outcome }) => outcome.status === "failed").length;
  if (lines.length === 0) {
    return {
      type: "success",
      title: settled.length === 1 ? "Provider updated" : `${settled.length} providers updated`,
      description:
        settled.length === 1
          ? "New sessions will use the updated provider."
          : "New sessions will use the updated providers.",
    };
  }
  const notDone = failed > 0 ? failed : lines.length;
  const verb = failed > 0 ? "failed" : "cancelled";
  return {
    type: failed > 0 ? "error" : "warning",
    title:
      settled.length === 1
        ? `Provider update ${verb}`
        : notDone < settled.length
          ? `${notDone} of ${settled.length} provider updates ${verb}`
          : `Provider updates ${verb}`,
    description: lines.join("\n"),
  };
}
