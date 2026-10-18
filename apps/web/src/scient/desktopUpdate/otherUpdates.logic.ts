import type { ServerUpdateState } from "@t3tools/client-runtime/state/server";
import {
  PROVIDER_DISPLAY_NAMES,
  type EnvironmentId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeOperation,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { cliReleaseChannelOf } from "@t3tools/shared/cliRelease";

import {
  collectProviderUpdateCandidates,
  hasOneClickUpdateProviderCandidate,
  isProviderUpdateActive,
} from "~/components/ProviderUpdateLaunchNotification.logic";
import type { ServerUpdateTarget } from "~/components/ServerUpdateAction";
import {
  currentConfirmedServerTargets,
  type UpdateEverythingMachine,
  type UpdateEverythingRun,
} from "~/components/sidebar/updateEverything.logic";
import {
  isManagedRuntimeUpdateCandidate,
  type ManagedRuntimeUpdateRun,
  type ManagedRuntimeUpdateTarget,
} from "~/scient/providerConnection/ManagedRuntimeUpdateNotification.logic";
import {
  resolveServerSelfUpdateCapability,
  resolveVersionMismatch,
  supportsDesktopAppUpdate,
} from "~/versionSkew";

/**
 * An SSH remote this app launches from its own pinned server package. It cannot update itself;
 * the next connection after this app updates launches the matching package.
 */
export function isSelfUpdatingSshRemote(environment: {
  readonly entry: { readonly target: { readonly _tag: string } };
  readonly serverConfig: Pick<ServerConfig, "environment"> | null;
}): boolean {
  return (
    environment.entry.target._tag === "SshConnectionTarget" &&
    environment.serverConfig !== null &&
    resolveServerSelfUpdateCapability(environment.serverConfig) === null
  );
}

/**
 * A pass is running while it has unsettled work or still owns this app's update; a finished
 * pass keeps only its failures.
 */
export function isUpdateRunActive(run: UpdateEverythingRun | null): boolean {
  return (
    run !== null &&
    (run.localVersion !== null ||
      run.phase !== "servers" ||
      run.machines.some((machine) => machine.result === null))
  );
}

interface OtherUpdateItemBase {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly name: string;
  /** The machine it runs on, unless that is this app's own. */
  readonly machine: string | null;
  readonly fromVersion: string | null;
  readonly toVersion: string | null;
  /** Updated outside Scient, so the card offers no action. */
  readonly manual: boolean;
}

export type OtherUpdateItem =
  | (OtherUpdateItemBase & {
      readonly kind: "provider";
      readonly driver: ProviderDriverKind;
      readonly instanceId: ProviderInstanceId;
    })
  | (OtherUpdateItemBase & {
      readonly kind: "managed";
      readonly target: ManagedRuntimeUpdateTarget;
    })
  | (OtherUpdateItemBase & { readonly kind: "server"; readonly target: ServerUpdateTarget | null });

export interface OtherUpdatesMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** This app's own machine, which rows do not name. */
  readonly isLocal: boolean;
  readonly providers: ReadonlyArray<ServerProvider>;
}

const TERMINAL_RUNTIME_STATUSES = new Set<ProviderRuntimeOperation["status"]>([
  "succeeded",
  "failed",
  "cancelled",
]);

function providerName(provider: Pick<ServerProvider, "driver" | "displayName">): string {
  return PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.displayName ?? provider.driver;
}

function activeRuntimeUpdate(provider: ServerProvider): ProviderRuntimeOperation | null {
  const operation = provider.connection?.runtime?.operation ?? null;
  return operation?.action === "update" && !TERMINAL_RUNTIME_STATUSES.has(operation.status)
    ? operation
    : null;
}

/**
 * Provider CLI advisories and Scient-managed runtimes on each machine, one row per driver. A
 * provider stays listed while it updates, wherever that update started.
 */
