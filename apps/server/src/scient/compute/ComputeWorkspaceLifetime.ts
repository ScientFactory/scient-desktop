// @effect-diagnostics nodeBuiltinImport:off -- synchronous canonical path comparisons inside admission.
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { ComputeOperationError } from "@scientfactory/compute";

// Admission mutates these maps synchronously, before yielding. Reservations cover
// descendants while unrelated roots can start/stop during a slow Git removal.
const owners = new Map<symbol, string>();
const removals = new Map<symbol, string>();

const contains = (root: string, target: string) => {
  const relative = NodePath.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative))
  );
};

/** Register before startup; caller retains the receipt until physical cleanup succeeds. */
export const withComputeWorkspaceReservation = <A, E, R>(
  root: string,
  reserve: (release: Effect.Effect<void>) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    if (
      [...removals.values()].some((removal) => contains(removal, root) || contains(root, removal))
    )
      return yield* new ComputeOperationError({
        operation: "start",
        reason: "workspace-changed",
        message: "This workspace is being removed. Reopen it before starting Compute.",
      });
    const id = Symbol("compute-workspace-owner");
    owners.set(id, root);
    const release = Effect.sync(() => {
      owners.delete(id);
    });
    return yield* reserve(release).pipe(Effect.onError(() => release));
  }).pipe(Effect.uninterruptible);

/** Run inside the inherited workspace lease; owners in any nested root block removal. */
export const withoutComputeWorkspaceOwners = <A, E, R>(
  root: string,
  remove: Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      if (
        [...owners.values()].some((owner) => contains(root, owner)) ||
        [...removals.values()].some((removal) => contains(root, removal) || contains(removal, root))
      )
        return null;
      const id = Symbol("workspace-removal");
      removals.set(id, root);
      return id;
    }),
    (id) => (id === null ? Effect.void : remove),
    (id) =>
      Effect.sync(() => {
        if (id !== null) removals.delete(id);
      }),
  );
