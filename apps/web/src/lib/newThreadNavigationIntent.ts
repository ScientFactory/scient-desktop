export interface NewThreadNavigationIntent {
  readonly isCurrent: () => boolean;
}

export interface NewThreadNavigationIntentCoordinator {
  readonly claim: (input: {
    readonly kind: "automatic" | "explicit";
    readonly scope: string;
  }) => NewThreadNavigationIntent;
  readonly invalidate: () => void;
}

/**
 * Coordinates new-thread navigation across independent React hook instances.
 * A component-local ref cannot do this because the landing route, command
 * palette, sidebar, and chat view each own a separate useNewThreadHandler.
 */
export function createNewThreadNavigationIntentCoordinator(): NewThreadNavigationIntentCoordinator {
  let generation = 0;
  let activeKind: "automatic" | "explicit" | null = null;
  let activeScope: string | null = null;

  return {
    claim({ kind, scope }) {
      if (scope !== activeScope) {
        activeScope = scope;
        activeKind = null;
      }

      // Once the user chooses a destination in this route visit, a landing
      // effect rerun caused by project/entity updates must not take ownership.
      if (kind === "automatic" && activeKind === "explicit") {
        return { isCurrent: () => false };
      }

      const claimedGeneration = ++generation;
      activeKind = kind;

      return {
        isCurrent: () => activeScope === scope && claimedGeneration === generation,
      };
    },
    invalidate() {
      generation += 1;
      activeKind = null;
      activeScope = null;
    },
  };
}

const coordinatorByOwner = new WeakMap<object, NewThreadNavigationIntentCoordinator>();

/** Keeps intent ownership local to one router while sharing it across callers. */
export function getNewThreadNavigationIntentCoordinator(
  owner: object,
  registerInvalidation?: (invalidate: () => void) => void,
): NewThreadNavigationIntentCoordinator {
  const existing = coordinatorByOwner.get(owner);
  if (existing) return existing;

  const coordinator = createNewThreadNavigationIntentCoordinator();
  coordinatorByOwner.set(owner, coordinator);
  registerInvalidation?.(coordinator.invalidate);
  return coordinator;
}
