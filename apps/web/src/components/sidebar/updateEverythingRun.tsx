import { useAtomValue } from "@effect/atom-react";
import { AVAILABLE_CONNECTION_STATE } from "@t3tools/client-runtime/connection";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  ServerUpdateTerminalError,
  nudgeReconnectDuringUpdateRestart,
  serverUpdateStateAtom,
} from "@t3tools/client-runtime/state/server";
import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
// SCIENT-FORK: the handoff record keeps the confirmed update mechanism.
import { ServerSelfUpdateCapability } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { msg } from "gt-react";

import { APP_VERSION } from "~/branding";
import { environmentCatalog } from "~/connection/catalog";
import { m } from "~/i18n/messages";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { desktopUpdateStateAtom } from "~/state/desktopUpdate";
import { serverEnvironment } from "~/state/server";
import { resolveVersionMismatch } from "~/versionSkew";
import type { ServerUpdateOutcome, ServerUpdateTarget } from "../ServerUpdateAction";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  closeFinishedUpdateRun,
  getUpdateEverythingToastView,
  isServerUpdateHandedOff,
  type RestoredRetry,
  type UpdateEverythingResult,
  type UpdateEverythingRun,
  type UpdateRunMachine,
} from "./updateEverything.logic";
// SCIENT-FORK:START — a retry rechecks eligibility, like a server step that starts.
import * as Equal from "effect/Equal";
import { currentConfirmedServerTargets } from "./updateEverything.logic";
// SCIENT-FORK:END

const updateEverythingRunAtom = Atom.make<UpdateEverythingRun | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("update-everything-run"),
);

export function useUpdateEverythingRun(): UpdateEverythingRun | null {
  return useAtomValue(updateEverythingRunAtom);
}

export function setUpdateEverythingRun(
  update: (run: UpdateEverythingRun | null) => UpdateEverythingRun | null,
): void {
  appAtomRegistry.update(updateEverythingRunAtom, update);
}

function updateRunMachines(update: (machine: UpdateRunMachine) => UpdateRunMachine): void {
  setUpdateEverythingRun(
    (run) => run && closeFinishedUpdateRun({ ...run, machines: run.machines.map(update) }),
  );
}

export function settleUpdateRunMachine(
  environmentId: EnvironmentId,
  failure: string | null,
  {
    serverUpdated = false,
    providerFailure,
  }: { readonly serverUpdated?: boolean; readonly providerFailure?: string | null } = {},
): void {
  updateRunMachines((machine) =>
    machine.environmentId === environmentId
      ? {
          ...machine,
          result: failure === null ? "done" : "failed",
          failure,
          ...(serverUpdated ? { server: null } : {}),
          ...(providerFailure === undefined ? {} : { providerFailure }),
        }
      : machine,
  );
}

function runsVersion(config: ServerConfig | null, targetVersion: string): boolean {
  return (
    config !== null &&
    resolveVersionMismatch(config.environment.serverVersion, targetVersion) === null
  );
}

// SCIENT-FORK:START — a retry rechecks eligibility, like a server step that starts.
const qualifiedUpdateRunServersAtom = Atom.make<ReadonlyArray<ServerUpdateTarget>>([]).pipe(
  Atom.withEquality(Equal.equals),
  Atom.keepAlive,
  Atom.withLabel("update-everything-qualified-servers"),
);

/** The servers "update everything" currently qualifies; empty once its sidebar owner leaves. */
export function publishQualifiedUpdateRunServers(servers: ReadonlyArray<ServerUpdateTarget>): void {
  appAtomRegistry.set(qualifiedUpdateRunServersAtom, servers);
}

/** The servers "update everything" currently qualifies, so Retry follows eligibility. */
export function useQualifiedUpdateRunServers(): ReadonlyArray<ServerUpdateTarget> {
  return useAtomValue(qualifiedUpdateRunServersAtom);
}

const WITHDRAWN_RETRY_FAILURE = "Not retried; it is not currently eligible for this update.";
// SCIENT-FORK:END

