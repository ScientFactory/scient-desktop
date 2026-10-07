import {
  PROVIDER_DISPLAY_NAMES,
  type EnvironmentId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

import {
  PROVIDER_UPDATE_SUCCESS_VISIBLE_MS,
  type LocalEnvironmentUpdateGroup,
  type ProviderUpdateToastView,
} from "~/components/ProviderUpdateLaunchNotification.logic";

export interface ManagedRuntimeUpdateCandidate {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly provider: ServerProvider;
  readonly installedVersion: string;
  readonly availableVersion: string | null;
}

/** Managed-runtime offers use Scient's lifecycle actions, never T3 CLI advisories. */
export function isManagedRuntimeUpdateCandidate(provider: ServerProvider): boolean {
  const runtime = provider.connection?.runtime;
  const operation = runtime?.operation;
  const operationIsActive =
    operation !== null &&
    operation !== undefined &&
    operation.status !== "succeeded" &&
    operation.status !== "failed" &&
    operation.status !== "cancelled";

  // A system runtime can stand in for a private copy that failed its capability
  // check; updating the private copy is how it gets selected again.
  return (
    provider.enabled &&
    provider.installed &&
    (runtime?.source === "scient_managed" || runtime?.source === "system") &&
    runtime.managedVersion !== null &&
    runtime.actions.includes("update") &&
    !operationIsActive
  );
}

export function collectManagedRuntimeUpdateCandidates(
  groups: ReadonlyArray<LocalEnvironmentUpdateGroup>,
): ManagedRuntimeUpdateCandidate[] {
  return groups.flatMap((group) =>
    group.providers.flatMap((provider) => {
      const runtime = provider.connection?.runtime;
      if (!isManagedRuntimeUpdateCandidate(provider) || runtime?.managedVersion == null) return [];
      return [
        {
          environmentId: group.environmentId,
          environmentLabel: group.label,
          provider,
          installedVersion: runtime.managedVersion,
          availableVersion: runtime.availableManagedVersion ?? null,
        },
      ];
    }),
  );
}

export function managedRuntimeUpdateNotificationKey(
  candidates: ReadonlyArray<ManagedRuntimeUpdateCandidate>,
): string | null {
  const parts = candidates
    .map(({ environmentId, provider, installedVersion, availableVersion }) => [
      environmentId,
      provider.driver,
      provider.instanceId,
      installedVersion,
      availableVersion,
    ])
    .toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return parts.length > 0 ? `managed-runtime:${JSON.stringify(parts)}` : null;
}

/** One private runtime per environment and driver; every instance of that driver shares it. */
export interface ManagedRuntimeUpdateTarget {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly availableVersion: string | null;
}

function managedRuntimeUpdateTargetKey(target: {
  readonly environmentId: EnvironmentId;
  readonly driver: string;
}): string {
  return JSON.stringify([target.environmentId, target.driver]);
}

export function managedRuntimeUpdateTargets(
  candidates: ReadonlyArray<ManagedRuntimeUpdateCandidate>,
): ManagedRuntimeUpdateTarget[] {
  const targets = new Map<string, ManagedRuntimeUpdateTarget>();
  for (const candidate of candidates) {
    const target = {
      environmentId: candidate.environmentId,
      environmentLabel: candidate.environmentLabel,
      instanceId: candidate.provider.instanceId,
      driver: candidate.provider.driver,
      availableVersion: candidate.availableVersion,
    };
    const key = managedRuntimeUpdateTargetKey(target);
    if (!targets.has(key)) targets.set(key, target);
  }
  return [...targets.values()];
}

export type ManagedRuntimeUpdateOutcome =
  | { readonly status: "pending" }
  | { readonly status: "succeeded"; readonly version: string | null }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "cancelled" };

const UNCONFIRMED_MANAGED_UPDATE_MESSAGE =
  "Scient could not confirm the update. Review the provider in Settings.";
const DISCONNECTED_MANAGED_UPDATE_MESSAGE =
  "Scient lost contact with this environment during the update. Review the provider in Settings.";

/**
 * The result of a started update, read from the provider snapshot. Until the
 * snapshot has reported the operation (`observed`), a lagging snapshot without
 * it is still pending; afterwards its disappearance is settled by the version.
 */
export function resolveManagedRuntimeUpdateOutcome(input: {
  readonly provider: ServerProvider | undefined;
  readonly operationId: string;
  readonly observed: boolean;
  readonly expectedVersion: string | null;
}): ManagedRuntimeUpdateOutcome {
  // The environment's provider list was present when the update started, so a
  // missing provider means the environment went away.
  if (!input.provider) return { status: "failed", message: DISCONNECTED_MANAGED_UPDATE_MESSAGE };
  const runtime = input.provider.connection?.runtime;
  const operation = runtime?.operation ?? null;
  if (operation?.operationId === input.operationId) {
    if (operation.status === "succeeded") {
      // An update can install while the private copy still fails its check,
      // leaving the system runtime in use; that is not a successful update.
      return runtime?.source === "scient_managed"
        ? { status: "succeeded", version: runtime.managedVersion ?? input.expectedVersion }
        : { status: "failed", message: runtime?.message ?? UNCONFIRMED_MANAGED_UPDATE_MESSAGE };
    }
    if (operation.status === "failed") return { status: "failed", message: operation.message };
    if (operation.status === "cancelled") return { status: "cancelled" };
    return { status: "pending" };
  }
  if (!input.observed || !runtime) return { status: "pending" };
  return input.expectedVersion !== null &&
    runtime.source === "scient_managed" &&
    runtime.managedVersion === input.expectedVersion
    ? { status: "succeeded", version: runtime.managedVersion }
    : { status: "failed", message: UNCONFIRMED_MANAGED_UPDATE_MESSAGE };
}

