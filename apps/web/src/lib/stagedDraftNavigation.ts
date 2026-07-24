// FILE: stagedDraftNavigation.ts
// Purpose: Coordinates draft-route creation across the shared navigation surface and finalizes
//          staged drafts only after their destination route actually commits.
// Layer: Web navigation orchestration

interface DraftNavigationSlotState {
  blockingBarrier: Promise<void> | null;
  tail: Promise<void>;
  latestOperation: Promise<unknown> | null;
  latestRequestKey: string | null;
  latestOwner: symbol | null;
}

export interface DraftNavigationOwnership {
  readonly isCurrent: () => boolean;
}

const draftNavigationStateBySlot = new Map<string, DraftNavigationSlotState>();
const DRAFT_NAVIGATION_SURFACE_KEY = "new-thread-navigation";

/**
 * Every new-thread action ultimately controls the same visible route. Keep one ownership domain
 * across projects and entry points so a delayed earlier action cannot navigate after a newer one.
 */
export function draftNavigationSlotKey(): string {
  return DRAFT_NAVIGATION_SURFACE_KEY;
}

/** Resolves after the operations currently running on the shared navigation surface have drained. */
export function waitForDraftNavigationIdle(slotKey: string): Promise<void> {
  return draftNavigationStateBySlot.get(slotKey)?.tail ?? Promise.resolve();
}

/**
 * Transfers visible-route ownership to a navigation that is not creating a new thread. Pending
 * preparations may finish their read-only work, but they can no longer stage or commit a route.
 */
export function supersedeDraftNavigation(slotKey: string): void {
  const state = draftNavigationStateBySlot.get(slotKey);
  if (!state) {
    return;
  }
  state.latestOwner = Symbol("external-navigation");
  state.latestOperation = null;
  state.latestRequestKey = null;
}

/**
 * Coalesces adjacent identical requests while starting distinct requests independently. A distinct
 * later request becomes the owner immediately, allowing it to make progress without waiting for a
 * stale preparation and allowing awaited older work to stop before a route or draft-mapping commit.
 */
export function runDraftNavigationOnce<T>(
  slotKey: string,
  requestKey: string,
  run: (ownership: DraftNavigationOwnership) => Promise<T>,
  options?: { readonly blocksFollowingOperations?: boolean },
): Promise<T> {
  let state = draftNavigationStateBySlot.get(slotKey);
  if (!state) {
    state = {
      blockingBarrier: null,
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
  const priorBlockingBarrier = state.blockingBarrier;
  const execution = priorBlockingBarrier
    ? priorBlockingBarrier.then(() => run(ownership))
    : Promise.resolve().then(() => run(ownership));
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
  if (options?.blocksFollowingOperations === true) {
    const blockingBarrier = operation.then(
      () => undefined,
      () => undefined,
    );
    state.blockingBarrier = blockingBarrier;
    void blockingBarrier.then(() => {
      if (state.blockingBarrier === blockingBarrier) {
        state.blockingBarrier = null;
      }
    });
  }

  const previousTail = state.tail;
  const tail = Promise.all([previousTail, operation]).then(
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
