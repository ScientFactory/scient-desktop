// @effect-diagnostics nodeBuiltinImport:off
/**
 * The shared checkout barrier (Overleaf coordinator contract, section 9).
 *
 * Two kinds of section exclude each other on one checkout: an Overleaf
 * application section, and a bulk mutation of the checkout (checkpoint restore,
 * pull, switching branch, removing the worktree). A bulk request closes new
 * application admission at once, waits for running ones to settle, then runs.
 * Bulk sections do not exclude one another; their own locks order them. Every
 * bulk section advances the checkout's epoch as it starts and again as it ends,
 * even when it fails, so a plan made against an earlier epoch is stale.
 *
 * A checkout is its Git working tree's top folder, found by its physical
 * identity: two paths to one folder are one checkout. Arbitrary shell writers,
 * external Git commands and other server profiles are outside the barrier.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

/** An application was refused because the checkout is being changed in bulk. */
export class CheckoutSuspendedError extends Schema.TaggedError<CheckoutSuspendedError>()(
  "CheckoutSuspendedError",
  { checkout: Schema.String },
) {
  override get message(): string {
    return "This project's files are being changed by another operation (for example a checkpoint restore or a pull). Try again when it finishes.";
  }
}

/** A bulk mutation was refused because an unfinished Overleaf sync could not be settled first. */
export class CheckoutRecoveryRequiredError extends Schema.TaggedError<CheckoutRecoveryRequiredError>()(
  "CheckoutRecoveryRequiredError",
  { checkout: Schema.String },
) {
  override get message(): string {
    return "An Overleaf sync in this project did not finish. Recover it before changing the project's files in bulk.";
  }
}

/** A held section of one checkout; a bulk section passes it to work it runs inside. */
export interface CheckoutSection {
  /** Physical identity of the checkout's top folder. */
  readonly key: string;
  /** The checkout's top folder, as found when the section began. */
  readonly root: string;
  /** The checkout's epoch when the section was admitted. */
  readonly epoch: number;
}

/**
 * Runs before every bulk section, after running applications have settled:
 * finishes local work a bulk change would erase, or refuses the change.
 */
export type CheckoutSettler = (
  section: CheckoutSection,
) => Effect.Effect<void, CheckoutRecoveryRequiredError>;

export interface CheckoutBarrierShape {
  /**
   * Runs `effect` as a bulk mutation of the checkout containing `path`. A path
   * that no longer exists is resolved through its nearest existing folder,
   * unless `missing` is "skip", which then runs `effect` outside the barrier.
   */
  readonly bulk: <A, E, R>(
    path: string,
    effect: Effect.Effect<A, E, R>,
    options?: { readonly missing?: "nearest" | "skip" },
  ) => Effect.Effect<A, E | CheckoutRecoveryRequiredError, R>;
  /**
   * Runs `body` as an application section of the checkout containing `path`.
   * Refused, not queued, while a bulk section is waiting or running, unless
   * `within` is that bulk section's own handle.
   */
  readonly application: <A, E, R>(
    path: string,
    body: (section: CheckoutSection) => Effect.Effect<A, E, R>,
    options?: { readonly within?: CheckoutSection },
  ) => Effect.Effect<A, E | CheckoutSuspendedError, R>;
  /** The checkout containing `path` and its current epoch, for binding a plan. */
  readonly current: (path: string) => Effect.Effect<CheckoutSection>;
  /** Adds a settler for the life of the current scope. */
  readonly settleBeforeBulk: (settler: CheckoutSettler) => Effect.Effect<void, never, Scope.Scope>;
}

interface Entry {
  epoch: number;
  applications: number;
  bulks: number;
  drained: Deferred.Deferred<void> | null;
  readonly held: Set<CheckoutSection>;
}

const missing = (error: unknown) =>
  ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

