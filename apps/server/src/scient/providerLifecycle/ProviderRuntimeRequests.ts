import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderManagedRuntimeAction,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ServerConfig } from "../../config.ts";

/** After the user's own try, then after each try Scient makes; the cooldown repeats after that. */
const RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000] as const;
const COOLDOWN_MS = 4 * 60 * 60_000;
const ACP_REGISTRY = ProviderDriverKind.make("acpRegistry");

/** An install, update or repair the user asked for that has not succeeded yet. */
const RuntimeRequest = Schema.Struct({
  requestId: Schema.String,
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  action: Schema.Literals(["install", "update", "repair"]),
  /** The plan the user reviewed; a different plan is never installed in its place. */
  catalogRevision: Schema.String,
  /** Tries Scient made on its own since the user's. */
  retries: Schema.Number,
  /** No try starts before this (epoch ms). Set when a try starts too, so a crash cannot hurry the next. */
  dueAt: Schema.Number,
});
export type RuntimeRequest = typeof RuntimeRequest.Type;
const RequestsJson = Schema.fromJsonString(Schema.Array(RuntimeRequest));
const decodeRequests = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({ ...RuntimeRequest.fields, requestId: Schema.optionalKey(Schema.String) }),
    ),
  ),
);
const encodeRequests = Schema.encodeEffect(RequestsJson);

/** How a change of a runtime ended; `retryable` failed in a way a later try may not. */
export type RuntimeChangeOutcome = "succeeded" | "cancelled" | "failed" | "retryable";

/** When the try after `retries` of Scient's own may start, spread so installs don't retry together. */
export const nextTryAt = Effect.fnUntraced(function* (retries: number) {
  const delay = RETRY_DELAYS_MS[retries] ?? COOLDOWN_MS;
  const now = yield* Clock.currentTimeMillis;
  return now + Math.round(delay * (0.8 + (yield* Random.next) * 0.4));
});

// Instances of a driver share one managed runtime; each ACP Registry agent has its own.
export const sameRuntime = (
  request: RuntimeRequest,
  change: { readonly instanceId: ProviderInstanceId; readonly driver: ProviderDriverKind },
) =>
  request.driver === change.driver &&
  (change.driver !== ACP_REGISTRY || request.instanceId === change.instanceId);

export class ProviderRuntimeRequestsPersistenceError extends Schema.TaggedError<ProviderRuntimeRequestsPersistenceError>()(
  "ProviderRuntimeRequestsPersistenceError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Scient could not save the requested runtime change. Try again.";
  }
}

/**
 * Runtime changes the user asked for, kept across restarts until one succeeds, the user cancels or
 * removes it, or chooses again. The runtime manager records them; recovery tries them again.
 */
export class ProviderRuntimeRequests extends Context.Service<
  ProviderRuntimeRequests,
  {
    /** The user started a change: it replaces any request for the same runtime; Remove only clears. */
    readonly requested: (input: {
      readonly requestId: string;
      readonly instanceId: ProviderInstanceId;
      readonly driver: ProviderDriverKind;
      readonly action: ProviderManagedRuntimeAction;
      readonly catalogRevision: string;
    }) => Effect.Effect<void, ProviderRuntimeRequestsPersistenceError>;
    readonly settled: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly driver: ProviderDriverKind;
      readonly outcome: RuntimeChangeOutcome;
      readonly requestId?: string;
      readonly retryAfterMs?: number;
    }) => Effect.Effect<void, ProviderRuntimeRequestsPersistenceError>;
    readonly list: Effect.Effect<ReadonlyArray<RuntimeRequest>>;
    readonly changes: Stream.Stream<ReadonlyArray<RuntimeRequest>>;
    /** Changes this exact request if it still exists; `undefined` drops it. */
    readonly update: (
      requestId: string,
      change: (request: RuntimeRequest) => RuntimeRequest | undefined,
    ) => Effect.Effect<void, ProviderRuntimeRequestsPersistenceError>;
  }
>()("t3/scient/providerLifecycle/ProviderRuntimeRequests") {}