export function collectProviderUpdateItems(
  machines: ReadonlyArray<OtherUpdatesMachine>,
): OtherUpdateItem[] {
  return machines.flatMap((machine) => {
    const machineName = machine.isLocal ? null : machine.label;
    const items: OtherUpdateItem[] = collectProviderUpdateCandidates(machine.providers).map(
      (candidate) => ({
        kind: "provider",
        key: `provider:${machine.environmentId}:${candidate.driver}`,
        environmentId: machine.environmentId,
        name: providerName(candidate),
        machine: machineName,
        fromVersion: candidate.version,
        toVersion: candidate.versionAdvisory.latestVersion,
        manual:
          !isProviderUpdateActive(candidate) &&
          !hasOneClickUpdateProviderCandidate(candidate, machine.providers),
        driver: candidate.driver,
        instanceId: candidate.instanceId,
      }),
    );
    const managedDrivers = new Set<ProviderDriverKind>();
    for (const provider of machine.providers) {
      const runtime = provider.connection?.runtime;
      if (
        !runtime ||
        managedDrivers.has(provider.driver) ||
        !(isManagedRuntimeUpdateCandidate(provider) || activeRuntimeUpdate(provider) !== null)
      ) {
        continue;
      }
      managedDrivers.add(provider.driver);
      const toVersion = runtime.availableManagedVersion ?? null;
      items.push({
        kind: "managed",
        key: `managed:${machine.environmentId}:${provider.driver}`,
        environmentId: machine.environmentId,
        name: providerName(provider),
        machine: machineName,
        fromVersion: runtime.managedVersion,
        toVersion,
        manual: false,
        target: {
          environmentId: machine.environmentId,
          environmentLabel: machine.label,
          instanceId: provider.instanceId,
          driver: provider.driver,
          availableVersion: toVersion,
        },
      });
    }
    return items;
  });
}

export interface OtherServerUpdate {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** A remote desktop app, which updates its own server. */
  readonly app: boolean;
  readonly fromVersion: string | null;
  readonly toVersion: string;
  /** Null when the server needs an update outside this card. */
  readonly target: ServerUpdateTarget | null;
}

/**
 * Servers behind this app: those a pass may update, and those only their owner can, which the
 * card names without an action. Servers already updating, unreachable, on another channel, or
 * waiting for a published Scient server are left out, as are SSH remotes that follow this app.
 */
export function collectOtherServerUpdates(input: {
  readonly machines: ReadonlyArray<UpdateEverythingMachine>;
  readonly behind: ReadonlyArray<ServerUpdateTarget>;
  readonly qualified: ReadonlyArray<ServerUpdateTarget>;
  readonly targetVersion: string;
  readonly selfUpdating: ReadonlySet<EnvironmentId>;
}): OtherServerUpdate[] {
  const versions = new Map(
    input.machines.map((machine) => [
      machine.environmentId,
      machine.serverConfig?.environment.serverVersion ?? null,
    ]),
  );
  const entry = (target: ServerUpdateTarget, actionable: boolean): OtherServerUpdate => ({
    environmentId: target.environmentId,
    label: target.serverLabel,
    app: target.selfUpdate === "desktop-managed",
    fromVersion: versions.get(target.environmentId) ?? null,
    toVersion: target.targetVersion,
    target: actionable ? target : null,
  });
  const updates = [
    ...input.qualified.map((target) => entry(target, true)),
    ...input.behind
      .filter((target) => target.selfUpdate === "respawn")
      .map((target) => entry(target, false)),
  ];
  for (const machine of input.machines) {
    const config = machine.serverConfig;
    if (
      config === null ||
      machine.hostedByThisApp ||
      !machine.connected ||
      !machine.canMaintain ||
      machine.updateState.status === "running" ||
      input.selfUpdating.has(machine.environmentId) ||
      resolveVersionMismatch(config.environment.serverVersion, input.targetVersion) === null
    ) {
      continue;
    }
    const selfUpdate = resolveServerSelfUpdateCapability(config);
    const app = selfUpdate === "desktop-managed";
    if (selfUpdate === null) {
      if (
        cliReleaseChannelOf(config.environment.serverVersion) !==
        cliReleaseChannelOf(input.targetVersion)
      ) {
        continue;
      }
    } else if (!app || supportsDesktopAppUpdate(config)) {
      continue;
    }
    updates.push({
      environmentId: machine.environmentId,
      label: machine.label,
      app,
      fromVersion: config.environment.serverVersion,
      toVersion: input.targetVersion,
      target: null,
    });
  }
  return updates;
}