export function retryFailedUpdateRunServers(
  update: (
    target: ServerUpdateTarget,
    options: { readonly quiet: boolean },
  ) => Promise<ServerUpdateOutcome>,
  restored: ReadonlyMap<EnvironmentId, RestoredRetry> = new Map(),
): void {
  const failed = (appAtomRegistry.get(updateEverythingRunAtom)?.machines ?? []).flatMap(
    (machine) => {
      const target = machine.server ?? restored.get(machine.environmentId);
      const targetVersion = target === "current" ? machine.handedOffVersion : target?.targetVersion;
      return machine.result === "failed" && target !== undefined && targetVersion
        ? [
            {
              environmentId: machine.environmentId,
              target,
              targetVersion,
              providerFailure: machine.providerFailure,
            },
          ]
        : [];
    },
  );
  const pending: Array<{ target: ServerUpdateTarget; providerFailure: string | null }> = [];
  for (const { environmentId, target, targetVersion, providerFailure } of failed) {
    // The host rejects a same-version update; a server that came back on the target is done.
    if (
      runsVersion(
        appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId)),
        targetVersion,
      )
    ) {
      settleUpdateRunMachine(environmentId, providerFailure, { serverUpdated: true });
    } else if (target !== "current") {
      pending.push({ target, providerFailure });
    }
  }
  // SCIENT-FORK:START — a retry keeps its confirmed version and mechanism, takes the current
  // flags, and never sends a target that is no longer qualified. A withdrawn target settles
  // as failed with its confirmed target, so Retry returns once it is eligible again.
  const eligible = new Map(
    currentConfirmedServerTargets(
      pending.map(({ target }) => target),
      appAtomRegistry.get(qualifiedUpdateRunServersAtom),
    ).map((target) => [target.environmentId, target]),
  );
  const withdrawn = new Set(
    pending.flatMap(({ target }) =>
      eligible.has(target.environmentId) ? [] : [target.environmentId],
    ),
  );
  if (withdrawn.size > 0) {
    updateRunMachines((machine) =>
      withdrawn.has(machine.environmentId)
        ? { ...machine, result: "failed", failure: WITHDRAWN_RETRY_FAILURE }
        : machine,
    );
  }
  const eligiblePending = pending.flatMap(({ target, providerFailure }) => {
    const current = eligible.get(target.environmentId);
    return current === undefined ? [] : [{ target: current, providerFailure }];
  });
  // SCIENT-FORK:END
  const retried = new Map(eligiblePending.map(({ target }) => [target.environmentId, target]));
  const startedAt = Date.now();
  updateRunMachines((machine) => {
    const target = retried.get(machine.environmentId);
    return target === undefined
      ? machine
      : {
          ...machine,
          server: target,
          handedOffVersion: null,
          result: null,
          failure: null,
          startedAt,
        };
  });
  for (const { target, providerFailure } of eligiblePending /* SCIENT-FORK: eligible targets */) {
    void update(target, { quiet: true }).then((outcome) =>
      settleUpdateRunMachine(
        target.environmentId,
        outcome.status === "updated"
          ? providerFailure
          : outcome.status === "failed"
            ? outcome.message
            : m(msg("Could not start the update")),
        { serverUpdated: outcome.status === "updated" },
      ),
    );
  }
}

export function dismissSettledUpdateRunMachines(): void {
  setUpdateEverythingRun(
    (run) =>
      run &&
      closeFinishedUpdateRun({
        ...run,
        machines: run.machines.filter((machine) => machine.result === null),
      }),
  );
}

export function waitForServerUpdateHandoff(
  environmentId: EnvironmentId,
  finished: Promise<unknown>,
): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      queueMicrotask(() => unsubscribe());
      resolve();
    };
    const unsubscribe = appAtomRegistry.subscribe(
      serverEnvironment.updateStateAtom(environmentId),
      (state) => {
        if (isServerUpdateHandedOff(state)) finish();
      },
      { immediate: true },
    );
    void finished.then(finish, finish);
  });
}

let decideRestart: ((restart: boolean) => void) | null = null;

export function waitForUpdateRestart(delayMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const decide = (restart: boolean) => {
      clearTimeout(timer);
      decideRestart = null;
      resolve(restart);
    };
    const timer = setTimeout(() => decide(true), delayMs);
    decideRestart = decide;
    setUpdateEverythingRun(
      (run) => run && { ...run, phase: "countdown", restartAt: Date.now() + delayMs },
    );
  });
}

export function postponeUpdateRestart(): void {
  decideRestart?.(false);
}

const SAVED_RESULT_KEY = "t3code:update-everything-result:v1";
const SAVED_RESULT_MAX_AGE_MS = 10 * 60 * 1000;
// Covers a background service's 30-minute trial start, like the server update itself.
const HANDOFF_TIMEOUT_MS = 32 * 60 * 1000;

