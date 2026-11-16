import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderManagedRuntimeAction,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../../config.ts";

/** After the user's own try, then after each try Scient makes; the cooldown repeats after that. */
const RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000] as const;
const COOLDOWN_MS = 4 * 60 * 60_000;
const ACP_REGISTRY = ProviderDriverKind.make("acpRegistry");

/** An install, update or repair the user asked for that has not succeeded yet. */
const RuntimeRequest = Schema.Struct({
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
const decodeRequests = Schema.decodeEffect(RequestsJson);
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
const sameRuntime = (
  request: RuntimeRequest,
  change: { readonly instanceId: ProviderInstanceId; readonly driver: ProviderDriverKind },
) =>
  request.driver === change.driver &&
  (change.driver !== ACP_REGISTRY || request.instanceId === change.instanceId);

/**
 * Runtime changes the user asked for, kept across restarts until one succeeds, the user cancels or
 * removes it, or chooses again. The runtime manager records them; recovery tries them again.
 */
export class ProviderRuntimeRequests extends Context.Service<
  ProviderRuntimeRequests,
  {
    /** The user started a change: it replaces any request for the same runtime; Remove only clears. */
    readonly requested: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly driver: ProviderDriverKind;
      readonly action: ProviderManagedRuntimeAction;
      readonly catalogRevision: string;
    }) => Effect.Effect<void>;
    readonly settled: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly driver: ProviderDriverKind;
      readonly outcome: RuntimeChangeOutcome;
    }) => Effect.Effect<void>;
    readonly list: Effect.Effect<ReadonlyArray<RuntimeRequest>>;
    /** Changes the instance's request if there still is one; `undefined` drops it. */
    readonly update: (
      instanceId: ProviderInstanceId,
      change: (request: RuntimeRequest) => RuntimeRequest | undefined,
    ) => Effect.Effect<void>;
  }
>()("t3/scient/providerLifecycle/ProviderRuntimeRequests") {}

export const make = Effect.fn("ProviderRuntimeRequests.make")(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  // Kept outside the runtime folders, which Remove deletes.
  const filePath = path.join(config.baseDir, "provider-runtimes", ".background", "requests.json");
  const requestsRef = yield* Ref.make<ReadonlyArray<RuntimeRequest>>(
    yield* fs.readFileString(filePath).pipe(
      Effect.flatMap(decodeRequests),
      Effect.orElseSucceed((): ReadonlyArray<RuntimeRequest> => []),
    ),
  );
  const lock = yield* Semaphore.make(1);

  const change = (
    next: (requests: ReadonlyArray<RuntimeRequest>) => Effect.Effect<ReadonlyArray<RuntimeRequest>>,
  ) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const updated = yield* next(yield* Ref.get(requestsRef));
        yield* Ref.set(requestsRef, updated);
        yield* encodeRequests(updated).pipe(
          Effect.flatMap((contents) =>
            writeFileStringAtomically({ filePath, contents, mode: 0o600 }),
          ),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(HostProcess.Platform, platform),
          Effect.ignoreCause({ log: true }),
        );
      }),
    );

  const updateEach = (
    requests: ReadonlyArray<RuntimeRequest>,
    instanceId: ProviderInstanceId,
    next: (request: RuntimeRequest) => RuntimeRequest | undefined,
  ) =>
    requests.flatMap((request) => {
      if (request.instanceId !== instanceId) return [request];
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
      const { instanceId, driver, action, catalogRevision } = input;
      return Effect.succeed([
        ...others,
        { instanceId, driver, action, catalogRevision, retries: 0, dueAt },
      ]);
    });
  });

  const settled = Effect.fn("ProviderRuntimeRequests.settled")(function* (
    input: Parameters<ProviderRuntimeRequests["Service"]["settled"]>[0],
  ) {
    yield* change((requests) =>
      Effect.gen(function* () {
        switch (input.outcome) {
          case "succeeded":
            return requests.filter((request) => !sameRuntime(request, input));
          case "cancelled":
          case "failed":
            return updateEach(requests, input.instanceId, () => undefined);
          case "retryable": {
            const request = requests.find((candidate) => candidate.instanceId === input.instanceId);
            if (!request) return requests;
            const dueAt = yield* nextTryAt(request.retries);
            return updateEach(requests, input.instanceId, (current) => ({ ...current, dueAt }));
          }
        }
      }),
    );
  });

  const update = Effect.fn("ProviderRuntimeRequests.update")(function* (
    instanceId: ProviderInstanceId,
    next: (request: RuntimeRequest) => RuntimeRequest | undefined,
  ) {
    yield* change((requests) => Effect.succeed(updateEach(requests, instanceId, next)));
  });

  return ProviderRuntimeRequests.of({ requested, settled, list: Ref.get(requestsRef), update });
});

export const layer = Layer.effect(ProviderRuntimeRequests, make());
