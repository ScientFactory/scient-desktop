import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";

import { ownNativeSessionLifetimes } from "./ScientNativeSessionLifetimes.ts";

const unused = () => Effect.die("Not used by this test.");

it.effect("retires background generation with its instance and awaits native cleanup", () =>
  Effect.gen(function* () {
    const instanceScope = yield* Scope.make();
    const entered = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    const driverKind = ProviderDriverKind.make("muse");
    const instance = ownNativeSessionLifetimes(
      {
        instanceId: ProviderInstanceId.make("retired-generation"),
        driverKind,
        continuationIdentity: { driverKind, continuationKey: "retired-generation:test" },
        displayName: undefined,
        enabled: true,
        snapshot: {} as ProviderInstance["snapshot"],
        orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
        textGeneration: {
          generateCommitMessage: unused,
          generatePrContent: unused,
          generateThreadTitle: unused,
          generateReviewGuide: unused,
          generateBranchName: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(stopped, undefined)),
            ),
        },
      },
      instanceScope,
    );
    const input = { cwd: process.cwd(), message: "Fixture", modelSelection: {} as never };
    const running = yield* instance.textGeneration
      .generateBranchName(input)
      .pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    yield* Scope.close(instanceScope, Exit.void);
    assert.isTrue(Deferred.isDoneUnsafe(stopped));
    assert.isTrue(Exit.isFailure(yield* Fiber.await(running)));
    assert.strictEqual(
      (yield* instance.textGeneration.generateBranchName(input).pipe(Effect.result))._tag,
      "Failure",
    );
  }).pipe(Effect.scoped),
);
