// @effect-diagnostics nodeBuiltinImport:off
/**
 * The shared checkout barrier (Overleaf coordinator contract, section 9).
 *
 * Two kinds of section exclude each other on one checkout: an Overleaf
 * application section, and a bulk mutation of the checkout (checkpoint restore,
 * pull, switching branch, removing the worktree). A bulk request closes new
 * application admission at once, waits for running ones to settle, then runs.
 * Bulk sections of one checkout run one at a time; a bulk change made inside
 * another of the same checkout (a provider checkout calling the Git driver)
 * joins it. Every bulk section advances the checkout's epoch as it starts and
 * again as it ends, even when it fails, so a plan made against an earlier epoch
 * is stale.
 *
 * A checkout is a Git working tree's top folder, found by its physical
 * identity: two paths to one folder are one checkout. A checkout inside another
 * (a submodule, a nested repository) belongs to both: a bulk change of the
 * outer one also waits for and suspends applications inside the inner one,
 * because a recursive checkout or pull rewrites it too. Arbitrary shell writers,
 * external Git commands and other server profiles are outside the barrier.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

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

/** The folder could not be examined to find its checkout (for example, no permission). */
export class CheckoutLookupError extends Schema.TaggedError<CheckoutLookupError>()(
  "CheckoutLookupError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Scient could not examine this project's folder to check for other operations on it.";
  }
}

/** A held section of one checkout; a bulk section passes it to work it runs inside. */
export interface CheckoutSection {
  /** Physical identity of the checkout's top folder. */
  readonly key: string;
  /** This checkout's key, then those of every checkout enclosing it, innermost first. */
  readonly keys: ReadonlyArray<string>;
  /** The checkout's top folder, as found when the section began. */
  readonly root: string;
  /** The checkout's epoch (with every enclosing checkout's) when the section was admitted. */
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
  ) => Effect.Effect<A, E | CheckoutRecoveryRequiredError | CheckoutLookupError, R>;
  /**
   * Runs `body` as an application section of the checkout containing `path`.
   * Refused, not queued, while a bulk section of it or of an enclosing checkout
   * is waiting or running, unless `within` is that bulk section's own handle.
   */
  readonly application: <A, E, R>(
    path: string,
    body: (section: CheckoutSection) => Effect.Effect<A, E, R>,
    options?: { readonly within?: CheckoutSection },
  ) => Effect.Effect<A, E | CheckoutSuspendedError | CheckoutLookupError, R>;
  /** The checkout containing `path` and its current epoch, for binding a plan. */
  readonly current: (path: string) => Effect.Effect<CheckoutSection, CheckoutLookupError>;
  /** Adds a settler for the life of the current scope. */
  readonly settleBeforeBulk: (settler: CheckoutSettler) => Effect.Effect<void, never, Scope.Scope>;
}

interface Entry {
  epoch: number;
  /** Applications of this checkout or of one inside it. */
  applications: number;
  /** Bulk sections waiting or running; while positive, admission is closed. */
  bulks: number;
  readonly turn: Semaphore.Semaphore;
  drained: Deferred.Deferred<void> | null;
  readonly held: Set<CheckoutSection>;
}

interface Located {
  readonly root: string;
  readonly keys: ReadonlyArray<string>;
}

/**
 * The bulk sections the current fiber runs inside, by checkout. A forked fiber
 * inherits them, so each is honored only while its section is still held.
 */
class HeldCheckouts extends Context.Reference<ReadonlyMap<string, CheckoutSection>>(
  "t3/scient/workspace/CheckoutBarrier/HeldCheckouts",
  { defaultValue: () => new Map() },
) {}

const missing = (error: unknown) =>
  ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

/**
 * The checkout holding `path` (the nearest folder with a `.git` entry, or the
 * folder itself) and the keys of every enclosing checkout, or null when
 * nothing at or above `path` exists and `skipMissing` is set.
 */