export interface ManagedRuntimeUpdateRun {
  readonly target: ManagedRuntimeUpdateTarget;
  readonly operationId: string | null;
  /** Whether the environment's provider snapshot has reported the operation yet. */
  readonly observed: boolean;
  readonly outcome: ManagedRuntimeUpdateOutcome;
  /** The server's message while the staged runtime waits for running turns. */
  readonly waitingMessage: string | null;
}

/** Advances started runs from the latest per-environment provider snapshots. */
export function settleManagedRuntimeUpdateRuns(
  runs: ReadonlyArray<ManagedRuntimeUpdateRun>,
  groups: ReadonlyArray<Pick<LocalEnvironmentUpdateGroup, "environmentId" | "providers">>,
): ManagedRuntimeUpdateRun[] {
  return runs.map((run) => {
    if (run.operationId === null || run.outcome.status !== "pending") return run;
    const provider = groups
      .find((group) => group.environmentId === run.target.environmentId)
      ?.providers.find((candidate) => candidate.instanceId === run.target.instanceId);
    const operation = provider?.connection?.runtime?.operation;
    const ownOperation = operation?.operationId === run.operationId ? operation : undefined;
    const observed = run.observed || ownOperation !== undefined;
    return {
      ...run,
      observed,
      waitingMessage: ownOperation?.waitingForIdle ? ownOperation.message : null,
      outcome: resolveManagedRuntimeUpdateOutcome({
        provider,
        operationId: run.operationId,
        observed,
        expectedVersion: run.target.availableVersion,
      }),
    };
  });
}

function managedRuntimeUpdateSubject(targets: ReadonlyArray<ManagedRuntimeUpdateTarget>): string {
  const [first] = targets;
  if (!first || targets.length > 1) return `${targets.length} managed providers`;
  const name = PROVIDER_DISPLAY_NAMES[first.driver] ?? first.driver;
  const environments = new Set(targets.map((target) => target.environmentId));
  return environments.size > 1 ? `${name} in ${first.environmentLabel}` : name;
}

function formatManagedVersion(version: string | null): string {
  if (!version) return "";
  return ` ${version.startsWith("v") ? version : `v${version}`}`;
}

export function getManagedRuntimeUpdateWaitingToastView(
  targets: ReadonlyArray<ManagedRuntimeUpdateTarget>,
  message: string,
): ProviderUpdateToastView {
  return {
    phase: "running",
    type: "loading",
    title: `${managedRuntimeUpdateSubject(targets)} will update when idle`,
    description: message,
  };
}

export function getManagedRuntimeUpdateRunningToastView(
  targets: ReadonlyArray<ManagedRuntimeUpdateTarget>,
): ProviderUpdateToastView {
  const version = targets.length === 1 ? formatManagedVersion(targets[0]!.availableVersion) : "";
  return {
    phase: "running",
    type: "loading",
    title: `Updating ${managedRuntimeUpdateSubject(targets)}${version}`,
    description: "Downloading, verifying, and testing the Scient-managed runtime.",
  };
}

/** The notice for finished updates; none when every update was cancelled by the user. */
export function getManagedRuntimeUpdateResultToastView(
  settled: ReadonlyArray<{
    readonly target: ManagedRuntimeUpdateTarget;
    readonly outcome: Exclude<ManagedRuntimeUpdateOutcome, { readonly status: "pending" }>;
  }>,
): ProviderUpdateToastView | null {
  const results = settled.flatMap(({ target, outcome }) =>
    outcome.status === "cancelled" ? [] : [{ target, outcome }],
  );
  if (results.length === 0) return null;
  const failed = results.flatMap(({ target, outcome }) =>
    outcome.status === "failed" ? [{ target, message: outcome.message }] : [],
  );
  if (failed.length > 0) {
    return {
      phase: "failed",
      type: "error",
      title: `${managedRuntimeUpdateSubject(failed.map(({ target }) => target))} update failed`,
      description: failed[0]!.message,
    };
  }
  const [only] = results;
  const version =
    results.length === 1 && only?.outcome.status === "succeeded"
      ? formatManagedVersion(only.outcome.version)
      : "";
  return {
    phase: "succeeded",
    type: "success",
    title: `${managedRuntimeUpdateSubject(results.map(({ target }) => target))} updated${
      version ? ` to${version}` : ""
    }`,
    description: "The verified runtime is active for new turns.",
    dismissAfterVisibleMs: PROVIDER_UPDATE_SUCCESS_VISIBLE_MS,
  };
}
