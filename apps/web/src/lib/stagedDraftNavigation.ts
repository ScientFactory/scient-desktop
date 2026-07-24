// FILE: stagedDraftNavigation.ts
// Purpose: Serializes draft-route creation per project slot and finalizes staged drafts only
//          after their destination route actually commits.
// Layer: Web navigation orchestration

interface DraftNavigationSlotState {
  tail: Promise<void>;
  latestOperation: Promise<unknown> | null;
  latestRequestKey: string | null;
  latestOwner: symbol | null;
}

export interface DraftNavigationOwnership {
  readonly isCurrent: () => boolean;
}

const draftNavigationStateBySlot = new Map<string, DraftNavigationSlotState>();

export function draftNavigationSlotKey(projectId: string, entryPoint: string): string {
  return `${projectId}\u0000${entryPoint}`;
}

/** Resolves after the operations currently queued for a project slot have drained. */
export function waitForDraftNavigationIdle(slotKey: string): Promise<void> {
  return draftNavigationStateBySlot.get(slotKey)?.tail ?? Promise.resolve();
}

/**
 * Coalesces adjacent identical requests while serializing distinct requests for one project slot.
 * A distinct later request becomes the owner immediately, allowing awaited work to stop before a
 * stale navigation or draft-mapping commit can overwrite the user's latest intent.
 */
export function runDraftNavigationOnce<T>(
  slotKey: string,
  requestKey: string,
  run: (ownership: DraftNavigationOwnership) => Promise<T>,
): Promise<T> {
  let state = draftNavigationStateBySlot.get(slotKey);
  if (!state) {
    state = {
      tail: Promise.resolve(),
      latestOperation: null,
      latestRequestKey: null,
      latestOwner: null,
    };
    draftNavigationStateBySlot.set(slotKey, state);
  }

  if (state.latestRequestKey === requestKey && state.latestOperation) {
    return state.latestOperation as Promise<T>;
  }

  const owner = Symbol(requestKey);
  const ownership: DraftNavigationOwnership = {
    isCurrent: () => state.latestOwner === owner,
  };
  state.latestOwner = owner;
  const execute = () => run(ownership);
  const execution = state.tail.then(execute, execute);
  let operation!: Promise<T>;
  const clearLatestRequest = () => {
    if (state.latestOperation === operation) {
      state.latestOperation = null;
      state.latestRequestKey = null;
      state.latestOwner = null;
    }
  };
  operation = execution.then(
    (value) => {
      clearLatestRequest();
      return value;
    },
    (error: unknown) => {
      clearLatestRequest();
      throw error;
    },
  );
  state.latestOperation = operation;
  state.latestRequestKey = requestKey;

  const tail = operation.then(
    () => undefined,
    () => undefined,
  );
  state.tail = tail;
  void tail.then(() => {
    if (
      draftNavigationStateBySlot.get(slotKey) === state &&
      state.tail === tail &&
      state.latestOperation === null
    ) {
      draftNavigationStateBySlot.delete(slotKey);
    }
  });
  return operation;
}

/**
 * Keeps the previous routed draft alive while the destination loads. A superseding navigation
 * rolls the staged draft back without treating the user's newer navigation as an error.
 */
export async function stageDraftNavigation(input: {
  readonly isCurrent: () => boolean;
  readonly stage: () => void;
  readonly navigate: () => Promise<void>;
  readonly isDestinationActive: () => boolean;
  readonly finalize: () => void;
  readonly rollback: () => void;
}): Promise<boolean> {
  let rolledBack = false;
  const rollbackOnce = () => {
    if (rolledBack) {
      return;
    }
    rolledBack = true;
    input.rollback();
  };

  try {
    if (!input.isCurrent()) {
      return false;
    }
    input.stage();
    await input.navigate();
    if (!input.isCurrent() || !input.isDestinationActive()) {
      rollbackOnce();
      return false;
    }
    input.finalize();
    return true;
  } catch (error) {
    rollbackOnce();
    if (!input.isCurrent()) {
      return false;
    }
    throw error;
  }
}
