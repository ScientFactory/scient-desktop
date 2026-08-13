import type { EnvironmentId, ScientSourceImportOperation } from "@t3tools/contracts";

type ActiveImport = {
  cancelRequested: boolean;
  readonly listeners: Set<(operation: ScientSourceImportOperation) => void>;
  promise: Promise<ScientSourceImportOperation>;
};

const activeImports = new Map<string, ActiveImport>();

function importKey(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
  readonly operationId: string;
}): string {
  return `${input.environmentId}\0${input.projectId}\0${input.operationId}`;
}

export function continueSourceImport(input: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly operation: ScientSourceImportOperation;
  readonly advance: (operationId: string) => Promise<ScientSourceImportOperation>;
  readonly onProgress?: (operation: ScientSourceImportOperation) => void;
}): Promise<ScientSourceImportOperation> {
  const key = importKey({
    environmentId: input.environmentId,
    projectId: input.operation.projectId,
    operationId: input.operation.operationId,
  });
  let active = activeImports.get(key);
  if (!active) {
    const listeners = new Set<(operation: ScientSourceImportOperation) => void>();
    const nextActive: ActiveImport = {
      cancelRequested: false,
      listeners,
      promise: Promise.resolve(input.operation),
    };
    activeImports.set(key, nextActive);
    nextActive.promise = Promise.resolve()
      .then(async () => {
        let next = input.operation;
        while (
          !nextActive.cancelRequested &&
          next.state === "running" &&
          next.items.some((item) => item.state === "pending")
        ) {
          const pendingBefore = next.items.filter((item) => item.state === "pending").length;
          next = await input.advance(next.operationId);
          const pendingAfter = next.items.filter((item) => item.state === "pending").length;
          if (next.state === "running" && pendingAfter >= pendingBefore) {
            throw new Error("The source import did not advance to the next item.");
          }
          for (const listener of nextActive.listeners) {
            try {
              listener(next);
            } catch {
              // Presentation must never interrupt the durable import driver.
            }
          }
        }
        return next;
      })
      .finally(() => {
        if (activeImports.get(key) === nextActive) activeImports.delete(key);
      });
    active = nextActive;
  }

  if (!input.onProgress) return active.promise;
  const listener = input.onProgress;
  const observedImport = active;
  active.listeners.add(listener);
  return active.promise.finally(() => {
    observedImport.listeners.delete(listener);
  });
}

export function stopSourceImportContinuation(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
  readonly operationId: string;
}): void {
  const active = activeImports.get(importKey(input));
  if (active) active.cancelRequested = true;
}
