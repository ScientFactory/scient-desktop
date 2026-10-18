import { useAtomValue } from "@effect/atom-react";
import {
  PROVIDER_DISPLAY_NAMES,
  type EnvironmentId,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { hiddenToastActionProps, stackedThreadToast, toastManager } from "~/components/ui/toast";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useEnvironments } from "~/state/environments";
import { watchEnvironmentProviders } from "./environmentUpdateWatch";
import {
  collectManagedRuntimeUpdateCandidates,
  getManagedRuntimeUpdateResultToastView,
  getManagedRuntimeUpdateRunningToastView,
  getManagedRuntimeUpdateWaitingToastView,
  managedRuntimeUpdateStartFailure,
  managedRuntimeUpdateTargetKey,
  managedRuntimeUpdateTargets,
  resolveManagedRuntimeUpdateOutcome,
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

interface InFlightUpdate {
  /** Active, failed, or staged to switch when the provider is idle. */
  readonly handedOff: Promise<void>;
}

/** One start per runtime: later callers join the update already starting or running, until it is active or failed. */
const inFlightUpdates = new Map<string, InFlightUpdate>();

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function lostContact(run: ManagedRuntimeUpdateRun): ManagedRuntimeUpdateRun {
  return {
    ...run,
    waitingMessage: null,
    outcome: resolveManagedRuntimeUpdateOutcome({
      provider: undefined,
      operationId: run.operationId ?? "",
      observed: run.observed,
      expectedVersion: run.target.availableVersion,
    }),
  };
}

/**
 * Follows a started update in its machine's provider snapshots until the runtime is active or
 * failed. A machine that is removed, or stays out of contact past the grace period, fails it.
 */
function followManagedRuntimeUpdate(
  key: string,
  run: ManagedRuntimeUpdateRun,
  handedOff: () => void,
  settled: () => void,
): void {
  const operationId = run.operationId;
  const stop = watchEnvironmentProviders(run.target.environmentId, (snapshot) => {
    const current = readRun(key);
    if (current?.operationId !== operationId || current.outcome.status !== "pending") {
      // The first snapshot can arrive before `stop` is assigned.
      queueMicrotask(() => stop());
      settled();
      return;
    }
    const next =
      snapshot.status === "connected"
        ? settleManagedRuntimeUpdateRuns(
            [current],
            [{ environmentId: current.target.environmentId, providers: snapshot.providers }],
          )[0]!
        : lostContact(current);
    if (
      next.outcome.status !== current.outcome.status ||
      next.observed !== current.observed ||
      next.waitingMessage !== current.waitingMessage
    ) {
      writeRun(key, next);
    }
    if (next.outcome.status !== "pending") {
      queueMicrotask(() => stop());
      settled();
    } else if (next.waitingMessage !== null) {
      handedOff();
    }
  });
}

/** Shows a started batch's progress, then its result; `afterHandoff` only for staged runtimes. */
function reportManagedRuntimeUpdates(
  started: ReadonlyArray<{ readonly key: string; readonly flight: InFlightUpdate }>,
  afterHandoff: boolean,
): void {
  void (async () => {
    if (afterHandoff) await Promise.all(started.map(({ flight }) => flight.handedOff));
    const keys = started
      .map(({ key }) => key)
      .filter((key) => !afterHandoff || readRun(key)?.outcome.status === "pending");
    if (keys.length === 0) return;
    const runs = () => keys.flatMap((key) => readRun(key) ?? []);
    const progressView = () => {
      const current = runs();
      const waiting = current.find(({ waitingMessage }) => waitingMessage !== null);
      const targets = current.map(({ target }) => target);
      return waiting
        ? getManagedRuntimeUpdateWaitingToastView(targets, waiting.waitingMessage!)
        : getManagedRuntimeUpdateRunningToastView(targets);
    };
    const pending = () => runs().some(({ outcome }) => outcome.status === "pending");
    let progressId: string | null = null;
    let shownTitle: string | null = null;
    const showProgress = () => {
      const view = progressView();
      if (view.title === shownTitle) return;
      shownTitle = view.title;
      if (progressId === null) {
        progressId = toastManager.add({
          type: view.type,
          title: view.title,
          description: view.description,
          timeout: 0,
          actionProps: hiddenToastActionProps,
          data: { hideCopyButton: true },
        });
      } else {
        toastManager.update(progressId, { title: view.title, description: view.description });
      }
    };
    if (pending()) {
      showProgress();
      await new Promise<void>((resolve) => {
        const unsubscribe = appAtomRegistry.subscribe(
          managedRuntimeUpdateRunsAtom,
          () => {
            if (pending()) {
              showProgress();
              return;
            }
            queueMicrotask(() => unsubscribe());
            resolve();
          },
          { immediate: true },
        );
      });
    }
    if (progressId !== null) toastManager.close(progressId);
    const view = getManagedRuntimeUpdateResultToastView(
      runs().flatMap(({ target, outcome }) =>
        outcome.status === "pending" ? [] : [{ target, outcome }],
      ),
    );
    if (view === null) return;
    if (view.type === "success") {
      toastManager.add({
        type: view.type,
        title: view.title,
        description: view.description,
        timeout: 0,
        actionProps: hiddenToastActionProps,
        data: {
          hideCopyButton: true,
          ...(view.dismissAfterVisibleMs !== undefined
            ? { dismissAfterVisibleMs: view.dismissAfterVisibleMs }
            : {}),
        },
      });
      return;
    }
    toastManager.add(
      stackedThreadToast({ type: view.type, title: view.title, description: view.description }),
    );
  })();
}

/** This client's runs on a machine, read when a server update is about to start. */
export function managedRuntimeRunsOn(environmentId: EnvironmentId): ManagedRuntimeUpdateRun[] {
  return [...appAtomRegistry.get(managedRuntimeUpdateRunsAtom).values()].filter(
    (run) => run.target.environmentId === environmentId,
  );
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
 * at a time, since each machine's runtime manager serializes a driver, joins any already in
 * flight, and resolves with their runs once each is active, failed, or staged to switch when
 * idle. A pass reports its own summary, so `inPass` leaves only staged runtimes to report here.
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
    { inPass = false }: { readonly inPass?: boolean } = {},
  ): Promise<ManagedRuntimeUpdateRun[]> => {
    const keys: string[] = [];
    const joined: Array<Promise<void>> = [];
    const started: Array<{ key: string; flight: InFlightUpdate }> = [];
    for (const target of requested) {
      const key = managedRuntimeUpdateTargetKey(target);
      keys.push(key);
      const existing = inFlightUpdates.get(key);
      if (existing) {
        joined.push(existing.handedOff);
        continue;
      }
      const handedOff = deferred();
      const settled = deferred();
      const flight: InFlightUpdate = { handedOff: handedOff.promise };
      inFlightUpdates.set(key, flight);
      void settled.promise.then(() => {
        if (inFlightUpdates.get(key) === flight) inFlightUpdates.delete(key);
      });
      const finish = () => {
        handedOff.resolve();
        settled.resolve();
      };
      started.push({ key, flight });
      const starting: ManagedRuntimeUpdateRun = {
        target,
        operationId: null,
        observed: false,
        outcome: { status: "pending" },
        waitingMessage: null,
      };
      writeRun(key, starting);
      const run: ManagedRuntimeUpdateRun = {
        ...starting,
        ...(await startRuntimeAction({
          environmentId: target.environmentId,
          instanceId: target.instanceId,
          action: "update",
        }).then(startedManagedRuntimeUpdate, (error: unknown) => ({
          operationId: null,
          outcome: managedRuntimeUpdateStartFailure(error),
        }))),
      };
      writeRun(key, run);
      if (run.operationId !== null && run.outcome.status === "pending") {
        followManagedRuntimeUpdate(key, run, handedOff.resolve, finish);
      } else {
        finish();
      }
    }
    if (started.length > 0) reportManagedRuntimeUpdates(started, inPass);
    await Promise.all([...joined, ...started.map(({ flight }) => flight.handedOff)]);
    return keys.flatMap((key) => readRun(key) ?? []);
  };

  return { candidates, targets, runs, update };
}
