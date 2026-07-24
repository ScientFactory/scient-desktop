// FILE: stagedDraftNavigation.ts
// Purpose: Coordinates draft-route creation across the shared navigation surface and finalizes
//          staged drafts only after their destination route actually commits.
// Layer: Web navigation orchestration

import { randomUUID } from "./utils";

interface DraftNavigationSlotState {
  blockingBarrier: Promise<void> | null;
  ownedRouteToken: string | null;
  tail: Promise<void>;
  latestOperation: Promise<unknown> | null;
  latestRequestKey: string | null;
  latestOwner: symbol | null;
  latestRouteClaim: symbol | null;
}

export interface DraftNavigationOwnership {
  readonly isCurrent: () => boolean;
  readonly routeToken: string;
}

const draftNavigationStateBySlot = new Map<string, DraftNavigationSlotState>();
const DRAFT_NAVIGATION_SURFACE_KEY = "new-thread-navigation";
const DRAFT_ROUTE_SESSION_PREFIX = `draft-route:${randomUUID()}:`;
let nextOwnedRouteToken = 0;
const pendingOwnedRouteTokens = new Set<string>();

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
 * Claims the visible route for navigation outside new-thread creation. Ownership changes
 * immediately so stale read-only preparation cannot commit later. A non-cancellable mutation,
 * such as preparing a pull-request checkout, remains a barrier and must settle before the newer
 * route becomes active.
 */
export async function coordinateExternalRouteNavigation(
  slotKey: string,
  ownedRouteToken?: string,
): Promise<boolean> {
  const state = draftNavigationStateBySlot.get(slotKey);
  if (!state) {
    // Persisted history state can outlive the in-memory coordinator across reloads. With no live
    // owner there is nothing to supersede, so the route is safe to restore.
    return true;
  }
  if (ownedRouteToken) {
    if (state.ownedRouteToken === ownedRouteToken) {
      return true;
    }
    // A token still owned by another in-flight request is stale and fails closed. Once its request
    // settles, the token becomes ordinary browser history; revisiting it through Back/Forward is a
    // new external intent that must supersede current work. This survives renderer reloads and an
    // unbounded history because only live requests need to be retained.
    if (pendingOwnedRouteTokens.has(ownedRouteToken)) return false;
  }
  const routeClaim = Symbol("external-route-navigation");
  const blockingBarrier = state.blockingBarrier;
  state.latestOwner = routeClaim;
  state.latestOperation = null;
  state.latestRequestKey = null;
  state.ownedRouteToken = null;
  state.latestRouteClaim = routeClaim;
  await blockingBarrier;
  const mayCommit = state.latestRouteClaim === routeClaim && state.latestOwner === routeClaim;
  if (mayCommit) {
    state.latestRouteClaim = null;
  }
  return mayCommit;
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
      ownedRouteToken: null,
      tail: Promise.resolve(),
      latestOperation: null,
      latestRequestKey: null,
      latestOwner: null,
      latestRouteClaim: null,
    };
    draftNavigationStateBySlot.set(slotKey, state);
  }

  if (state.latestRequestKey === requestKey && state.latestOperation) {
    return state.latestOperation as Promise<T>;
  }

  const owner = Symbol(requestKey);
  const routeToken = `${DRAFT_ROUTE_SESSION_PREFIX}${(nextOwnedRouteToken += 1)}`;
  pendingOwnedRouteTokens.add(routeToken);
  const ownership: DraftNavigationOwnership = {
    isCurrent: () => state.latestOwner === owner,
    routeToken,
  };
  state.latestOwner = owner;
  state.ownedRouteToken = routeToken;
  state.latestRouteClaim = null;
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
      state.ownedRouteToken = null;
    }
  };
  operation = execution.then(
    (value) => {
      pendingOwnedRouteTokens.delete(routeToken);
      clearLatestRequest();
      return value;
    },
    (error: unknown) => {
      pendingOwnedRouteTokens.delete(routeToken);
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
      state.latestOperation === null &&
      state.latestRouteClaim === null
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
  readonly ownedRouteToken?: string;
  readonly isCurrent: () => boolean;
  readonly stage: () => void;
  readonly navigate: (ownedRouteToken?: string) => Promise<void>;
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
    await input.navigate(input.ownedRouteToken);
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
