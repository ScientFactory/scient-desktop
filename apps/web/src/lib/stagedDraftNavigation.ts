// FILE: stagedDraftNavigation.ts
// Purpose: Serializes draft-route creation per project slot and finalizes staged drafts only
//          after their destination route actually commits.
// Layer: Web navigation orchestration

interface DraftNavigationSlotState {
  tail: Promise<void>;
  latestOperation: Promise<unknown> | null;
  latestRequestKey: string | null;
}

const draftNavigationStateBySlot = new Map<string, DraftNavigationSlotState>();

export function draftNavigationSlotKey(projectId: string, entryPoint: string): string {
  return `${projectId}\u0000${entryPoint}`;
}

/**
 * Coalesces identical requests for one project slot while serializing requests whose workspace,
 * provider, or navigation intent differs. This prevents a later exact-workspace action from
 * silently joining an earlier project-default navigation (and vice versa).
 */
export function runDraftNavigationOnce<T>(
  slotKey: string,
  requestKey: string,
  run: () => Promise<T>,
): Promise<T> {
  let state = draftNavigationStateBySlot.get(slotKey);
  if (!state) {
    state = {
      tail: Promise.resolve(),
      latestOperation: null,
      latestRequestKey: null,
    };
    draftNavigationStateBySlot.set(slotKey, state);
  }

  if (state.latestRequestKey === requestKey && state.latestOperation) {
    return state.latestOperation as Promise<T>;
  }

  const execution = state.tail.then(run, run);
  let operation!: Promise<T>;
  const clearLatestRequest = () => {
    if (state.latestOperation === operation) {
      state.latestOperation = null;
      state.latestRequestKey = null;
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
    input.stage();
    await input.navigate();
    if (!input.isDestinationActive()) {
      rollbackOnce();
      return false;
    }
    input.finalize();
    return true;
  } catch (error) {
    rollbackOnce();
    throw error;
  }
}