const HandedOffServer = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  targetVersion: Schema.String,
  startedAt: Schema.Number,
  updateId: Schema.optionalKey(Schema.String),
  // SCIENT-FORK: the confirmed update mechanism; optional so records saved without it decode.
  selfUpdate: Schema.optionalKey(ServerSelfUpdateCapability),
});
type HandedOffServer = typeof HandedOffServer.Type;

const SavedResult = Schema.Struct({
  savedAt: Schema.Number,
  localVersion: Schema.NullOr(Schema.String),
  updatedServers: Schema.Number,
  updatedProviders: Schema.Number,
  failures: Schema.Array(Schema.String),
  handedOff: Schema.optional(Schema.Array(HandedOffServer)),
  // Restored track switches retry through their planner, not the capsule.
  trackSwitch: Schema.optionalKey(Schema.Boolean),
});
const decodeSavedResult = Schema.decodeUnknownOption(Schema.fromJsonString(SavedResult));

export function saveUpdateEverythingResult(result: UpdateEverythingResult): void {
  const run = appAtomRegistry.get(updateEverythingRunAtom);
  const handedOff = (run?.machines ?? []).flatMap((machine): HandedOffServer[] => {
    if (machine.result !== null) return [];
    const state = appAtomRegistry.get(serverEnvironment.updateStateAtom(machine.environmentId));
    // Only the desktop-managed server's update state knows its own feed version.
    const targetVersion =
      machine.handedOffVersion ??
      (state.status === "running" ? state.targetVersion : machine.server?.targetVersion);
    if (targetVersion === undefined) return [];
    const updateId = state.status === "running" ? state.updateId : undefined;
    // SCIENT-FORK: a restored Retry may repeat only the mechanism the user confirmed.
    const selfUpdate = machine.server?.selfUpdate ?? machine.handedOffSelfUpdate ?? undefined;
    return [
      {
        environmentId: machine.environmentId,
        label: machine.label,
        targetVersion,
        startedAt: machine.startedAt,
        ...(updateId === undefined ? {} : { updateId }),
        ...(selfUpdate === undefined ? {} : { selfUpdate }), // SCIENT-FORK: confirmed mechanism
      },
    ];
  });
  try {
    window.localStorage.setItem(
      SAVED_RESULT_KEY,
      JSON.stringify({
        savedAt: Date.now(),
        localVersion: result.localVersion,
        updatedServers: result.updatedServers,
        updatedProviders: result.updatedProviders,
        failures: result.failures,
        handedOff,
        ...(run?.trackSwitch ? { trackSwitch: true } : {}),
      } satisfies typeof SavedResult.Type),
    );
  } catch {}
}

export function clearSavedUpdateEverythingResult(): void {
  try {
    window.localStorage.removeItem(SAVED_RESULT_KEY);
  } catch {}
}

function takeSavedUpdateEverythingResult(): typeof SavedResult.Type | null {
  try {
    const raw = window.localStorage.getItem(SAVED_RESULT_KEY);
    if (raw === null) return null;
    window.localStorage.removeItem(SAVED_RESULT_KEY);
    return Option.getOrNull(
      Option.filter(
        decodeSavedResult(raw),
        (saved) => Date.now() - saved.savedAt < SAVED_RESULT_MAX_AGE_MS,
      ),
    );
  } catch {
    return null;
  }
}

export function showUpdateEverythingResult(result: UpdateEverythingResult): void {
  const view = getUpdateEverythingToastView(result, APP_VERSION);
  if (!view) return;
  toastManager.add(
    stackedThreadToast({
      type: view.type,
      title: view.title,
      ...(view.description
        ? { description: <span className="whitespace-pre-line">{view.description}</span> }
        : {}),
    }),
  );
}

