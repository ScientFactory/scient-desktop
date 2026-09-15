// @effect-diagnostics nodeBuiltinImport:off -- operation identities use host randomness.
import * as NodeCrypto from "node:crypto";

import {
  ComputeOperationError,
  type ComputeManagedRuntimeAction,
  type ComputeManagedRuntimeFailure,
  type ComputeManagedRuntimeStatus,
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
  };
}): NonNullable<ComputeRuntimeBinding["managedRuntime"]> & { readonly dispose: () => void } {
  const displayName = input.configuration?.displayName ?? "Scientific Python";
  const toolkitRevision = input.configuration?.toolkitRevision ?? MANAGED_PYTHON_TOOLKIT_REVISION;
  let operation: ActiveOperation | null = null;
  let failureMessage: string | null = null;
  let failure: ComputeManagedRuntimeFailure | null = null;
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
      const current = await input.manager.inspect();
      if (operationSnapshot !== operation) continue;
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
            active.pythonVersion !== MANAGED_PYTHON_VERSION ||
            active.provisionerVersion !== MANAGED_PYTHON_PROVISIONER_VERSION),
        runtimeVersion: active === null ? null : `Python ${active.pythonVersion}`,
        toolkitRevision: active?.toolkitRevision ?? null,
        toolkitIds: active?.toolkitIds ?? [],
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
  ): Promise<void> => {
    if (operation !== null) return;
    const current = await input.manager.inspect();
    // Two clients can cross the first check while inspection is in flight.
    // Recheck before publishing the operation so one server owns one mutation.
    if (operation !== null) return;
    if (action === "install" && current !== null) return;
    const toolkitIds = selectedToolkitIds(options?.toolkitIds, current?.record.active.toolkitIds);
    if (action === "update" && current !== null) {
      const active = current.record.active;
      if (
        active.toolkitRevision === toolkitRevision &&
        active.pythonVersion === MANAGED_PYTHON_VERSION &&
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
    failureMessage = null;
    failure = null;

    const run =
      action === "remove"
        ? input.manager.remove()
        : input.manager[action === "repair" ? "repair" : "install"]({
            toolkitIds,
            toolkitRevision,
            pythonVersion: MANAGED_PYTHON_VERSION,
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
    void run
      .then(() => {
        failureMessage = null;
        failure = null;
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          failureMessage = shortMessage(cause);
          failure = managedRuntimeFailure(cause, action, displayName);
        }
      })
      .finally(() => {
        if (operation === activeOperation) operation = null;
      });
  };

  const manage = (
    action: ComputeManagedRuntimeAction,
    options?: ComputeManagedRuntimeProvisionOptions,
  ) =>
    Effect.tryPromise({
      try: async () => {
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
          if (operation !== null) {
            throw operationError(`Wait for the current ${displayName} operation to finish.`);
          }
          await input.manager.select(action === "use-managed" ? "managed" : "existing");
          failureMessage = null;
          failure = null;
        } else {
          await begin(action, options);
        }
        return await readStatus();
      },
      catch: (cause) =>
        isComputeOperationError(cause)
          ? cause
          : operationError(`Unable to manage ${displayName}.`, cause),
    });

  const cancel = () =>
    Effect.tryPromise({
      try: async () => {
        operation?.controller.abort();
        return await readStatus();
      },
      catch: (cause) => operationError(`Unable to cancel ${displayName} setup.`, cause),
    });

  return {
    isRemoving: () => operation?.action === "remove",
    status,
    manage,
    cancel,
    dispose: () => operation?.controller.abort(),
  };
}
