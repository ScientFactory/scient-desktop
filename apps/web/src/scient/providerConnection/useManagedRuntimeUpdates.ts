import { useAtomValue } from "@effect/atom-react";
import {
  PROVIDER_DISPLAY_NAMES,
  type EnvironmentId,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useEnvironments } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import {
  collectManagedRuntimeUpdateCandidates,
  managedRuntimeUpdateStartFailure,
  managedRuntimeUpdateTargetKey,
  managedRuntimeUpdateTargets,
  settleManagedRuntimeUpdateRuns,
  startedManagedRuntimeUpdate,
  type ManagedRuntimeUpdateRun,
  type ManagedRuntimeUpdateTarget,
} from "./ManagedRuntimeUpdateNotification.logic";
import { useStartProviderRuntimeAction } from "./useProviderLifecycleController";

export interface ProviderEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly providers: ReadonlyArray<ServerProvider>;
}

/** Providers of every connected machine; Scient manages runtimes wherever it reaches a server. */
export function connectedProviderEnvironments(
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly connection: { readonly phase: string };
    readonly serverConfig: Pick<ServerConfig, "providers"> | null;
  }>,
): ProviderEnvironment[] {
  return environments.flatMap((environment) =>
    environment.connection.phase === "connected" && environment.serverConfig !== null
      ? [
          {
            environmentId: environment.environmentId,
            label: environment.label,
            providers: environment.serverConfig.providers,
          },
        ]
      : [],
  );
}

/** Started updates by runtime, so every reader sees one run per machine and driver. */
const managedRuntimeUpdateRunsAtom = Atom.make<ReadonlyMap<string, ManagedRuntimeUpdateRun>>(
  new Map(),
).pipe(Atom.keepAlive, Atom.withLabel("scient-managed-runtime-update-runs"));

function writeRun(key: string, run: ManagedRuntimeUpdateRun): void {
  appAtomRegistry.update(managedRuntimeUpdateRunsAtom, (runs) => new Map(runs).set(key, run));
}

function readRun(key: string): ManagedRuntimeUpdateRun | undefined {
  return appAtomRegistry.get(managedRuntimeUpdateRunsAtom).get(key);
}

/**
 * Follows a started update in its machine's provider snapshots. Resolves once the runtime is
 * active or failed, or once the server has staged it to switch when the provider is idle: the
 * switch then needs nothing more from the client.
 */
function followManagedRuntimeUpdate(
  key: string,
  environmentId: EnvironmentId,
  operationId: string,
): Promise<void> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      queueMicrotask(() => unsubscribe());
      resolve();
    };
    const unsubscribe = appAtomRegistry.subscribe(
      serverEnvironment.configValueAtom(environmentId),
      (config) => {
        const current = readRun(key);
        if (current?.operationId !== operationId || current.outcome.status !== "pending") {
          finish();
          return;
        }
        // A missing snapshot is no news; a provider missing from a snapshot is.
        if (config === null) return;
        const [next] = settleManagedRuntimeUpdateRuns(
          [current],
          [{ environmentId, providers: config.providers }],
        );
        if (
          next!.outcome.status !== current.outcome.status ||
          next!.observed !== current.observed ||
          next!.waitingMessage !== current.waitingMessage
        ) {
          writeRun(key, next!);
        }
        if (next!.outcome.status !== "pending") {
          finish();
        } else if (next!.waitingMessage !== null) {
          resolve();
        }
      },
      { immediate: true },
    );
  });
}

export type ManagedRuntimeUpdateRunOutcome =
  | { readonly status: "updated" | "interrupted" }
  | { readonly status: "failed"; readonly line: string };

/** Summary outcomes for a pass; a runtime staged to switch when idle is neither. */
export function managedRuntimeRunOutcomes(
  runs: ReadonlyArray<ManagedRuntimeUpdateRun>,
): ManagedRuntimeUpdateRunOutcome[] {
  return runs.flatMap((run): ManagedRuntimeUpdateRunOutcome[] => {
    switch (run.outcome.status) {
      case "pending":
        return [];
      case "succeeded":
        return [{ status: "updated" }];
      case "cancelled":
        return [{ status: "interrupted" }];
      case "failed": {
        const name = PROVIDER_DISPLAY_NAMES[run.target.driver] ?? run.target.driver;
        return [
          {
            status: "failed",
            line: `${run.target.environmentLabel} · ${name}: ${run.outcome.message}`,
          },
        ];
      }
    }
  });
}

/** The machines and runtime names a pass would update, as the confirmation lists them. */
export function managedRuntimeProviderMachines(
  targets: ReadonlyArray<ManagedRuntimeUpdateTarget>,
): Array<{ environmentId: EnvironmentId; label: string; providers: string[] }> {
  const machines = new Map<
    EnvironmentId,
    { environmentId: EnvironmentId; label: string; providers: string[] }
  >();
  for (const target of targets) {
    const machine = machines.get(target.environmentId) ?? {
      environmentId: target.environmentId,
      label: target.environmentLabel,
      providers: [],
    };
    machine.providers.push(PROVIDER_DISPLAY_NAMES[target.driver] ?? target.driver);
    machines.set(target.environmentId, machine);
  }
  return [...machines.values()];
}

/**
 * Reviewed Scient-managed runtime updates on every connected machine. `update` starts them one
 * at a time, since each machine's runtime manager serializes a driver, and resolves with their
 * runs once each is active, failed, or staged to switch when idle.
 */
export function useManagedRuntimeUpdates() {
  const { environments } = useEnvironments();
  const startRuntimeAction = useStartProviderRuntimeAction();
  const runs = useAtomValue(managedRuntimeUpdateRunsAtom);
  const candidates = collectManagedRuntimeUpdateCandidates(
    connectedProviderEnvironments(environments),
  );
  const targets = managedRuntimeUpdateTargets(candidates);

  const update = async (
    requested: ReadonlyArray<ManagedRuntimeUpdateTarget>,
  ): Promise<ManagedRuntimeUpdateRun[]> => {
    const followed: Array<Promise<void>> = [];
    const keys: string[] = [];
    for (const target of requested) {
      const key = managedRuntimeUpdateTargetKey(target);
      keys.push(key);
      if (readRun(key)?.outcome.status === "pending") continue;
      const starting: ManagedRuntimeUpdateRun = {
        target,
        operationId: null,
        observed: false,
        outcome: { status: "pending" },
        waitingMessage: null,
      };
      writeRun(key, starting);
      const started = await startRuntimeAction({
        environmentId: target.environmentId,
        instanceId: target.instanceId,
        action: "update",
      }).then(startedManagedRuntimeUpdate, (error: unknown) => ({
        operationId: null,
        outcome: managedRuntimeUpdateStartFailure(error),
      }));
      writeRun(key, { ...starting, ...started });
      if (started.operationId !== null && started.outcome.status === "pending") {
        followed.push(followManagedRuntimeUpdate(key, target.environmentId, started.operationId));
      }
    }
    await Promise.all(followed);
    return keys.flatMap((key) => {
      const run = readRun(key);
      return run ? [run] : [];
    });
  };

  return { candidates, targets, runs, update };
}
