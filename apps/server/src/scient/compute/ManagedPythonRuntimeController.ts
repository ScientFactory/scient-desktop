// @effect-diagnostics nodeBuiltinImport:off -- operation identities use host randomness.
import * as NodeCrypto from "node:crypto";

import {
  ComputeOperationError,
  type ComputeManagedRuntimeAction,
  type ComputeManagedRuntimeFailure,
  type ComputeManagedRuntimeStatus,
  type ComputeManagedToolkitStatus,
  type ComputeToolkitId,
} from "@scientfactory/compute";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import type {
  ComputeManagedRuntimeProvisionOptions,
  ComputeRuntimeBinding,
} from "./ComputeSessionService.ts";
import {
  ManagedPythonEnvironmentError,
  type makeManagedPythonEnvironmentManager,
} from "./ManagedPythonEnvironment.ts";
import {
  MANAGED_PYTHON_PROVISIONER_VERSION,
  MANAGED_PYTHON_TOOLKIT_REVISION,
  MANAGED_PYTHON_VERSION,
} from "./ManagedPythonProvisioner.ts";

type ManagedPythonManager = ReturnType<typeof makeManagedPythonEnvironmentManager>;
const isComputeOperationError = Schema.is(ComputeOperationError);

interface ActiveOperation {
  readonly action: ComputeManagedRuntimeAction;
  readonly controller: AbortController;
  readonly operationId: string;
  readonly startedAt: string;
  phase: NonNullable<ComputeManagedRuntimeStatus["operation"]>["phase"];
  downloadedBytes: number | null;
  totalBytes: number | null;
}