export function serverUpdateItem(update: OtherServerUpdate): OtherUpdateItem {
  return {
    kind: "server",
    key: `server:${update.environmentId}`,
    environmentId: update.environmentId,
    name: `${update.label} ${update.app ? "app" : "server"}`,
    machine: null,
    fromVersion: update.fromVersion,
    toVersion: update.toVersion,
    manual: update.target === null,
    target: update.target,
  };
}

export type OtherUpdateProgress =
  | { readonly percent: number }
  | { readonly phase: "queued" | "downloading" | "installing" | "restarting" };

export type OtherUpdateLive =
  | { readonly status: "idle" | "waiting" | "succeeded" }
  | { readonly status: "active"; readonly progress: OtherUpdateProgress }
  | { readonly status: "failed"; readonly reason: string; readonly targetVersion?: string };

const IDLE: OtherUpdateLive = { status: "idle" };

export function providerUpdateLive(provider: ServerProvider | undefined): OtherUpdateLive {
  const state = provider?.updateState;
  switch (state?.status) {
    case "queued":
      return { status: "active", progress: { phase: "queued" } };
    case "running":
      return { status: "active", progress: { phase: "installing" } };
    case "failed":
      return { status: "failed", reason: state.message ?? "Update failed." };
    case "succeeded":
      return { status: "succeeded" };
    default:
      return IDLE;
  }
}

function runtimeProgress(operation: ProviderRuntimeOperation): OtherUpdateProgress {
  if (
    operation.status === "downloading" &&
    operation.totalBytes !== undefined &&
    operation.downloadedBytes !== undefined
  ) {
    return {
      percent: Math.min(100, Math.floor((operation.downloadedBytes / operation.totalBytes) * 100)),
    };
  }
  switch (operation.status) {
    case "preparing":
    case "downloading":
      return { phase: "downloading" };
    case "activating":
      return { phase: "restarting" };
    default:
      return { phase: "installing" };
  }
}

/** The runtime's own operation, and this client's run of it where one was started here. */
export function managedUpdateLive(
  provider: ServerProvider | undefined,
  run: ManagedRuntimeUpdateRun | undefined,
): OtherUpdateLive {
  const operation = provider?.connection?.runtime?.operation ?? null;
  const update = operation?.action === "update" ? operation : null;
  if (update !== null && !TERMINAL_RUNTIME_STATUSES.has(update.status)) {
    return update.waitingForIdle
      ? { status: "waiting" }
      : { status: "active", progress: runtimeProgress(update) };
  }
  // A later operation started elsewhere supersedes this client's run.
  const ownRun =
    run !== undefined &&
    (update === null || run.operationId === null || run.operationId === update.operationId)
      ? run
      : undefined;
  switch (ownRun?.outcome.status) {
    case "pending":
      return ownRun.waitingMessage !== null
        ? { status: "waiting" }
        : { status: "active", progress: { phase: "downloading" } };
    case "failed":
      return { status: "failed", reason: ownRun.outcome.message };
    case "succeeded":
      return { status: "succeeded" };
    case "cancelled":
      return IDLE;
  }
  if (update?.status === "failed") return { status: "failed", reason: update.message };
  if (update?.status === "succeeded") return { status: "succeeded" };
  return IDLE;
}