export const make = Effect.fn("ProviderRuntimeRequests.make")(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const random = yield* SecureRandom.SecureRandom;
  // Kept outside the runtime folders, which Remove deletes.
  const filePath = path.join(config.baseDir, "provider-runtimes", ".background", "requests.json");
  const stored = yield* fs.readFileString(filePath).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed("[]"),
    ),
    Effect.flatMap(decodeRequests),
    Effect.mapError(
      (cause) => new ProviderRuntimeRequestsPersistenceError({ path: filePath, cause }),
    ),
  );
  const requestsRef = yield* SubscriptionRef.make<ReadonlyArray<RuntimeRequest>>(
    yield* Effect.forEach(stored, (request) =>
      Effect.gen(function* () {
        return { ...request, requestId: request.requestId ?? `request-${yield* random.uuidV4()}` };
      }),
    ),
  );
  const lock = yield* Semaphore.make(1);

  const change = (
    next: (requests: ReadonlyArray<RuntimeRequest>) => Effect.Effect<ReadonlyArray<RuntimeRequest>>,
  ) =>
    lock.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(requestsRef);
          const updated = yield* next(current);
          if (updated === current) return;
          yield* encodeRequests(updated).pipe(
            Effect.flatMap((contents) =>
              writeFileStringAtomically({ filePath, contents, mode: 0o600, durable: true }),
            ),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(HostProcess.Platform, platform),
            Effect.mapError(
              (cause) => new ProviderRuntimeRequestsPersistenceError({ path: filePath, cause }),
            ),
          );
          yield* SubscriptionRef.set(requestsRef, updated);
        }),
      ),
    );

  if (stored.some((request) => request.requestId === undefined)) {
    yield* change((requests) => Effect.succeed([...requests]));
  }

  const updateEach = (
    requests: ReadonlyArray<RuntimeRequest>,
    requestId: string,
    next: (request: RuntimeRequest) => RuntimeRequest | undefined,
  ) =>
    requests.flatMap((request) => {
      if (request.requestId !== requestId) return [request];
      const updated = next(request);
      return updated ? [updated] : [];
    });

  const requested = Effect.fn("ProviderRuntimeRequests.requested")(function* (
    input: Parameters<ProviderRuntimeRequests["Service"]["requested"]>[0],
  ) {
    const dueAt = yield* nextTryAt(0);
    yield* change((requests) => {
      const others = requests.filter((request) => !sameRuntime(request, input));
      if (input.action === "remove") return Effect.succeed(others);
      const { requestId, instanceId, driver, action, catalogRevision } = input;
      return Effect.succeed([
        ...others,
        { requestId, instanceId, driver, action, catalogRevision, retries: 0, dueAt },
      ]);
    });
  });

  const settled = Effect.fn("ProviderRuntimeRequests.settled")(function* (
    input: Parameters<ProviderRuntimeRequests["Service"]["settled"]>[0],
  ) {
    yield* change((requests) =>
      Effect.gen(function* () {
        const request = requests.find((candidate) =>
          input.requestId === undefined
            ? candidate.instanceId === input.instanceId && sameRuntime(candidate, input)
            : candidate.requestId === input.requestId,
        );
        if (!request) return requests;
        switch (input.outcome) {
          case "succeeded":
            return requests.filter((request) => !sameRuntime(request, input));
          case "cancelled":
          case "failed":
            return updateEach(requests, request.requestId, () => undefined);
          case "retryable": {
            const dueAt = Math.max(
              yield* nextTryAt(request.retries),
              (yield* Clock.currentTimeMillis) + (input.retryAfterMs ?? 0),
            );
            return updateEach(requests, request.requestId, (current) => ({ ...current, dueAt }));
          }
        }
      }),
    );
  });

  const update = Effect.fn("ProviderRuntimeRequests.update")(function* (
    requestId: string,
    next: (request: RuntimeRequest) => RuntimeRequest | undefined,
  ) {
    yield* change((requests) =>
      Effect.succeed(
        requests.some((request) => request.requestId === requestId)
          ? updateEach(requests, requestId, next)
          : requests,
      ),
    );
  });

  return ProviderRuntimeRequests.of({
    requested,
    settled,
    list: SubscriptionRef.get(requestsRef),
    changes: SubscriptionRef.changes(requestsRef),
    update,
  });
});

export const layer = Layer.effect(ProviderRuntimeRequests, make());