function operationError(message: string, cause?: unknown): ComputeOperationError {
  return new ComputeOperationError({
    operation: "manage",
    reason: "operation-failed",
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function shortMessage(value: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  for (
    let current = value;
    current instanceof Error && messages.length < 3 && !seen.has(current);
    current = current.cause
  ) {
    seen.add(current);
    messages.push(current.message);
  }
  return (messages.join(" ") || "Scientific runtime setup failed.").slice(0, 4096);
}

function managedRuntimeFailure(
  value: unknown,
  action: ComputeManagedRuntimeAction,
  displayName: string,
): ComputeManagedRuntimeFailure {
  const detail = shortMessage(value);
  const reason =
    value instanceof ManagedPythonEnvironmentError && value.reason !== "cancelled"
      ? value.reason
      : "operation-failed";
  const summary = (() => {
    if (action === "remove") return `${displayName} could not be removed`;
    switch (reason) {
      case "invalid-request":
        return `${displayName} setup could not start`;
      case "verification-failed":
        return `${displayName} verification failed`;
      case "activation-failed":
        return `${displayName} could not be activated`;
      case "provision-failed":
      case "operation-failed":
      case "remove-failed":
        return `${displayName} setup failed`;
    }
  })();
  return { reason, action, summary, detail };
}

export function makeManagedPythonRuntimeController(input: {
  readonly manager: ManagedPythonManager;
  /** Every Toolkit this reviewed recipe knows how to provision. */
  readonly toolkitIds: ReadonlyArray<ComputeToolkitId>;
  /** Toolkits present in every generation and therefore not user-removable. */
  readonly requiredToolkitIds?: ReadonlyArray<ComputeToolkitId>;
  readonly configuration?: {
    readonly displayName: string;
    readonly description: string;
    readonly toolkitRevision: string;
    /** The independently qualified interpreter version for this managed recipe. */
    readonly pythonVersion: string;
  };
}): NonNullable<ComputeRuntimeBinding["managedRuntime"]> & { readonly dispose: () => void } {
  const displayName = input.configuration?.displayName ?? "Scientific Python";
  const toolkitRevision = input.configuration?.toolkitRevision ?? MANAGED_PYTHON_TOOLKIT_REVISION;
  const pythonVersion = input.configuration?.pythonVersion ?? MANAGED_PYTHON_VERSION;
  let operation: ActiveOperation | null = null;
  let failureMessage: string | null = null;
  let failure: ComputeManagedRuntimeFailure | null = null;
  const changes = new Map<ComputeToolkitId, ComputeManagedToolkitStatus>();
  let revision = 0;
  let disposed = false;
  // Serialize short commands, never the background provisioning work.
  let commandTail: Promise<unknown> = Promise.resolve();
  const serial = <A>(command: () => Promise<A>): Promise<A> => {
    const result = commandTail.then(command);
    commandTail = result.catch(() => undefined);
    return result;
  };
  const availableToolkitIds = new Set(input.toolkitIds);
  const requiredToolkitIds = input.requiredToolkitIds ?? input.toolkitIds;
  if (availableToolkitIds.size !== input.toolkitIds.length) {
    throw new Error("Managed runtime Toolkit configuration contains duplicate IDs.");
  }
  if (
    new Set(requiredToolkitIds).size !== requiredToolkitIds.length ||
    requiredToolkitIds.some((toolkitId) => !availableToolkitIds.has(toolkitId))
  ) {
    throw new Error("Managed runtime required Toolkits must be distinct catalog entries.");
  }

  const selectedToolkitIds = (
    requested: ReadonlyArray<ComputeToolkitId> | undefined,
    active: ReadonlyArray<ComputeToolkitId> | undefined,
  ): ReadonlyArray<ComputeToolkitId> => {
    const chosen = requested ?? active ?? requiredToolkitIds;
    if (new Set(chosen).size !== chosen.length) {
      throw operationError("Choose each Scientific Python Toolkit only once.");
    }
    for (const toolkitId of chosen) {
      if (!availableToolkitIds.has(toolkitId)) {
        throw operationError(`Unknown Scientific Python Toolkit: ${toolkitId}.`);
      }
    }
    const selected = new Set([...requiredToolkitIds, ...chosen]);
    return input.toolkitIds.filter((toolkitId) => selected.has(toolkitId));
  };

  const readStatus = async (): Promise<ComputeManagedRuntimeStatus> => {
    for (;;) {
      const operationSnapshot = operation;
      const observedRevision = revision;
      const current = await input.manager.inspect();
      if (operationSnapshot !== operation || observedRevision !== revision) continue;
      const active = current?.record.active ?? null;
      const unavailableFailure =
        current !== null && !current.available
          ? ({
              reason: "activation-failed",
              action: "repair",
              summary: `${displayName} needs repair`,
              detail: `${displayName} is unavailable. Repair it or choose an existing environment.`,
            } satisfies ComputeManagedRuntimeFailure)
          : null;
      return {
        ...(input.configuration === undefined
          ? {}
          : {
              displayName,
              description: input.configuration.description,
            }),
        installed: current !== null,
        generationId: active?.generationId ?? null,
        selection: current?.record.selection ?? "existing",
        updateAvailable:
          active !== null &&
          (active.toolkitRevision !== toolkitRevision ||
            active.pythonVersion !== pythonVersion ||
            active.provisionerVersion !== MANAGED_PYTHON_PROVISIONER_VERSION),
        runtimeVersion: active === null ? null : `Python ${active.pythonVersion}`,
        toolkitRevision: active?.toolkitRevision ?? null,
        toolkitIds: active?.toolkitIds ?? [],
        ...(input.configuration === undefined ? { toolkitChanges: [...changes.values()] } : {}),
        operation:
          operationSnapshot === null
            ? null
            : {
                operationId: operationSnapshot.operationId,
                action: operationSnapshot.action,
                phase: operationSnapshot.phase,
                startedAt: operationSnapshot.startedAt,
                downloadedBytes: operationSnapshot.downloadedBytes,
                totalBytes: operationSnapshot.totalBytes,
              },
        failure: failure ?? unavailableFailure,
        failureMessage: failureMessage ?? unavailableFailure?.detail ?? null,
      };
    }
  };

  const status = () =>
    Effect.tryPromise({
      try: readStatus,
      catch: (cause) => operationError(`Unable to inspect ${displayName}.`, cause),
    });

  const begin = async (
    action: Extract<ComputeManagedRuntimeAction, "install" | "update" | "repair" | "remove">,
    options?: ComputeManagedRuntimeProvisionOptions,
    batch: ReadonlyArray<ComputeManagedToolkitStatus> = [],
  ): Promise<void> => {
    if (disposed) throw operationError("Scientific runtime service is shutting down.");
    if (operation !== null) return;
    const current = await input.manager.inspect();
    // Two clients can cross the first check while inspection is in flight.
    // Recheck before publishing the operation so one server owns one mutation.
    if (disposed) throw operationError("Scientific runtime service is shutting down.");
    if (operation !== null) return;
    if (action === "install" && current !== null) return;
    const toolkitIds = selectedToolkitIds(options?.toolkitIds, current?.record.active.toolkitIds);
    if (action === "update" && current !== null) {
      const active = current.record.active;
      if (
        active.toolkitRevision === toolkitRevision &&
        active.pythonVersion === pythonVersion &&
        active.provisionerVersion === MANAGED_PYTHON_PROVISIONER_VERSION &&
        active.toolkitIds.length === toolkitIds.length &&
        active.toolkitIds.every((toolkitId, index) => toolkitId === toolkitIds[index])
      ) {
        return;
      }
    }
    if ((action === "repair" || action === "update") && current === null) {
      throw operationError(`Set up ${displayName} before repairing or updating it.`);
    }
    if (action === "remove" && current === null) return;
    if (action === "remove") await input.manager.assertUnused();

    const controller = new AbortController();
    const activeOperation: ActiveOperation = {
      action,
      controller,
      operationId: NodeCrypto.randomUUID(),
      startedAt: DateTime.formatIso(DateTime.nowUnsafe()),
      phase: action === "remove" ? "removing" : "installing-python",
      downloadedBytes: null,
      totalBytes: null,
    };
    operation = activeOperation;
    revision++;
    failureMessage = null;
    failure = null;

    const run =
      action === "remove"
        ? input.manager.remove()
        : input.manager[action === "repair" ? "repair" : "install"]({
            toolkitIds,
            toolkitRevision,
            pythonVersion,
            provisionerVersion: MANAGED_PYTHON_PROVISIONER_VERSION,
            ...(options?.selectionAfterInstall === undefined
              ? {}
              : { selectionAfterInstall: options.selectionAfterInstall }),
            signal: controller.signal,
            onProgress: (progress) => {
              if (operation !== activeOperation) return;
              activeOperation.phase = progress.phase;
              activeOperation.downloadedBytes = progress.downloadedBytes;
              activeOperation.totalBytes = progress.totalBytes;
            },
          });
    const settle = (cause?: unknown) =>
      serial(async () => {
        if (operation !== activeOperation) return;
        for (const entry of batch) {
          if (changes.get(entry.toolkitId) !== entry) continue;
          if (controller.signal.aborted) {
            changes.set(entry.toolkitId, { ...entry, state: "queued" });
          } else if (cause !== undefined) {
            changes.set(entry.toolkitId, { ...entry, state: "failed", error: shortMessage(cause) });
          } else changes.delete(entry.toolkitId);
        }
        if (batch.length === 0 && cause !== undefined && !controller.signal.aborted) {
          failureMessage = shortMessage(cause);
          failure = managedRuntimeFailure(cause, action, displayName);
        }
        operation = null;
        if (action === "remove" && cause === undefined) changes.clear();
        revision++;
        await drainChanges();
      });
    void run
      .then(
        () => settle(),
        (cause: unknown) => settle(cause),
      )
      .catch((cause: unknown) => {
        failureMessage = shortMessage(cause);
        failure = managedRuntimeFailure(cause, action, displayName);
      });
  };

  const drainChanges = async (): Promise<void> => {
    if (disposed || operation !== null) return;
    const queued = [...changes.values()].filter((entry) => entry.state === "queued");
    if (queued.length === 0) return;
    try {
      const current = await input.manager.inspect();
      if (disposed) return;
      if (!current) throw operationError(`Set up ${displayName} before downloading Toolkits.`);
      const ids = new Set(current.record.active.toolkitIds);
      const batch: ComputeManagedToolkitStatus[] = [];
      for (const entry of queued) {
        if (ids.has(entry.toolkitId) === entry.install) {
          changes.delete(entry.toolkitId);
          continue;
        }
        if (entry.install) ids.add(entry.toolkitId);
        else ids.delete(entry.toolkitId);
        const running = { ...entry, state: "running" as const };
        changes.set(entry.toolkitId, running);
        batch.push(running);
      }
      revision++;
      if (batch.length > 0) await begin("update", { toolkitIds: [...ids] }, batch);
    } catch (cause) {
      if (!disposed)
        for (const entry of queued)
          changes.set(entry.toolkitId, { ...entry, state: "failed", error: shortMessage(cause) });
      revision++;
    }
  };

  const manage = (
    action: ComputeManagedRuntimeAction,
    options?: ComputeManagedRuntimeProvisionOptions,
  ) =>
    Effect.tryPromise({
      try: () =>
        serial(async () => {
          if (disposed) throw operationError("Scientific runtime service is shutting down.");
          const change = options?.toolkitChange;
          if (change !== undefined) {
            if (
              action !== "update" ||
              options?.toolkitIds !== undefined ||
              options?.selectionAfterInstall !== undefined ||
              input.configuration !== undefined
            ) {
              throw operationError(
                "Individual Toolkit changes require a Python update without a replacement Toolkit list.",
              );
            }
            if (
              !availableToolkitIds.has(change.toolkitId) ||
              requiredToolkitIds.includes(change.toolkitId)
            ) {
              throw operationError("Choose an optional, reviewed Scientific Python Toolkit.");
            }
            const previous = changes.get(change.toolkitId);
            if (change.action === "cancel") {
              changes.delete(change.toolkitId);
              if (previous?.state === "running") operation?.controller.abort();
            } else {
              if (operation?.action === "remove")
                throw operationError("Wait for Python removal to finish.");
              if (!(await input.manager.inspect()))
                throw operationError("Set up Scient-managed Python first.");
              if (disposed) throw operationError("Scientific runtime service is shutting down.");
              if (previous?.state === "running") {
                if (previous.install !== (change.action === "install"))
                  throw operationError("Cancel the current Toolkit change first.");
              } else
                changes.set(change.toolkitId, {
                  toolkitId: change.toolkitId,
                  install: change.action === "install",
                  state: "queued",
                  error: null,
                });
            }
            revision++;
            await drainChanges();
            return await readStatus();
          }
          if (options?.selectionAfterInstall !== undefined && action !== "install") {
            throw operationError("Runtime selection can be chosen only during first setup.");
          }
          if (
            options?.toolkitIds !== undefined &&
            action !== "install" &&
            action !== "update" &&
            action !== "repair"
          ) {
            throw operationError("Toolkits can be chosen only while provisioning a runtime.");
          }
          if (action === "use-managed" || action === "use-existing") {
            if (operation?.action === "remove") {
              throw operationError(`Wait for the current ${displayName} operation to finish.`);
            }
            await input.manager.select(action === "use-managed" ? "managed" : "existing");
            failureMessage = null;
            failure = null;
          } else {
            if (operation !== null && options?.toolkitIds !== undefined)
              throw operationError(
                "Wait for the current operation or submit an individual Toolkit change.",
              );
            await begin(action, options);
          }
          return await readStatus();
        }),
      catch: (cause) =>
        isComputeOperationError(cause)
          ? cause
          : cause instanceof ManagedPythonEnvironmentError
            ? operationError(shortMessage(cause), cause)
            : operationError(`Unable to manage ${displayName}.`, cause),
    });

  const cancel = () =>
    Effect.tryPromise({
      try: () =>
        serial(async () => {
          changes.clear();
          revision++;
          operation?.controller.abort();
          return await readStatus();
        }),
      catch: (cause) => operationError(`Unable to cancel ${displayName} setup.`, cause),
    });

  return {
    isRemoving: () => operation?.action === "remove",
    status,
    manage,
    cancel,
    dispose: () => {
      disposed = true;
      changes.clear();
      revision++;
      operation?.controller.abort();
    },
  };
}