export function serverUpdateLive(state: ServerUpdateState): OtherUpdateLive {
  switch (state.status) {
    case "running":
      return {
        status: "active",
        progress: {
          phase:
            state.stage === "resuming"
              ? "restarting"
              : state.stage === "installing"
                ? "installing"
                : "downloading",
        },
      };
    case "failed":
      return { status: "failed", reason: state.message, targetVersion: state.targetVersion };
    case "idle":
      return IDLE;
  }
}

/** A pass's own progress for a row it has not started or is following after a relaunch. */
function updateRunProgress(
  item: OtherUpdateItem,
  run: UpdateEverythingRun | null,
): OtherUpdateProgress | null {
  const machine = run?.machines.find(
    (candidate) => candidate.environmentId === item.environmentId && candidate.result === null,
  );
  if (!run || !machine) return null;
  if (item.kind === "server") {
    if (machine.handedOffVersion !== null) return { phase: "restarting" };
    return machine.server !== null ? { phase: "queued" } : null;
  }
  return item.kind === "provider" &&
    !item.manual &&
    run.phase === "providers" &&
    machine.updatesProviders
    ? { phase: "queued" }
    : null;
}

/** An item seen updating or started here, so it can report "done" once it leaves the list. */
export interface TrackedOtherUpdate {
  readonly item: OtherUpdateItem;
  /** A provider or server update this card started and has not heard back from. */
  readonly action:
    | { readonly status: "pending" }
    | { readonly status: "failed"; readonly reason: string }
    | null;
}

export type OtherUpdateRowState =
  | { readonly status: "idle" | "waiting" | "done" }
  | { readonly status: "updating"; readonly progress: OtherUpdateProgress }
  | { readonly status: "failed"; readonly reason: string; readonly retry: boolean };

export interface OtherUpdateRow {
  readonly item: OtherUpdateItem;
  readonly state: OtherUpdateRowState;
}

const STARTING_PROGRESS: Record<OtherUpdateItem["kind"], OtherUpdateProgress> = {
  provider: { phase: "installing" },
  managed: { phase: "downloading" },
  server: { phase: "downloading" },
};

/**
 * The server target a Retry sends: the attempted version and mechanism, while that is still
 * qualified now, with its current flags. A changed version or mechanism is a new update.
 */
export function serverRetryTarget(
  attempted: OtherUpdateItem,
  failedVersion: string | undefined,
  qualified: ReadonlyArray<ServerUpdateTarget>,
): ServerUpdateTarget | null {
  if (attempted.kind !== "server" || attempted.target === null) return null;
  const confirmed =
    failedVersion === undefined
      ? attempted.target
      : { ...attempted.target, targetVersion: failedVersion };
  return currentConfirmedServerTargets([confirmed], qualified)[0] ?? null;
}

export function deriveOtherUpdateRowState(input: {
  readonly item: OtherUpdateItem;
  readonly listed: boolean;
  readonly live: OtherUpdateLive;
  readonly tracked: TrackedOtherUpdate | undefined;
  readonly runProgress: OtherUpdateProgress | null;
  readonly qualifiedServers: ReadonlyArray<ServerUpdateTarget>;
}): OtherUpdateRowState | null {
  const { item, listed, live, tracked } = input;
  if (live.status === "active") return { status: "updating", progress: live.progress };
  if (tracked?.action?.status === "pending") {
    return { status: "updating", progress: STARTING_PROGRESS[item.kind] };
  }
  if (input.runProgress !== null) return { status: "updating", progress: input.runProgress };
  if (live.status === "waiting") return { status: "waiting" };

  const failure =
    tracked?.action?.status === "failed"
      ? { reason: tracked.action.reason, targetVersion: undefined }
      : live.status === "failed"
        ? live
        : null;
  if (failure !== null) {
    if (item.kind === "server") {
      // A failure for another version than the one now offered is history, not this update.
      const stale =
        listed &&
        failure.targetVersion !== undefined &&
        item.target !== null &&
        item.target.targetVersion !== failure.targetVersion;
      if (!stale) {
        const attempted = tracked?.item ?? item;
        return {
          status: "failed",
          reason: failure.reason,
          retry:
            serverRetryTarget(attempted, failure.targetVersion, input.qualifiedServers) !== null,
        };
      }
    } else {
      // A provider that left the list for another reason no longer needs this update.
      return listed ? { status: "failed", reason: failure.reason, retry: !item.manual } : null;
    }
  }
  if (tracked !== undefined && (!listed || live.status === "succeeded")) return { status: "done" };
  return listed ? { status: "idle" } : null;
}