function followHandedOffServers(
  servers: ReadonlyArray<HandedOffServer>,
  trackSwitch: boolean,
): void {
  if (servers.length === 0) return;
  setUpdateEverythingRun(() => ({
    ...(trackSwitch ? { trackSwitch: true } : {}),
    localVersion: null,
    phase: "servers",
    restartAt: null,
    machines: servers.map((server) => ({
      environmentId: server.environmentId,
      label: server.label,
      updatesProviders: false,
      server: null,
      handedOffVersion: server.targetVersion,
      // SCIENT-FORK: the confirmed mechanism, which a restored Retry must match.
      ...(server.selfUpdate === undefined ? {} : { handedOffSelfUpdate: server.selfUpdate }),
      startedAt: server.startedAt,
      result: null,
      failure: null,
      providerFailure: null,
    })),
  }));
  let remaining = servers.length;
  let updatedServers = 0;
  const failures: string[] = [];
  for (const server of servers) {
    // Update state is in memory, so restore it or the relaunched app offers this server's update again.
    const stateAtom = serverUpdateStateAtom(server.environmentId);
    appAtomRegistry.set(stateAtom, {
      status: "running",
      stage: "resuming",
      fromVersion:
        appAtomRegistry.get(serverEnvironment.configValueAtom(server.environmentId))?.environment
          .serverVersion ?? server.targetVersion,
      targetVersion: server.targetVersion,
      ...(server.updateId === undefined ? {} : { updateId: server.updateId }),
    });
    // Nothing observes the atom until the UI mounts, and the registry drops unobserved atoms.
    const releaseState = appAtomRegistry.mount(stateAtom);
    let settled = false;
    const settle = (failure: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopReconnectNudge();
      queueMicrotask(() => {
        unsubscribe();
        unsubscribeOutcome();
      });
      appAtomRegistry.set(stateAtom, { status: "idle" });
      releaseState();
      settleUpdateRunMachine(server.environmentId, failure);
      if (failure === null) updatedServers += 1;
      else failures.push(m(msg("{machine}: {failure}", { machine: server.label, failure })));
      remaining -= 1;
      if (remaining === 0) {
        showUpdateEverythingResult({
          localVersion: null,
          updatedServers,
          updatedProviders: 0,
          failures,
          restarting: [],
        });
      }
    };
    const timer = setTimeout(
      () =>
        settle(
          m(msg("Not back after {minutes} minutes", { minutes: HANDOFF_TIMEOUT_MS / 60_000 })),
        ),
      server.startedAt + HANDOFF_TIMEOUT_MS - Date.now(),
    );
    const stopReconnectNudge = Effect.runCallback(
      nudgeReconnectDuringUpdateRestart({
        stateChanges: AtomRegistry.toStream(
          appAtomRegistry,
          environmentCatalog.stateAtom(server.environmentId),
        ).pipe(
          Stream.map((state) => AsyncResult.getOrElse(state, () => AVAILABLE_CONNECTION_STATE)),
        ),
        retryNow: environmentCatalog.retryNow
          .run(appAtomRegistry, server.environmentId)
          .pipe(Effect.ignoreCause),
      }),
    );
    const unsubscribe = appAtomRegistry.subscribe(
      serverEnvironment.configValueAtom(server.environmentId),
      (config) => {
        if (runsVersion(config, server.targetVersion)) settle(null);
      },
      { immediate: true },
    );
    // A rollback restarts the old version, which the version check above never accepts.
    const unsubscribeOutcome =
      server.updateId === undefined
        ? () => {}
        : appAtomRegistry.subscribe(
            serverEnvironment.updateOutcome({ environmentId: server.environmentId, input: {} }),
            (result) => {
              const outcome = AsyncResult.getOrElse(result, () => null);
              if (
                outcome === null ||
                outcome.id !== server.updateId ||
                outcome.status === "committed"
              ) {
                return;
              }
              const error = new ServerUpdateTerminalError({
                targetVersion: server.targetVersion,
                status: outcome.status,
                ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
              });
              settle(thrownErrorMessage(error, m) ?? error.message);
            },
            { immediate: true },
          );
  }
}

/** Reports, once per launch, how the update run that restarted the app ended. */
export function startDesktopUpdateLaunchNotice(): () => void {
  const saved = takeSavedUpdateEverythingResult();
  if (saved) {
    const handedOff = saved.handedOff ?? [];
    showUpdateEverythingResult({ ...saved, restarting: handedOff.map((server) => server.label) });
    followHandedOffServers(handedOff, saved.trackSwitch === true);
  }

  let notifiedNotAppliedVersion: string | null = null;
  return appAtomRegistry.subscribe(
    desktopUpdateStateAtom,
    (result) => {
      const notAppliedVersion =
        AsyncResult.getOrElse(result, () => null)?.notAppliedVersion ?? null;
      if (notAppliedVersion === null || notifiedNotAppliedVersion === notAppliedVersion) return;
      notifiedNotAppliedVersion = notAppliedVersion;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: m(msg("Update did not apply")),
          description: m(
            msg("Scient is still on {current}. Install {version} again from the update button.", {
              current: APP_VERSION,
              version: notAppliedVersion,
            }),
          ),
        }),
      );
    },
    { immediate: true },
  );
}
