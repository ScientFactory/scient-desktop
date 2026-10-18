import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import { APP_VERSION } from "~/branding";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useDesktopUpdateState } from "~/state/desktopUpdate";
import { serverEnvironment } from "~/state/server";
import { resolveVersionMismatch } from "~/versionSkew";
import type { ServerUpdateOutcome, ServerUpdateTarget } from "../ServerUpdateAction";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  closeFinishedUpdateRun,
  getUpdateEverythingToastView,
  isServerUpdateHandedOff,
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
): void {
  const confirmed = (appAtomRegistry.get(updateEverythingRunAtom)?.machines ?? []).flatMap(
    (machine) =>
      machine.result === "failed" && machine.server !== null
        ? [{ target: machine.server, providerFailure: machine.providerFailure }]
        : [],
  );
  // SCIENT-FORK:START — a retry keeps its confirmed version and mechanism, takes the current
  // flags, and never sends a target that is no longer qualified. A withdrawn target settles
  // as failed with its confirmed target, so Retry returns once it is eligible again.
  const eligible = new Map(
    currentConfirmedServerTargets(
      confirmed.map(({ target }) => target),
      appAtomRegistry.get(qualifiedUpdateRunServersAtom),
    ).map((target) => [target.environmentId, target]),
  );
  const withdrawn = new Set(
    confirmed.flatMap(({ target }) =>
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
  const failed = confirmed.flatMap(({ target, providerFailure }) => {
    const current = eligible.get(target.environmentId);
    return current === undefined ? [] : [{ target: current, providerFailure }];
  });
  // SCIENT-FORK:END
  const targets = failed.map(({ target }) => target);
  const retried = new Set(targets.map((target) => target.environmentId));
  const startedAt = Date.now();
  updateRunMachines((machine) =>
    retried.has(machine.environmentId)
      ? { ...machine, result: null, failure: null, startedAt }
      : machine,
  );
  for (const { target, providerFailure } of failed) {
    void update(target, { quiet: true }).then((outcome) =>
      settleUpdateRunMachine(
        target.environmentId,
        outcome.status === "updated"
          ? providerFailure
          : outcome.status === "failed"
            ? outcome.message
            : "Could not start the update",
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
});
type HandedOffServer = typeof HandedOffServer.Type;

const SavedResult = Schema.Struct({
  savedAt: Schema.Number,
  localVersion: Schema.NullOr(Schema.String),
  updatedServers: Schema.Number,
  updatedProviders: Schema.Number,
  failures: Schema.Array(Schema.String),
  handedOff: Schema.optional(Schema.Array(HandedOffServer)),
});
const decodeSavedResult = Schema.decodeUnknownOption(Schema.fromJsonString(SavedResult));

export function saveUpdateEverythingResult(result: UpdateEverythingResult): void {
  const run = appAtomRegistry.get(updateEverythingRunAtom);
  const handedOff = (run?.machines ?? []).flatMap((machine): HandedOffServer[] => {
    if (machine.result !== null) return [];
    const state = appAtomRegistry.get(serverEnvironment.updateStateAtom(machine.environmentId));
    // A desktop-managed server installs its own feed's version, which only its
    // update state knows.
    const targetVersion =
      machine.handedOffVersion ??
      (state.status === "running" ? state.targetVersion : machine.server?.targetVersion);
    if (targetVersion === undefined) return [];
    return [
      {
        environmentId: machine.environmentId,
        label: machine.label,
        targetVersion,
        startedAt: machine.startedAt,
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

function followHandedOffServers(servers: ReadonlyArray<HandedOffServer>): void {
  if (servers.length === 0) return;
  setUpdateEverythingRun(() => ({
    localVersion: null,
    phase: "servers",
    restartAt: null,
    machines: servers.map((server) => ({
      environmentId: server.environmentId,
      label: server.label,
      updatesProviders: false,
      server: null,
      handedOffVersion: server.targetVersion,
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
    let settled = false;
    const settle = (failure: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      queueMicrotask(() => unsubscribe());
      settleUpdateRunMachine(server.environmentId, failure);
      if (failure === null) updatedServers += 1;
      else failures.push(`${server.label}: ${failure}`);
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
      () => settle(`Not back after ${HANDOFF_TIMEOUT_MS / 60_000} minutes`),
      server.startedAt + HANDOFF_TIMEOUT_MS - Date.now(),
    );
    const unsubscribe = appAtomRegistry.subscribe(
      serverEnvironment.configValueAtom(server.environmentId),
      (config) => {
        if (
          config !== null &&
          resolveVersionMismatch(config.environment.serverVersion, server.targetVersion) === null
        ) {
          settle(null);
        }
      },
      { immediate: true },
    );
  }
}

let notifiedNotAppliedVersion: string | null = null;

export function DesktopUpdateLaunchNotice() {
  const notAppliedVersion = useDesktopUpdateState()?.notAppliedVersion ?? null;

  useEffect(() => {
    const saved = takeSavedUpdateEverythingResult();
    if (!saved) return;
    const handedOff = saved.handedOff ?? [];
    showUpdateEverythingResult({ ...saved, restarting: handedOff.map((server) => server.label) });
    followHandedOffServers(handedOff);
  }, []);

  useEffect(() => {
    if (notAppliedVersion === null || notifiedNotAppliedVersion === notAppliedVersion) return;
    notifiedNotAppliedVersion = notAppliedVersion;
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Update did not apply",
        // SCIENT-FORK:START — Scient product name.
        description: `Scient is still on ${APP_VERSION}. Install ${notAppliedVersion} again from the update button.`,
        // SCIENT-FORK:END
      }),
    );
  }, [notAppliedVersion]);

  return null;
}