async function locate(path: string, skipMissing: boolean): Promise<Located | null> {
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
  const roots: string[] = [];
  for (let folder = current; ;) {
    const marked = await NodeFSP.lstat(NodePath.join(folder, ".git")).then(
      () => true,
      (error: unknown) => {
        if (missing(error)) return false;
        throw error;
      },
    );
    if (marked) roots.push(folder);
    const parent = NodePath.dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  if (roots.length === 0) roots.push(current);
  const keys: string[] = [];
  for (const root of roots) {
    const stat = await NodeFSP.stat(root, { bigint: true });
    keys.push(`${stat.dev}:${stat.ino}`);
  }
  return { root: roots[0]!, keys };
}

export const makeCheckoutBarrier = (): CheckoutBarrierShape => {
  const entries = new Map<string, Entry>();
  const settlers = new Set<CheckoutSettler>();
  const entry = (key: string) => {
    let found = entries.get(key);
    if (found === undefined) {
      found = {
        epoch: 0,
        applications: 0,
        bulks: 0,
        turn: Semaphore.makeUnsafe(1),
        drained: null,
        held: new Set(),
      };
      entries.set(key, found);
    }
    return found;
  };
  const lookup = (path: string, skipMissing: boolean) =>
    Effect.tryPromise({
      try: () => locate(path, skipMissing),
      catch: (cause) => new CheckoutLookupError({ path, cause }),
    });
  const located = (path: string) =>
    Effect.map(
      lookup(path, false),
      (found) =>
        found ?? { root: NodePath.resolve(path), keys: [`missing:${NodePath.resolve(path)}`] },
    );
  const epochOf = (keys: ReadonlyArray<string>) =>
    keys.reduce((sum, key) => sum + entry(key).epoch, 0);

  const bulk: CheckoutBarrierShape["bulk"] = (path, effect, options) =>
    Effect.gen(function* () {
      const found = yield* lookup(path, options?.missing === "skip");
      if (found === null) return yield* effect;
      const key = found.keys[0]!;
      const already = yield* HeldCheckouts;
      const held = entry(key);
      // A bulk change inside a live one of the same checkout joins it.
      const joined = already.get(key);
      if (joined !== undefined && held.held.has(joined)) return yield* effect;
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          held.bulks++;
          held.epoch++;
        }),
        () =>
          held.turn.withPermit(
            Effect.gen(function* () {
              while (held.applications > 0) {
                held.drained ??= Deferred.makeUnsafe<void>();
                yield* Deferred.await(held.drained);
              }
              // The path may name another checkout by now (moved, replaced); never
              // change one under another's identity.
              const now = yield* lookup(path, options?.missing === "skip");
              if (now !== null && now.keys[0] !== key)
                return yield* new CheckoutLookupError({
                  path,
                  cause: new Error("The checkout at this path changed while waiting."),
                });
              const keys = now?.keys ?? found.keys;
              const section: CheckoutSection = {
                key,
                keys,
                root: now?.root ?? found.root,
                epoch: epochOf(keys),
              };
              held.held.add(section);
              return yield* Effect.gen(function* () {
                for (const settle of settlers) yield* settle(section);
                return yield* effect;
              }).pipe(
                Effect.provideService(HeldCheckouts, new Map([...already, [key, section]])),
                Effect.ensuring(Effect.sync(() => held.held.delete(section))),
              );
            }),
          ),
        () =>
          Effect.sync(() => {
            held.bulks--;
            held.epoch++;
          }),
      );
    });

  const application: CheckoutBarrierShape["application"] = (path, body, options) =>
    Effect.flatMap(located(path), (found) =>
      Effect.acquireUseRelease(
        Effect.suspend(() => {
          const within = options?.within;
          for (const key of found.keys) {
            const held = entry(key);
            // Inside its own held bulk section, later bulk changes wait their turn behind it.
            const admitted = within?.key === key ? held.held.has(within) : held.bulks === 0;
            if (!admitted) return Effect.fail(new CheckoutSuspendedError({ checkout: found.root }));
          }
          for (const key of found.keys) entry(key).applications++;
          return Effect.succeed(found);
        }),
        () =>
          body({
            key: found.keys[0]!,
            keys: found.keys,
            root: found.root,
            epoch: epochOf(found.keys),
          }),
        () =>
          Effect.forEach(
            found.keys,
            (key) =>
              Effect.suspend(() => {
                const held = entry(key);
                held.applications--;
                const drained = held.drained;
                if (held.applications > 0 || drained === null) return Effect.void;
                held.drained = null;
                return Deferred.succeed(drained, undefined);
              }),
            { discard: true },
          ),
      ),
    );

  const current: CheckoutBarrierShape["current"] = (path) =>
    Effect.map(located(path), (found) => ({
      key: found.keys[0]!,
      keys: found.keys,
      root: found.root,
      epoch: epochOf(found.keys),
    }));

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