export function buildOtherUpdateRows(input: {
  readonly items: ReadonlyArray<OtherUpdateItem>;
  readonly tracked: ReadonlyMap<string, TrackedOtherUpdate>;
  readonly liveOf: (item: OtherUpdateItem) => OtherUpdateLive;
  readonly run: UpdateEverythingRun | null;
  readonly qualifiedServers: ReadonlyArray<ServerUpdateTarget>;
}): OtherUpdateRow[] {
  const listed = new Set(input.items.map((item) => item.key));
  const items = [
    ...input.items,
    ...[...input.tracked.values()].map(({ item }) => item).filter((item) => !listed.has(item.key)),
  ];
  return items.flatMap((item) => {
    const state = deriveOtherUpdateRowState({
      item,
      listed: listed.has(item.key),
      live: input.liveOf(item),
      tracked: input.tracked.get(item.key),
      runProgress: updateRunProgress(item, input.run),
      qualifiedServers: input.qualifiedServers,
    });
    return state === null ? [] : [{ item, state }];
  });
}

function itemSnapshotKey(item: OtherUpdateItem): string {
  const target = item.kind === "server" ? item.target : null;
  return [item.fromVersion, item.toVersion, target?.targetVersion, target?.selfUpdate].join("|");
}

/**
 * Starts tracking rows seen updating, so they report "done" after they leave the list. While a
 * row updates its snapshot follows the item, so the versions shown are the ones it updates. An
 * item that no longer has a row is forgotten. Returns null when nothing changed.
 */
export function trackUpdatingRows(
  tracked: ReadonlyMap<string, TrackedOtherUpdate>,
  rows: ReadonlyArray<OtherUpdateRow>,
  listed: ReadonlySet<string>,
): ReadonlyMap<string, TrackedOtherUpdate> | null {
  let next: Map<string, TrackedOtherUpdate> | null = null;
  for (const { item, state } of rows) {
    if ((state.status !== "updating" && state.status !== "waiting") || !listed.has(item.key)) {
      continue;
    }
    const existing = tracked.get(item.key);
    if (existing && itemSnapshotKey(existing.item) === itemSnapshotKey(item)) continue;
    next ??= new Map(tracked);
    next.set(item.key, { item, action: existing?.action ?? null });
  }
  const shown = new Set(rows.map(({ item }) => item.key));
  for (const key of tracked.keys()) {
    if (shown.has(key)) continue;
    next ??= new Map(tracked);
    next.delete(key);
  }
  return next;
}

export type OtherUpdatesCircleState = "idle" | "updating" | "failed" | "done";

export function otherUpdatesCircleState(
  rows: ReadonlyArray<OtherUpdateRow>,
): OtherUpdatesCircleState | null {
  const statuses = new Set(rows.map(({ state }) => state.status));
  if (statuses.has("updating")) return "updating";
  if (statuses.has("failed")) return "failed";
  if (statuses.has("idle") || statuses.has("waiting")) return "idle";
  return statuses.has("done") ? "done" : null;
}

export function otherUpdateProgressLabel(progress: OtherUpdateProgress): string {
  return "percent" in progress ? `${progress.percent}%` : progress.phase;
}

export function otherUpdateVersionLabel(item: OtherUpdateItem): string | null {
  if (item.fromVersion !== null && item.toVersion !== null) {
    return `${item.fromVersion} → ${item.toVersion}`;
  }
  return item.toVersion ?? item.fromVersion;
}