/** The checkout's top folder and physical identity, or null when nothing at or above `path` exists. */
async function locate(path: string, skipMissing: boolean) {
  let current = NodePath.resolve(path);
  for (;;) {
    try {
      current = await NodeFSP.realpath(current);
      break;
    } catch (error) {
      if (!missing(error)) throw error;
      if (skipMissing) return null;
      const parent = NodePath.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
  let root = current;
  for (let folder = current; ;) {
    const marked = await NodeFSP.lstat(NodePath.join(folder, ".git")).then(
      () => true,
      (error: unknown) => {
        if (missing(error)) return false;
        throw error;
      },
    );
    if (marked) {
      root = folder;
      break;
    }
    const parent = NodePath.dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  const stat = await NodeFSP.stat(root, { bigint: true });
  return { root, key: `${stat.dev}:${stat.ino}` };
}

export const makeCheckoutBarrier = (): CheckoutBarrierShape => {
  const entries = new Map<string, Entry>();
  const settlers = new Set<CheckoutSettler>();
  const entry = (key: string) => {
    let found = entries.get(key);
    if (found === undefined) {
      found = { epoch: 0, applications: 0, bulks: 0, drained: null, held: new Set() };
      entries.set(key, found);
    }
    return found;
  };
  const locateEffect = (path: string, skipMissing: boolean) =>
    Effect.promise(() => locate(path, skipMissing));

  const bulk: CheckoutBarrierShape["bulk"] = (path, effect, options) =>
    Effect.flatMap(locateEffect(path, options?.missing === "skip"), (located) => {
      if (located === null) return effect;
      return Effect.acquireUseRelease(
        Effect.sync(() => {
          const held = entry(located.key);
          held.bulks++;
          held.epoch++;
          return held;
        }),
        (held) =>
          Effect.gen(function* () {
            while (held.applications > 0) {
              held.drained ??= Deferred.makeUnsafe<void>();
              yield* Deferred.await(held.drained);
            }
            const section: CheckoutSection = { ...located, epoch: held.epoch };
            held.held.add(section);
            return yield* Effect.gen(function* () {
              for (const settle of settlers) yield* settle(section);
              return yield* effect;
            }).pipe(Effect.ensuring(Effect.sync(() => held.held.delete(section))));
          }),
        (held) =>
          Effect.sync(() => {
            held.bulks--;
            held.epoch++;
          }),
      );
    });

  const application: CheckoutBarrierShape["application"] = (path, body, options) =>
    Effect.flatMap(locateEffect(path, false), (located) => {
      const key = located?.key ?? `missing:${NodePath.resolve(path)}`;
      const root = located?.root ?? NodePath.resolve(path);
      return Effect.acquireUseRelease(
        Effect.suspend(() => {
          const held = entry(key);
          const within = options?.within;
          if (held.bulks > 0 && !(within !== undefined && held.held.has(within)))
            return Effect.fail(new CheckoutSuspendedError({ checkout: root }));
          held.applications++;
          return Effect.succeed(held);
        }),
        (held) => body({ key, root, epoch: held.epoch }),
        (held) =>
          Effect.suspend(() => {
            held.applications--;
            const drained = held.drained;
            if (held.applications > 0 || drained === null) return Effect.void;
            held.drained = null;
            return Deferred.succeed(drained, undefined);
          }),
      );
    });

  const current: CheckoutBarrierShape["current"] = (path) =>
    Effect.map(locateEffect(path, false), (located) => {
      const key = located?.key ?? `missing:${NodePath.resolve(path)}`;
      return {
        key,
        root: located?.root ?? NodePath.resolve(path),
        epoch: entry(key).epoch,
      };
    });

  const settleBeforeBulk: CheckoutBarrierShape["settleBeforeBulk"] = (settler) =>
    Effect.acquireRelease(
      Effect.sync(() => settlers.add(settler)),
      () => Effect.sync(() => settlers.delete(settler)),
    ).pipe(Effect.asVoid);

  return { bulk, application, current, settleBeforeBulk };
};

/**
 * One barrier per server process by default, so every layer that mutates a
 * checkout shares it however it was built. Tests provide their own.
 */
export class CheckoutBarrier extends Context.Reference<CheckoutBarrierShape>(
  "t3/scient/workspace/CheckoutBarrier",
  { defaultValue: makeCheckoutBarrier },
) {}
